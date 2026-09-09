#!/usr/bin/env bun
// @bun

// src/glamour/backend/cli.ts
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { parseArgs as nodeParseArgs } from "util";

// plugins/spellbook/skills/glamour/shared/imageOptimize.ts
var OPTIMIZE = { maxDim: 1200, quality: 0.85 };

// src/glamour/backend/imageOptimize.server.ts
async function optimizeImageBuffer(input) {
  const data = await new Bun.Image(input).resize(OPTIMIZE.maxDim, OPTIMIZE.maxDim, {
    fit: "inside",
    withoutEnlargement: true
  }).webp({ quality: Math.round(OPTIMIZE.quality * 100) }).bytes();
  return { data: new Uint8Array(data), mime: "image/webp" };
}
async function optimizeImageDataUrl(dataUrl) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!m)
    throw new Error("optimizeImageDataUrl: expected a base64 data-URL");
  const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  const { data } = await optimizeImageBuffer(bytes);
  let bin = "";
  for (const b of data)
    bin += String.fromCharCode(b);
  return `data:image/webp;base64,${btoa(bin)}`;
}

// src/glamour/backend/cli.ts
var SCRIPT_DIR = dirname(Bun.fileURLToPath(import.meta.url));
var SERVER_SCRIPT = join(SCRIPT_DIR, "..", "scripts", "server.ts");
var SKILL_ROOT = join(SCRIPT_DIR, "..");
var DIST_DIR = join(SKILL_ROOT, "dist");
var SURFACE_CWD = join(SCRIPT_DIR, "..", "..", "..", "..", "..", "src", "glamour");
function daemonCwd() {
  if (process.env.SPELLBOOK_SURFACE_MODE === "release")
    return SKILL_ROOT;
  if (process.env.SPELLBOOK_SURFACE_MODE === "dev")
    return SURFACE_CWD;
  return existsSync(join(DIST_DIR, "index.html")) ? SKILL_ROOT : SURFACE_CWD;
}
var SKILL_ROOT_FOR_TEST = SKILL_ROOT;
var EXIT_FOR = {
  usage: 2,
  internal: 1,
  not_found: 5,
  conflict: 6
};
var CURRENT_COMMAND = null;

class CliError extends Error {
  kind;
  hint;
  choices;
  server;
  constructor(kind, message, extra) {
    super(message);
    this.kind = kind;
    this.hint = extra?.hint;
    this.choices = extra?.choices;
    this.server = extra?.server;
  }
}

class UsageError extends CliError {
  constructor(message, extra) {
    super("usage", message, extra);
  }
}
function die(msg, kind = "usage", extra) {
  throw new CliError(kind, msg, extra);
}
function writeEnvelope(e) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: {
      kind: e.kind,
      exit_code: EXIT_FOR[e.kind],
      retryable: false,
      message: e.message,
      ...e.hint !== undefined ? { hint: e.hint } : {},
      ...e.choices !== undefined ? { choices: e.choices } : {},
      ...e.server !== undefined ? { server: e.server } : {}
    },
    meta: { command: CURRENT_COMMAND }
  })}
`);
  return EXIT_FOR[e.kind];
}
function daemonRefused(what, status, data) {
  const kind = status === 400 ? "usage" : status === 404 ? "not_found" : status === 409 ? "conflict" : "internal";
  throw new CliError(kind, `${what} failed (HTTP ${status})`, {
    ...data !== null && data !== undefined ? { server: data } : {}
  });
}
var NO_SESSION_HINT = { hint: "run: cli.ts open (or pass --session <id>)" };
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function printJson(data) {
  process.stdout.write(`${JSON.stringify(data)}
`);
}
function sessionFilePath(session) {
  return session ? join(tmpdir(), `glamour-${session}.json`) : join(tmpdir(), "glamour-latest.json");
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
    die("no running glamour session", "not_found", NO_SESSION_HINT);
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
  colors: { type: "string" },
  content: { type: "string" },
  cost: { type: "string" },
  custom: { type: "string" },
  file: { type: "string" },
  intent: { type: "string" },
  kind: { type: "string" },
  label: { type: "string" },
  model: { type: "string" },
  note: { type: "string" },
  prompt: { type: "string" },
  prompts: { type: "string" },
  restore: { type: "string" },
  round: { type: "string" },
  seed: { type: "string" },
  session: { type: "string" },
  since: { type: "string" },
  src: { type: "string" },
  "start-timeout": { type: "string" },
  status: { type: "string" },
  timeout: { type: "string" },
  title: { type: "string" },
  url: { type: "string" },
  full: { type: "boolean" },
  "no-open": { type: "boolean" },
  unarchive: { type: "boolean" }
};
var RECOGNIZED_FLAGS = Object.keys(CLI_OPTIONS).map((k) => `--${k}`);
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
    throw new UsageError(detail, {
      hint: "for free text containing dashes, put it after a bare --",
      choices: RECOGNIZED_FLAGS
    });
  }
}
function buildSayCmd(pos, flags) {
  const cmd = {
    type: "say",
    text: pos.join(" ")
  };
  if (typeof flags.kind === "string")
    cmd.kind = flags.kind;
  return cmd;
}
function buildSectionCmd(pos, flags) {
  const cmd = { type: "section", key: pos[0] };
  if (typeof flags.status === "string")
    cmd.status = flags.status;
  if (typeof flags.content === "string")
    cmd.content = flags.content;
  if (typeof flags.prompts === "string")
    cmd.prompts = flags.prompts.split("||").map((p) => p.trim());
  if (typeof flags.colors === "string")
    cmd.colors = flags.colors.split("||").map((s) => {
      const i = s.indexOf(":");
      return i >= 0 ? { hex: s.slice(0, i).trim(), name: s.slice(i + 1).trim() } : { hex: s.trim() };
    }).filter((c) => c.hex);
  return cmd;
}
function parseCustom(v) {
  if (typeof v !== "string")
    return;
  const out = {};
  for (const pair of v.split(",")) {
    const eq = pair.indexOf("=");
    if (eq > 0)
      out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}
function buildGenCmd(src, flags) {
  const cmd = {
    type: "gen.add",
    src,
    prompt: typeof flags.prompt === "string" ? flags.prompt : "",
    model: typeof flags.model === "string" ? flags.model : "",
    round: typeof flags.round === "string" ? Number.parseInt(flags.round, 10) : 0
  };
  if (typeof flags.seed === "string")
    cmd.seed = Number.parseInt(flags.seed, 10);
  if (typeof flags.cost === "string")
    cmd.cost = Number.parseFloat(flags.cost);
  if (typeof flags.label === "string")
    cmd.label = flags.label;
  const custom = parseCustom(flags.custom);
  if (custom)
    cmd.custom = custom;
  return cmd;
}
function buildGenCostCmd(pos, flags) {
  return {
    type: "gen.cost",
    id: pos[0],
    cost: typeof flags.cost === "string" ? Number.parseFloat(flags.cost) : Number.NaN
  };
}
function buildGenMetaCmd(pos, flags) {
  const cmd = {
    type: "gen.meta",
    id: pos[0]
  };
  if (typeof flags.prompt === "string")
    cmd.prompt = flags.prompt;
  const custom = parseCustom(flags.custom);
  if (custom)
    cmd.custom = custom;
  return cmd;
}
function buildStyleSaveCmd(pos) {
  return { type: "style.save", label: pos.join(" ") };
}
function buildStyleArchiveCmd(pos, flags) {
  return {
    type: "style.archive",
    id: pos[0],
    archived: !flags.unarchive
  };
}
function buildFocusCmd(pos, flags) {
  const cmd = {
    type: "focus.push",
    ids: pos
  };
  if (typeof flags.note === "string")
    cmd.note = flags.note;
  return cmd;
}
async function resolveGenSrc(flags) {
  if (typeof flags.url === "string") {
    const res = await fetch(flags.url);
    if (!res.ok)
      die(`gen: failed to fetch --url (HTTP ${res.status})`, "internal");
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = "";
    for (const b of bytes)
      bin += String.fromCharCode(b);
    const mime = res.headers.get("content-type") ?? "image/png";
    return optimizeImageDataUrl(`data:${mime};base64,${btoa(bin)}`);
  }
  if (typeof flags.file === "string") {
    const bytes = new Uint8Array(await Bun.file(flags.file).arrayBuffer());
    let bin = "";
    for (const b of bytes)
      bin += String.fromCharCode(b);
    return optimizeImageDataUrl(`data:image/png;base64,${btoa(bin)}`);
  }
  if (typeof flags.src === "string")
    return optimizeImageDataUrl(flags.src);
  die("gen: one of --url, --file, or --src is required");
}
async function postCmd(session, msg) {
  const s = requireSession(session);
  let status;
  let data;
  try {
    ({ status, data } = await api(s.port, "POST", "/cmd", msg));
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
    const message = err instanceof Error ? err.message : String(err);
    if (msg.type === "close" && (code === "ECONNRESET" || message.includes("ECONNRESET"))) {
      printJson({ ok: true, sent: "close" });
      return;
    }
    throw err;
  }
  if (status !== 200)
    daemonRefused("cmd", status, data);
  printJson({ ok: true, sent: msg.type });
}
async function cmdOpen(flags) {
  const daemonArgs = ["run", SERVER_SCRIPT];
  if (flags.title)
    daemonArgs.push("--title", String(flags.title));
  if (flags.intent)
    daemonArgs.push("--intent", String(flags.intent));
  if (flags.timeout)
    daemonArgs.push("--timeout", String(flags.timeout));
  if (flags.restore)
    daemonArgs.push("--restore", String(flags.restore));
  daemonArgs.push("--project", process.cwd());
  const cwd = daemonCwd();
  if (!existsSync(cwd)) {
    die(`glamour cannot start its daemon: the working directory it needs is missing \u2014 ${cwd}`, "internal", {
      hint: "dev mode was resolved (no dist/index.html at the skill root and no SPELLBOOK_SURFACE_MODE=release), " + "so the daemon must run from src/glamour/, which a source-free install does not have. " + "Either the shipped dist/ is missing (reinstall the spell) or you are in a checkout without src/glamour/."
    });
  }
  const child = spawn("bun", daemonArgs, {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
    env: process.env
  });
  child.unref();
  const startTimeoutMs = typeof flags["start-timeout"] === "string" ? Math.max(5000, Number.parseInt(String(flags["start-timeout"]), 10) * 1000) : 45000;
  const info = await new Promise((resolve, reject) => {
    let buf = "";
    const timeout = setTimeout(() => reject(new Error(`daemon start timeout (${startTimeoutMs / 1000}s) \u2014 first bundle build can be slow; retry or pass --start-timeout <seconds>`)), startTimeoutMs);
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf(`
`);
      if (nl >= 0) {
        clearTimeout(timeout);
        resolve(buf.slice(0, nl).trim());
      }
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`daemon exited with code ${code}`));
      }
    });
  }).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    die(`glamour server failed to start: ${msg}`, "internal");
  });
  child.stdout.unref();
  let parsed;
  try {
    parsed = JSON.parse(info);
  } catch {
    die(`unexpected output from daemon: ${info}`, "internal");
  }
  printJson(parsed);
  if (!flags["no-open"]) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    spawn(opener, [parsed.url], { detached: true, stdio: "ignore" }).unref();
  }
}
async function cmdState(session, full = false) {
  const s = requireSession(session);
  const { status, data } = await api(s.port, "GET", `/state${full ? "" : "?lean=1"}`);
  if (status !== 200)
    daemonRefused("state", status, data);
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
    if (!res.ok) {
      await sleep(delay);
      delay = Math.min(delay * 2, 5000);
      continue;
    }
    delay = 250;
    if (!res.body) {
      await sleep(delay);
      continue;
    }
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
            process.stderr.write(`: glamour-keepalive
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
function cmdInfo(session) {
  const s = readSession(session);
  if (!s)
    die("no running glamour session", "not_found", NO_SESSION_HINT);
  printJson(s);
}
function versionInfo() {
  try {
    const raw = readFileSync(join(SKILL_ROOT, "..", "..", ".claude-plugin", "plugin.json"), "utf8");
    const pkg = JSON.parse(raw);
    if (typeof pkg.version === "string")
      return { name: "glamour", version: pkg.version };
  } catch {}
  return { name: "glamour", version: "unknown" };
}
var SESSION = ["session"];
var P = {
  text: [{ name: "text", required: true, variadic: true }],
  id: [{ name: "id", required: true }],
  idText: [
    { name: "id", required: true },
    { name: "text", required: true, variadic: true }
  ],
  ids: [{ name: "id", required: true, variadic: true }],
  none: []
};
var COMMANDS = [
  {
    name: "open",
    flags: ["title", "intent", "no-open", "timeout", "start-timeout", "restore"],
    positionals: P.none,
    describe: "spawn a session (opens the browser); prints {url, port, session_id}",
    run: (_pos, flags) => cmdOpen(flags)
  },
  {
    name: "tail",
    flags: [...SESSION, "since"],
    positionals: P.none,
    describe: "SSE user events \u2192 JSONL (wrap with Monitor; waits for a session, never exits 5)",
    run: (_pos, flags, session) => cmdTail(session, typeof flags.since === "string" ? Number.parseInt(flags.since, 10) : -1)
  },
  {
    name: "state",
    flags: [...SESSION, "full"],
    positionals: P.none,
    describe: "lean state snapshot (--full for raw incl. base64)",
    run: (_pos, flags, session) => cmdState(session, flags.full === true)
  },
  {
    name: "intent",
    flags: SESSION,
    positionals: P.text,
    describe: "update the session intent",
    run: (pos, _flags, session) => postCmd(session, { type: "intent", text: pos.join(" ") })
  },
  {
    name: "annotate",
    flags: SESSION,
    positionals: P.idText,
    describe: "write agent annotation onto a library item",
    run: (pos, _flags, session) => {
      const [id, ...words] = pos;
      return postCmd(session, { type: "item.annotate", id, agent: words.join(" ") });
    }
  },
  {
    name: "say",
    flags: [...SESSION, "kind"],
    positionals: P.text,
    describe: "post agent dialogue into the conversation (--kind info|working|result|error)",
    run: (pos, flags, session) => postCmd(session, buildSayCmd(pos, flags))
  },
  {
    name: "section",
    flags: [...SESSION, "status", "content", "prompts", "colors"],
    positionals: [{ name: "key", required: true }],
    describe: 'shape a style-guide section (--prompts a||b; --colors "#hex:Name||#hex:Name")',
    run: (pos, flags, session) => postCmd(session, buildSectionCmd(pos, flags))
  },
  {
    name: "status",
    flags: SESSION,
    positionals: [
      { name: "on|off", required: true },
      { name: "text", required: false, variadic: true }
    ],
    describe: "show/hide the working spinner",
    run: (pos, _flags, session) => {
      const on = pos[0] === "on";
      const text = pos.slice(1).join(" ") || undefined;
      return postCmd(session, { type: "status", busy: on, ...text ? { text } : {} });
    }
  },
  {
    name: "gen",
    flags: [
      ...SESSION,
      "url",
      "file",
      "src",
      "prompt",
      "model",
      "round",
      "seed",
      "cost",
      "label",
      "custom"
    ],
    positionals: P.none,
    describe: "post a generated image (one of --url|--file|--src, and --prompt --model --round required)",
    run: async (_pos, flags, session) => {
      if (!flags.prompt || !flags.model || !flags.round)
        die(`usage: ${usageOf(findCommand("gen"))} \u2014 --prompt, --model and --round are required`);
      const src = await resolveGenSrc(flags);
      await postCmd(session, buildGenCmd(src, flags));
    }
  },
  {
    name: "gen-cost",
    flags: [...SESSION, "cost"],
    positionals: P.id,
    describe: "backfill a generated image's cost (--cost <n> required)",
    run: (pos, flags, session) => {
      const cost = typeof flags.cost === "string" ? Number.parseFloat(flags.cost) : Number.NaN;
      if (!Number.isFinite(cost))
        die(`usage: ${usageOf(findCommand("gen-cost"))} \u2014 --cost must be a number`);
      return postCmd(session, buildGenCostCmd(pos, flags));
    }
  },
  {
    name: "gen-meta",
    flags: [...SESSION, "prompt", "custom"],
    positionals: P.id,
    describe: "backfill the real prompt / refs onto a gen (--prompt and/or --custom)",
    run: (pos, flags, session) => {
      if (flags.prompt === undefined && flags.custom === undefined)
        die(`usage: ${usageOf(findCommand("gen-meta"))} \u2014 give --prompt or --custom`);
      return postCmd(session, buildGenMetaCmd(pos, flags));
    }
  },
  {
    name: "focus",
    flags: [...SESSION, "note"],
    positionals: P.ids,
    describe: "scope the focus lens to these items (+ --note to ask)",
    run: (pos, flags, session) => postCmd(session, buildFocusCmd(pos, flags))
  },
  {
    name: "style-save",
    flags: SESSION,
    positionals: [{ name: "label", required: true, variadic: true }],
    describe: "codify the current style \u2192 project tray",
    run: (pos, _flags, session) => postCmd(session, buildStyleSaveCmd(pos))
  },
  {
    name: "style-archive",
    flags: [...SESSION, "unarchive"],
    positionals: P.id,
    describe: "archive (or --unarchive) a saved style",
    run: (pos, flags, session) => postCmd(session, buildStyleArchiveCmd(pos, flags))
  },
  {
    name: "tray",
    flags: SESSION,
    positionals: P.none,
    describe: "list the project's saved styles",
    run: async (_pos, _flags, session) => {
      const s = requireSession(session);
      const { status, data } = await api(s.port, "GET", "/state?lean=1");
      if (status !== 200)
        daemonRefused("tray", status, data);
      printJson(data?.state?.tray ?? []);
    }
  },
  {
    name: "close",
    flags: SESSION,
    positionals: P.none,
    describe: "shut down the session",
    run: (_pos, _flags, session) => postCmd(session, { type: "close" })
  },
  {
    name: "info",
    flags: SESSION,
    positionals: P.none,
    describe: "print the resolved discovery JSON",
    run: (_pos, _flags, session) => cmdInfo(session)
  },
  {
    name: "schema",
    flags: [],
    positionals: P.none,
    describe: "emit this CLI's acc declaration (walked from the command table)",
    run: () => {
      process.stdout.write(`${JSON.stringify(buildDeclaration(), null, 2)}
`);
    }
  },
  {
    name: "help",
    flags: [],
    positionals: P.none,
    describe: "show this message",
    run: () => {
      process.stdout.write(`${renderHelp()}
`);
    }
  }
];
var ROOT_INTERCEPTORS = [
  { name: "--help", runs: "help" },
  { name: "-h", runs: "help" },
  { name: "--version", runs: "version" },
  { name: "-V", runs: "version" }
];
var findCommand = (token) => COMMANDS.find((c) => c.name === token);
function verbToken(argv) {
  for (let i = 0;i < argv.length; i++) {
    const a = argv[i];
    if (a === "--")
      return argv[i + 1] ?? null;
    if (a.startsWith("--")) {
      if (a.includes("="))
        continue;
      const key = a.slice(2);
      if (key in CLI_OPTIONS && CLI_OPTIONS[key].type === "string")
        i++;
      continue;
    }
    if (a.startsWith("-"))
      continue;
    return a;
  }
  return null;
}
var VERBS = COMMANDS.map((c) => c.name);
var VERB_SPEC = Object.fromEntries(COMMANDS.map((c) => [c.name, c.flags]));
var flagsFor = (verb) => [...findCommand(verb)?.flags ?? []].map((k) => `--${k}`).sort();
var renderFlag = (k) => CLI_OPTIONS[k].type === "boolean" ? `[--${k}]` : `[--${k} ..]`;
var renderPositional = (p) => {
  const inner = p.variadic ? `${p.name}...` : p.name;
  return p.required ? `<${inner}>` : `[${inner}]`;
};
function usageOf(spec) {
  const parts = [
    spec.name,
    ...spec.positionals.map(renderPositional),
    ...spec.flags.filter((k) => k !== "session").map(renderFlag)
  ];
  return parts.join(" ");
}
function renderHelp() {
  const rows = COMMANDS.map((c) => [usageOf(c), c.describe]);
  const width = Math.min(Math.max(...rows.map(([u]) => u.length)), 44);
  const body = rows.map(([usage, describe]) => usage.length <= width ? `  ${usage.padEnd(width)}  ${describe}` : `  ${usage}
  ${"".padEnd(width)}  ${describe}`).join(`
`);
  return `glamour \u2014 a grounded visual conversation surface.

${body}
  ${ROOT_INTERCEPTORS.map((i) => i.name).join(" | ")}  root tokens: help, or {name, version} as JSON

  Add --session <id> to any verb that talks to a session (default: most recent).
  Each verb accepts only the flags on its row; a recognized flag on the wrong
  verb is refused, and the rejection lists the verb's own flags.

  Output: every verb prints JSON on stdout by default, one document per answer \u2014
  except tail, a stream that prints one JSON line per event, and help, which is
  prose. Failures are one JSON envelope on stderr and exit non-zero (2 = usage,
  1 = internal, 5 = not found, 6 = conflict) \u2014 except tail, which waits for a
  session instead of failing and writes its retry/keepalive notes to stderr as
  '#'-prefixed prose.`;
}
function buildDeclaration() {
  const arg = (k) => ({ name: `--${k}`, type: CLI_OPTIONS[k].type, status: "valid" });
  const commands = [
    {
      path: [],
      args: ROOT_INTERCEPTORS.map((i) => ({
        name: i.name,
        type: "boolean",
        status: "valid"
      })),
      positionals: [{ name: "verb", required: true }]
    },
    ...COMMANDS.map((c) => ({
      path: [c.name],
      args: [...c.flags].map(arg),
      positionals: c.positionals
    }))
  ];
  return {
    formatVersion: "0",
    provenance: "emitted",
    selfDescription: { args: ["schema"] },
    commands
  };
}
async function main(argv) {
  try {
    return await dispatch(argv);
  } catch (e) {
    if (e instanceof CliError)
      return writeEnvelope(e);
    const code = e && typeof e === "object" && "code" in e ? String(e.code) : "";
    const msg = e instanceof Error ? e.message : String(e);
    if (code === "ENOENT")
      return writeEnvelope(new UsageError(msg));
    return writeEnvelope(new CliError("internal", msg));
  }
}
async function dispatch(argv) {
  const interceptor = ROOT_INTERCEPTORS.find((i) => i.name === argv[0]);
  if (interceptor !== undefined || argv[0] === "version") {
    const runs = interceptor?.runs ?? "version";
    if (runs === "help")
      process.stdout.write(`${renderHelp()}
`);
    else
      process.stdout.write(`${JSON.stringify(versionInfo())}
`);
    return 0;
  }
  CURRENT_COMMAND = verbToken(argv);
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError))
      throw e;
    const spec2 = CURRENT_COMMAND === null ? undefined : findCommand(CURRENT_COMMAND);
    if (spec2 !== undefined) {
      throw new UsageError(e.message, { hint: e.hint, choices: flagsFor(spec2.name) });
    }
    throw new UsageError(e.message, {
      hint: `no verb given \u2014 verbs: ${VERBS.join(" ")} (run: cli.ts help)`,
      choices: ROOT_INTERCEPTORS.map((i) => i.name)
    });
  }
  const [verb, ...pos] = parsed.pos;
  const flags = parsed.flags;
  CURRENT_COMMAND = verb ?? null;
  if (verb === undefined) {
    throw new UsageError("no verb given", { hint: "run: cli.ts help", choices: [...VERBS] });
  }
  const spec = findCommand(verb);
  if (spec === undefined) {
    throw new UsageError(`unknown verb "${verb}"`, {
      hint: "run: cli.ts help",
      choices: [...VERBS]
    });
  }
  const allowed = new Set(spec.flags);
  const stray = Object.keys(flags).find((k) => !allowed.has(k));
  if (stray !== undefined) {
    const accepted = flagsFor(spec.name);
    throw new UsageError(`--${stray} is not accepted by \`${spec.name}\` (it is a recognized glamour flag, just not this verb's)`, accepted.length > 0 ? { choices: accepted } : { hint: `${spec.name} takes no flags` });
  }
  const required = spec.positionals.filter((p) => p.required).length;
  const variadic = spec.positionals.some((p) => p.variadic);
  if (pos.length < required || !variadic && pos.length > spec.positionals.length) {
    throw new UsageError(`usage: ${usageOf(spec)}`, { hint: spec.describe });
  }
  const session = typeof flags.session === "string" ? flags.session : undefined;
  await spec.run(pos, flags, session);
  return 0;
}
async function run() {
  return await main(process.argv.slice(2));
}
export {
  verbToken,
  usageOf,
  run,
  renderHelp,
  parseCustom,
  parseArgs,
  main,
  flagsFor,
  daemonCwd,
  buildStyleSaveCmd,
  buildStyleArchiveCmd,
  buildSectionCmd,
  buildSayCmd,
  buildGenMetaCmd,
  buildGenCostCmd,
  buildGenCmd,
  buildFocusCmd,
  buildDeclaration,
  VERB_SPEC,
  VERBS,
  UsageError,
  SKILL_ROOT_FOR_TEST,
  RECOGNIZED_FLAGS,
  CliError
};

//# debugId=B95B4DB4D58613CE64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL2dsYW1vdXIvYmFja2VuZC9jbGkudHMiLCAiLi4vc2hhcmVkL2ltYWdlT3B0aW1pemUudHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2dsYW1vdXIvYmFja2VuZC9pbWFnZU9wdGltaXplLnNlcnZlci50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsKICAgICIjIS91c3IvYmluL2VudiBidW5cblxuLy8gZ2xhbW91ciBDTEkg4oCUIHRoaW4gd3JhcHBlciBhcm91bmQgdGhlIHBlci1zZXNzaW9uIGRhZW1vbidzIEhUVFAgc3VyZmFjZVxuLy8gKHNlcnZlci50cykuIFRoZSBhZ2VudCBkcml2ZXMgYSBnbGFtb3VyIHNlc3Npb24gdGhyb3VnaCB0aGVzZSB2ZXJicztcbi8vIGB0YWlsYCBzdHJlYW1zIHVzZXIgZXZlbnRzIGFzIEpTT05MIGZvciBNb25pdG9yIHRvIHdyYXAuXG4vL1xuLy8gTGlmZWN5Y2xlOlxuLy8gICBidW4gY2xpLnRzIG9wZW4gWy0tdGl0bGUgLi5dIFstLWludGVudCAuLl0gWy0tbm8tb3Blbl0gICAjIHNwYXduIGEgc2Vzc2lvblxuLy8gICBidW4gY2xpLnRzIHRhaWwgWy0tc2luY2UgTl0gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIyBTU0UgZXZlbnRzIOKGkiBKU09OTCAoTW9uaXRvciB0aGlzKVxuLy8gICBidW4gY2xpLnRzIHN0YXRlIFstLWZ1bGxdICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIyBsZWFuIHN0YXRlIHNuYXBzaG90XG4vL1xuLy8gQWdlbnQgY29tbWFuZHMgKFBPU1QgL2NtZCk6XG4vLyAgIGJ1biBjbGkudHMgaW50ZW50IDx0ZXh0Li4uPlxuLy8gICBidW4gY2xpLnRzIGFubm90YXRlIDxpZD4gPHRleHQuLi4+XG4vLyAgIGJ1biBjbGkudHMgc2F5IDx0ZXh0Li4uPlxuLy8gICBidW4gY2xpLnRzIHN0YXR1cyBvbiBbdGV4dC4uLl0gfCBzdGF0dXMgb2ZmXG4vLyAgIGJ1biBjbGkudHMgY2xvc2Vcbi8vICAgYnVuIGNsaS50cyBpbmZvIHwgaGVscCB8IC0tdmVyc2lvblxuLy9cbi8vIEFsbCB2ZXJicyB0YXJnZXQgdGhlIG1vc3QgcmVjZW50IHNlc3Npb24gYnkgZGVmYXVsdDsgcGFzcyAtLXNlc3Npb24gPGlkPlxuLy8gdG8gdGFyZ2V0IGEgc3BlY2lmaWMgb25lLlxuLy9cbi8vIEVSUk9SIENPTlRSQUNUIChhY2MgTDAg4oCUIHRoZSBob3VzZSB0YXhvbm9teSBtYWdwaWUgc2V0IGFuZCBtaW5kLW1hcHBlclxuLy8gYWRvcHRlZCk6IGV2ZXJ5IGZhaWx1cmUgaXMgT05FIEpTT04gZW52ZWxvcGUgb24gc3RkZXJyIHdpdGggc3Rkb3V0IGVtcHR5IOKAlFxuLy8gICB7b2s6ZmFsc2UsIGVycm9yOntraW5kLCBleGl0X2NvZGUsIHJldHJ5YWJsZSwgbWVzc2FnZSwgaGludD8sIGNob2ljZXM/LFxuLy8gICAgc2VydmVyP30sIG1ldGE6e2NvbW1hbmR9fVxuLy8gICB1c2FnZSDihpIgZXhpdCAyIMK3IGludGVybmFsIOKGkiAxIMK3IG5vdF9mb3VuZCDihpIgNSDCtyBjb25mbGljdCDihpIgNlxuLy8gQSBkYWVtb24gcmVmdXNhbCBtYXBzIG9mZiBpdHMgSFRUUCBzdGF0dXMgKDQwMCB1c2FnZSwgNDA0IG5vdF9mb3VuZCxcbi8vIDQwOSBjb25mbGljdCwgZWxzZSBpbnRlcm5hbCkgYW5kIGNhcnJpZXMgdGhlIGRhZW1vbidzIG93biBib2R5IFZFUkJBVElNXG4vLyB1bmRlciBlcnJvci5zZXJ2ZXIuIEJyYW5jaCBvbiBga2luZGAsIG5ldmVyIG9uIGBtZXNzYWdlYCBwcm9zZS5cblxuaW1wb3J0IHsgc3Bhd24gfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQgeyBleGlzdHNTeW5jLCByZWFkRmlsZVN5bmMgfSBmcm9tIFwibm9kZTpmc1wiO1xuaW1wb3J0IHsgdG1wZGlyIH0gZnJvbSBcIm5vZGU6b3NcIjtcbmltcG9ydCB7IGRpcm5hbWUsIGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBwYXJzZUFyZ3MgYXMgbm9kZVBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcbmltcG9ydCB7IG9wdGltaXplSW1hZ2VEYXRhVXJsIH0gZnJvbSBcIi4vaW1hZ2VPcHRpbWl6ZS5zZXJ2ZXJcIjtcblxuLy8g4puUIEVWRVJZIFBBVEggSEVSRSBJUyBSRVNPTFZFRCBGUk9NIFRIRSBFTUlUVEVEIExPQ0FUSU9OLCBgZGlzdC9gLCBOT1QgRlJPTVxuLy8gVEhJUyBTT1VSQ0UgRklMRS4gVGhpcyBtb2R1bGUgaXMgYnVuZGxlZCB0b1xuLy8gYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9nbGFtb3VyL2Rpc3QvY2xpLmpzYCBhbmQgdGhlIGxhdW5jaGVyIGF0XG4vLyBgLi4vc2NyaXB0cy9jbGkudHNgIGltcG9ydHMgaXQsIHNvIGBpbXBvcnQubWV0YS51cmxgIG5hbWVzIHRoZSBCVU5ETEUuIGBkaXN0L2Bcbi8vIGhhcHBlbnMgdG8gc2l0IGF0IHRoZSBzYW1lIGRlcHRoIGFzIHRoZSBgc2NyaXB0cy9gIHRoaXMgZmlsZSB1c2VkIHRvIGxpdmUgaW4sXG4vLyBzbyBgU0tJTExfUk9PVGAsIGBESVNUX0RJUmAgYW5kIGBTVVJGQUNFX0NXRGAgYXJlIHVuY2hhbmdlZCDigJQgYnV0IHRoYXQgaXMgYVxuLy8gQ09JTkNJREVOQ0UgT0YgREVQVEgsIG5vdCBhIHByb3BlcnR5LCB3aGljaCBpcyB3aHkgdGhlIHdhcmQgYXNzZXJ0cyB0aGVtXG4vLyByYXRoZXIgdGhhbiB0cnVzdGluZyB0aGlzIHBhcmFncmFwaC5cbmNvbnN0IFNDUklQVF9ESVIgPSBkaXJuYW1lKEJ1bi5maWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuLy8g4puUIFVQIEFORCBCQUNLIERPV04sIEFORCBUSElTIExJTkUgSVMgVEhFIE9ORSBUSEUgUkVMT0NBVElPTiBCUk9LRS4gSXQgcmVhZFxuLy8gYGpvaW4oU0NSSVBUX0RJUiwgXCJzZXJ2ZXIudHNcIilgIOKAlCB0aGUgZGFlbW9uIGJlc2lkZSB0aGUgQ0xJIOKAlCB3aGljaCB3YXMgdHJ1ZVxuLy8gZm9yIGV4YWN0bHkgYXMgbG9uZyBhcyBib3RoIGxpdmVkIGluIGBzY3JpcHRzL2AuIEZyb20gYGRpc3QvYCBpdCByZXNvbHZlcyB0b1xuLy8gYGRpc3Qvc2VydmVyLnRzYCwgYSBmaWxlIHRoYXQgZG9lcyBub3QgZXhpc3QgYW5kIG11c3Qgbm90OiBgZGlzdC9gIGhvbGRzIHRoZVxuLy8gQlVORExFIChgc2VydmVyLmpzYCksIGFuZCB0aGUgc3Bhd25hYmxlIGVudHJ5IGlzIHRoZSBsYXVuY2hlciBvbmUgZGlyZWN0b3J5XG4vLyBvdmVyLiBUaGUgc3ltcHRvbSBvZiBnZXR0aW5nIGl0IHdyb25nIGlzIG5vdCBhIGNyYXNoIOKAlCBgb3BlbmAgd2FpdHMgb3V0IGl0c1xuLy8gNDUtc2Vjb25kIGhhbmRzaGFrZSBhbmQgcmVwb3J0cyBhIHN0YXJ0IHRpbWVvdXQsIHdoaWNoIHJlYWRzIGxpa2UgYSBzbG93IGZpcnN0XG4vLyBidW5kbGUgYnVpbGQuIGBncmltb2lyZS9zcGF3bi1wYXRoLXdhcmQudGVzdC50c2AgaXMgd2hhdCBuYW1lcyBpdCBpbiAwLjRzXG4vLyBpbnN0ZWFkLCBhbmQgaXQgbmFtZWQgdGhpcyBvbmUuIEFzdHJvbGFiZSBhbmQgbWFncGllIHdlcmUgYWxyZWFkeSB3cml0dGVuIHRoaXNcbi8vIHdheSBhbmQgcGFpZCBub3RoaW5nIGZvciB0aGUgbW92ZTsgZ2xhbW91ciBpcyB3aGVyZSB0aGUgc2hhcGUgZWFybmVkIGl0c2VsZi5cbmNvbnN0IFNFUlZFUl9TQ1JJUFQgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCJzY3JpcHRzXCIsIFwic2VydmVyLnRzXCIpO1xuY29uc3QgU0tJTExfUk9PVCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiKTtcbmNvbnN0IERJU1RfRElSID0gam9pbihTS0lMTF9ST09ULCBcImRpc3RcIik7XG4vLyBCdW4gcmVhZHMgYnVuZmlnLnRvbWwgKHRoZSBUYWlsd2luZCBwbHVnaW4pIGZyb20gY3dkIE9OTFksIHNvIHRoZSBkYWVtb24ncyBjd2Rcbi8vIE1VU1QgYmUgc3JjL2dsYW1vdXIvIGluIGRldiAoc2VhbXMgQ29udHJhY3QgNSkuIExhdW5jaGVkIGVsc2V3aGVyZSB0aGUgZGV2XG4vLyBidW5kbGVyIGNhbm5vdCBjb21waWxlIHRoZSBzdHlsZXNoZWV0IOKAlCBtZWFzdXJlZCBvbiBnbGFtb3VyIHRoZSBQQUdFIDUwMHMgd2l0aFxuLy8gbm8gc3R5bGVzaGVldCBsaW5rIChub3QgXCJ1bnN0eWxlZCBhdCAyMDBcIjsgdGhhdCBzZW50ZW5jZSB3YXMgbmV2ZXIgcnVuKS4gQXNzZXJ0XG4vLyB0aGUgaW52YXJpYW50OiB0aGUgdXRpbGl0eSBuZXZlciByZWFjaGVzIHRoZSBicm93c2VyIHdoZW4gdGhlIGN3ZCBpcyB3cm9uZy5cbi8vIHJlbGVhc2U6IGRpc3QvIGlzIHByZS1idWlsdCBhbmQgc3RhdGljIOKAlCBubyBidW5maWcgcmVhZCwgc28gc3JjL2dsYW1vdXIvIG5lZWRcbi8vIG5vdCBleGlzdCBhdCBhbGwgKGEgc291cmNlLWZyZWUgbWFya2V0cGxhY2UgY2xvbmUgaGFzIG5vIHRvcC1sZXZlbCBzcmMvKSwgYW5kXG4vLyBwaW5uaW5nIGN3ZCB0aGVyZSBhbnl3YXkgd291bGQgYnJlYWsgdGhlIHNwYXduLiBFeHBvcnRlZCBmb3IgdGhlIHRlc3QuXG5jb25zdCBTVVJGQUNFX0NXRCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwic3JjXCIsIFwiZ2xhbW91clwiKTtcblxuZXhwb3J0IGZ1bmN0aW9uIGRhZW1vbkN3ZCgpOiBzdHJpbmcge1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJyZWxlYXNlXCIpIHJldHVybiBTS0lMTF9ST09UO1xuICBpZiAocHJvY2Vzcy5lbnYuU1BFTExCT09LX1NVUkZBQ0VfTU9ERSA9PT0gXCJkZXZcIikgcmV0dXJuIFNVUkZBQ0VfQ1dEO1xuICByZXR1cm4gZXhpc3RzU3luYyhqb2luKERJU1RfRElSLCBcImluZGV4Lmh0bWxcIikpID8gU0tJTExfUk9PVCA6IFNVUkZBQ0VfQ1dEO1xufVxuZXhwb3J0IGNvbnN0IFNLSUxMX1JPT1RfRk9SX1RFU1QgPSBTS0lMTF9ST09UO1xuXG50eXBlIFNlc3Npb24gPSB7XG4gIHVybDogc3RyaW5nO1xuICBwb3J0OiBudW1iZXI7XG4gIHNlc3Npb25faWQ6IHN0cmluZztcbiAgdGl0bGU6IHN0cmluZztcbiAgZmlsZXNfZGlyPzogc3RyaW5nO1xufTtcblxuLy8g4pSA4pSAIGVycm9yIGVudmVsb3BlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy9cbi8vIFRIUk9XIGFuZCBsZXQgbWFpbigpIGNhdGNoIGFuZCBSRVRVUk4gdGhlIGNvZGUg4oCUIG5ldmVyIHByb2Nlc3MuZXhpdCBpbnNpZGUgYVxuLy8gaGVscGVyLiBUaGlzIENMSSBzaGlwcyBsYXJnZSBzdGRvdXQgcGF5bG9hZHMgKGBzdGF0ZSAtLWZ1bGxgKSwgYW5kIEJ1bidzXG4vLyBzdGRvdXQgaXMgYXN5bmNocm9ub3VzIG9uIGEgcGlwZSwgc28gYW4gZXhwbGljaXQgZXhpdCB0cnVuY2F0ZXMgd2hhdGV2ZXIgaGFzXG4vLyBub3QgZHJhaW5lZCAobWVhc3VyZWQgYXQgNjUsNTM2IGJ5dGVzOyBzZWUgdGhlIGRyYWluIGlkaW9tIGF0IHRoZSBib3R0b20pLlxudHlwZSBFcnJLaW5kID0gXCJ1c2FnZVwiIHwgXCJpbnRlcm5hbFwiIHwgXCJub3RfZm91bmRcIiB8IFwiY29uZmxpY3RcIjtcblxuY29uc3QgRVhJVF9GT1I6IFJlY29yZDxFcnJLaW5kLCBudW1iZXI+ID0ge1xuICB1c2FnZTogMiwgLy8gdGhlIGNhbGxlciBjYW4gZml4IHRoaXMgYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmRcbiAgaW50ZXJuYWw6IDEsIC8vIGdsYW1vdXIgKG9yIGl0cyBkYWVtb24gdHJhbnNwb3J0KSBicm9rZTsgdGhlIGludm9jYXRpb24gbWF5IGhhdmUgYmVlbiBmaW5lXG4gIG5vdF9mb3VuZDogNSwgLy8gdGhlIG5hbWVkIHRoaW5nIGRvZXMgbm90IGV4aXN0IChubyBzZXNzaW9uLCBubyBpdGVtKVxuICBjb25mbGljdDogNiwgLy8gYSBwcmVjb25kaXRpb24gZmFpbGVkXG59O1xuXG4vLyBUaGUgdmVyYiB1bmRlciBleGVjdXRpb24sIHNvIHRoZSBlbnZlbG9wZSBjYW4gbmFtZSBpdC4gU2V0IG9uY2UgYnkgZGlzcGF0Y2guXG5sZXQgQ1VSUkVOVF9DT01NQU5EOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuZXhwb3J0IGNsYXNzIENsaUVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBraW5kOiBFcnJLaW5kO1xuICBoaW50Pzogc3RyaW5nO1xuICBjaG9pY2VzPzogc3RyaW5nW107XG4gIHNlcnZlcj86IHVua25vd247XG4gIGNvbnN0cnVjdG9yKFxuICAgIGtpbmQ6IEVycktpbmQsXG4gICAgbWVzc2FnZTogc3RyaW5nLFxuICAgIGV4dHJhPzogeyBoaW50Pzogc3RyaW5nOyBjaG9pY2VzPzogc3RyaW5nW107IHNlcnZlcj86IHVua25vd24gfSxcbiAgKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gICAgdGhpcy5raW5kID0ga2luZDtcbiAgICB0aGlzLmhpbnQgPSBleHRyYT8uaGludDtcbiAgICB0aGlzLmNob2ljZXMgPSBleHRyYT8uY2hvaWNlcztcbiAgICB0aGlzLnNlcnZlciA9IGV4dHJhPy5zZXJ2ZXI7XG4gIH1cbn1cblxuLy8gYFVzYWdlRXJyb3JgIGlzIHRoZSBuYW1lIHRoZSB0ZXN0cyBhbmQgdGhlIG9sZGVyIGNhbGwgc2l0ZXMga25vdzsgYSB1c2FnZVxuLy8gZmFpbHVyZSBpcyBhIENsaUVycm9yIG9mIGtpbmQgXCJ1c2FnZVwiLlxuZXhwb3J0IGNsYXNzIFVzYWdlRXJyb3IgZXh0ZW5kcyBDbGlFcnJvciB7XG4gIGNvbnN0cnVjdG9yKG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiB7IGhpbnQ/OiBzdHJpbmc7IGNob2ljZXM/OiBzdHJpbmdbXSB9KSB7XG4gICAgc3VwZXIoXCJ1c2FnZVwiLCBtZXNzYWdlLCBleHRyYSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gZGllKG1zZzogc3RyaW5nLCBraW5kOiBFcnJLaW5kID0gXCJ1c2FnZVwiLCBleHRyYT86IHsgaGludD86IHN0cmluZyB9KTogbmV2ZXIge1xuICB0aHJvdyBuZXcgQ2xpRXJyb3Ioa2luZCwgbXNnLCBleHRyYSk7XG59XG5cbmZ1bmN0aW9uIHdyaXRlRW52ZWxvcGUoZTogQ2xpRXJyb3IpOiBudW1iZXIge1xuICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICBgJHtKU09OLnN0cmluZ2lmeSh7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjoge1xuICAgICAgICBraW5kOiBlLmtpbmQsXG4gICAgICAgIGV4aXRfY29kZTogRVhJVF9GT1JbZS5raW5kXSxcbiAgICAgICAgLy8gTm90aGluZyBnbGFtb3VyIHJhaXNlcyBpcyB3b3J0aCByZXRyeWluZyB1bmNoYW5nZWQuXG4gICAgICAgIHJldHJ5YWJsZTogZmFsc2UsXG4gICAgICAgIG1lc3NhZ2U6IGUubWVzc2FnZSxcbiAgICAgICAgLi4uKGUuaGludCAhPT0gdW5kZWZpbmVkID8geyBoaW50OiBlLmhpbnQgfSA6IHt9KSxcbiAgICAgICAgLi4uKGUuY2hvaWNlcyAhPT0gdW5kZWZpbmVkID8geyBjaG9pY2VzOiBlLmNob2ljZXMgfSA6IHt9KSxcbiAgICAgICAgLi4uKGUuc2VydmVyICE9PSB1bmRlZmluZWQgPyB7IHNlcnZlcjogZS5zZXJ2ZXIgfSA6IHt9KSxcbiAgICAgIH0sXG4gICAgICBtZXRhOiB7IGNvbW1hbmQ6IENVUlJFTlRfQ09NTUFORCB9LFxuICAgIH0pfVxcbmAsXG4gICk7XG4gIHJldHVybiBFWElUX0ZPUltlLmtpbmRdO1xufVxuXG4vLyBBIGRhZW1vbiByZWZ1c2FsOiB0aGUga2luZCBtYXBzIG9mZiB0aGUgSFRUUCBzdGF0dXMsIHRoZSBkYWVtb24ncyBvd24gYm9keVxuLy8gcmlkZXMgdmVyYmF0aW0gdW5kZXIgZXJyb3Iuc2VydmVyIHNvIGEgY2FsbGVyIGNhbiBicmFuY2ggb24gaXQuXG5mdW5jdGlvbiBkYWVtb25SZWZ1c2VkKHdoYXQ6IHN0cmluZywgc3RhdHVzOiBudW1iZXIsIGRhdGE6IHVua25vd24pOiBuZXZlciB7XG4gIGNvbnN0IGtpbmQ6IEVycktpbmQgPVxuICAgIHN0YXR1cyA9PT0gNDAwXG4gICAgICA/IFwidXNhZ2VcIlxuICAgICAgOiBzdGF0dXMgPT09IDQwNFxuICAgICAgICA/IFwibm90X2ZvdW5kXCJcbiAgICAgICAgOiBzdGF0dXMgPT09IDQwOVxuICAgICAgICAgID8gXCJjb25mbGljdFwiXG4gICAgICAgICAgOiBcImludGVybmFsXCI7XG4gIHRocm93IG5ldyBDbGlFcnJvcihraW5kLCBgJHt3aGF0fSBmYWlsZWQgKEhUVFAgJHtzdGF0dXN9KWAsIHtcbiAgICAuLi4oZGF0YSAhPT0gbnVsbCAmJiBkYXRhICE9PSB1bmRlZmluZWQgPyB7IHNlcnZlcjogZGF0YSB9IDoge30pLFxuICB9KTtcbn1cblxuY29uc3QgTk9fU0VTU0lPTl9ISU5UID0geyBoaW50OiBcInJ1bjogY2xpLnRzIG9wZW4gKG9yIHBhc3MgLS1zZXNzaW9uIDxpZD4pXCIgfTtcblxuZnVuY3Rpb24gc2xlZXAobXM6IG51bWJlcik6IFByb21pc2U8dm9pZD4ge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgbXMpKTtcbn1cblxuZnVuY3Rpb24gcHJpbnRKc29uKGRhdGE6IHVua25vd24pIHtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkoZGF0YSl9XFxuYCk7XG59XG5cbmZ1bmN0aW9uIHNlc3Npb25GaWxlUGF0aChzZXNzaW9uPzogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHNlc3Npb25cbiAgICA/IGpvaW4odG1wZGlyKCksIGBnbGFtb3VyLSR7c2Vzc2lvbn0uanNvbmApXG4gICAgOiBqb2luKHRtcGRpcigpLCBcImdsYW1vdXItbGF0ZXN0Lmpzb25cIik7XG59XG5cbi8qKiDim5QgTlVMTCBNRUFOUyBcIk5PIFNFU1NJT05cIiwgQU5EIE5PVEhJTkcgRUxTRS5cbiAqXG4gKiAgVGhpcyB1c2VkIHRvIGBjYXRjaCB7IHJldHVybiBudWxsIH1gIG92ZXIgdGhlIHdob2xlIHJlYWQsIHNvIEVWRVJZIGZhaWx1cmUg4oCUXG4gKiAgYSBjb3JydXB0IHBvaW50ZXIsIEVBQ0NFUywgYW5kIGFueSB0cmFuc2llbnQgdGhlIE9TIHJhaXNlcyB1bmRlciBsb2FkIOKAlFxuICogIGFycml2ZWQgYXQgdGhlIGNhbGxlcnMgd2VhcmluZyBhYnNlbmNlJ3MgY2xvdGhlcy4gVGhyZWUgb2YgdGhlbSBhY3Qgb24gdGhhdDpcbiAqICBgcmVxdWlyZVNlc3Npb25gIGRpZXMgYG5vdF9mb3VuZGAgKGV4aXQgNSksIGBjbWRJbmZvYCB0aGUgc2FtZSwgYW5kIHRoZSB3YXRjaFxuICogIGxvb3AgdHJlYXRzIGl0IGFzIFwidGhlIHBpbm5lZCBzZXNzaW9uIHdlbnQgYXdheVwiIGFuZCBleGl0cyAqKjAqKi4gQSByZXNvdXJjZVxuICogIGZhaWx1cmUgd2FzIHRoZXJlZm9yZSByZXBvcnRlZCBhcyBhIFNVQ0NFU1NGVUwgZW5kIG9mIHdhdGNoLlxuICpcbiAqICBNZWFzdXJlZCBjb25zZXF1ZW5jZTogYHRlc3RzL2NsaS1jb250cmFjdC50ZXN0LnRzYCdzIEhUVFAtNDAwIHJvdyBmYWlsZWQgb25jZVxuICogIHVuZGVyIHRoZSBmdWxsIDE0Ni1maWxlIGdhdGUgd2l0aCBleGl0ICoqNSoqIHdoZXJlIHRoZSBjb250cmFjdCBzYXlzIDIsIGFuZFxuICogIHBhc3NlZCBhbG9uZSBhbmQgb24gcmUtcnVuIChmaWxlZCAyMDI2LTA5LTA3LCBkaWdlc3RpZnkncyBQaGFzZSAwIGJhc2VsaW5lKS5cbiAqICA1IGlzIG5vdCBhIHNwYXduIGNyYXNoIOKAlCBpdCBpcyB0aGlzIGZ1bmN0aW9uJ3MgYG5vdF9mb3VuZGAsIHdoaWNoIGlzIHdoeSB0aGVcbiAqICBjZWxsIGNvdWxkIG5vdCB0ZWxsIFwidGhlIGNvbnRyYWN0IGJyb2tlXCIgZnJvbSBcInRoZSBtYWNoaW5lIHdhcyBidXN5XCIuXG4gKlxuICogIFNvOiBFTk9FTlQgaXMgdGhlIG9ubHkgYWJzZW5jZS4gRXZlcnl0aGluZyBlbHNlIHRocm93cyBhbmQgbmFtZXMgaXRzZWxmLiAqL1xuZnVuY3Rpb24gcmVhZFNlc3Npb24oc2Vzc2lvbj86IHN0cmluZyk6IFNlc3Npb24gfCBudWxsIHtcbiAgY29uc3QgcGF0aCA9IHNlc3Npb25GaWxlUGF0aChzZXNzaW9uKTtcbiAgbGV0IHJhdzogc3RyaW5nO1xuICB0cnkge1xuICAgIHJhdyA9IHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zdCBjb2RlID0gKGUgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uKS5jb2RlO1xuICAgIGlmIChjb2RlID09PSBcIkVOT0VOVFwiKSByZXR1cm4gbnVsbDsgLy8gdGhlIG9uZSBob25lc3QgYWJzZW5jZVxuICAgIGRpZShgY2Fubm90IHJlYWQgdGhlIHNlc3Npb24gcG9pbnRlciAoJHtjb2RlID8/IFwidW5rbm93biBlcnJvclwifSk6ICR7cGF0aH1gLCBcImludGVybmFsXCIpO1xuICB9XG4gIHRyeSB7XG4gICAgcmV0dXJuIEpTT04ucGFyc2UocmF3KSBhcyBTZXNzaW9uO1xuICB9IGNhdGNoIHtcbiAgICAvLyBUaGUgZGFlbW9uIHdyaXRlcyB0aGlzIGZpbGUgYXRvbWljYWxseSAoc2VydmVyLnRzKSwgc28gYSBoYWxmLXdyaXR0ZW5cbiAgICAvLyBwb2ludGVyIGlzIG5vdCByZWFjaGFibGUgYW5kIHVucGFyc2VhYmxlIGNvbnRlbnQgaXMgcmVhbCBjb3JydXB0aW9uLlxuICAgIGRpZShgdGhlIHNlc3Npb24gcG9pbnRlciBpcyBub3QgdmFsaWQgSlNPTjogJHtwYXRofWAsIFwiaW50ZXJuYWxcIik7XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbj86IHN0cmluZyk6IFNlc3Npb24ge1xuICBjb25zdCBzID0gcmVhZFNlc3Npb24oc2Vzc2lvbik7XG4gIGlmICghcykgZGllKFwibm8gcnVubmluZyBnbGFtb3VyIHNlc3Npb25cIiwgXCJub3RfZm91bmRcIiwgTk9fU0VTU0lPTl9ISU5UKTtcbiAgcmV0dXJuIHM7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGFwaShcbiAgcG9ydDogbnVtYmVyLFxuICBtZXRob2Q6IHN0cmluZyxcbiAgcGF0aDogc3RyaW5nLFxuICBib2R5PzogdW5rbm93bixcbik6IFByb21pc2U8eyBzdGF0dXM6IG51bWJlcjsgZGF0YTogdW5rbm93biB9PiB7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0ke3BhdGh9YCwge1xuICAgIG1ldGhvZCxcbiAgICBoZWFkZXJzOiBib2R5ICE9PSB1bmRlZmluZWQgPyB7IFwiY29udGVudC10eXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0gOiB1bmRlZmluZWQsXG4gICAgYm9keTogYm9keSAhPT0gdW5kZWZpbmVkID8gSlNPTi5zdHJpbmdpZnkoYm9keSkgOiB1bmRlZmluZWQsXG4gIH0pO1xuICBsZXQgZGF0YTogdW5rbm93biA9IG51bGw7XG4gIHRyeSB7XG4gICAgZGF0YSA9IGF3YWl0IHJlcy5qc29uKCk7XG4gIH0gY2F0Y2gge1xuICAgIC8qIG5vbi1KU09OIGJvZHkgKi9cbiAgfVxuICByZXR1cm4geyBzdGF0dXM6IHJlcy5zdGF0dXMsIGRhdGEgfTtcbn1cblxuLy8gU3BsaXQgYXJndiBpbnRvIHBvc2l0aW9uYWxzICsgZmxhZ3MuIGAtLWZsYWcgdmFsdWVgIG9yIGJvb2xlYW4gYC0tZmxhZ2AuXG4vLyAjODEgLyBENCDigJQgVEhFIFJFQ09HTklaRUQgU0VULCBBVCBQQVJTRVIgQUxUSVRVREUuXG4vL1xuLy8gVGhpcyBwYXJzZXIgYWxyZWFkeSBzcGxpdCBvbiB0aGUgZmlyc3QgYD1gLiBXaGF0IGl0IGxhY2tlZCB3YXMgYSBSRUdJU1RSWTpcbi8vIGFuIHVua25vd24gZmxhZyB3YXMgYWNjZXB0ZWQgYXQgZXhpdCAwIGFuZCB0aGUgdmVyYiByYW4gYW55d2F5LCBhbmQgZnJlZVxuLy8gcHJvc2UgY29udGFpbmluZyBhIGAtLXdvcmRgIHdhcyBzaWxlbnRseSB0cnVuY2F0ZWQgYXQgdGhhdCB3b3JkLiBgbm9kZTp1dGlsYFxuLy8gc3RyaWN0IHN1cHBsaWVzIHJlamVjdGlvbiBhbmQgdGhlIGAtLWAgdGVybWluYXRvciBhbG9uZ3NpZGUgdGhlIGA9YCBoYW5kbGluZy5cbi8vXG4vLyDimqAgYC0tcmVzdG9yZWAgSEFEIE5PIENPUlJFQ1QgVFlQRSBhbmQgdGhpcyBpcyB0aGUgc3ByaW50J3Mgb25lIGdlbnVpbmUgZGVzaWduXG4vLyBibG9ja2VyLCBSVUxFRCBCWSBDT0xFLiBJdCB3YXMgQk9PTEVBTiBpbiBgc3R5bGUtYXJjaGl2ZWAgKGBhcmNoaXZlZDpcbi8vIGZsYWdzLnJlc3RvcmUgIT09IHRydWVgKSBhbmQgU1RSSU5HIGluIGBvcGVuYCdzIGRhZW1vbiBzcGF3biDigJQgb25lIGZsYWcgbmFtZSxcbi8vIHR3byBpbmNvbXBhdGlibGUgdHlwZXMsIG9uZSBvcHRpb25zIG1hcC4gRGVjbGFyaW5nIGl0IGJvb2xlYW4gc2VuZHMgYG9wZW5gJ3Ncbi8vIGlkIHRvIHBvc2l0aW9uYWxzIGFuZCBmb3J3YXJkcyBgLS1yZXN0b3JlIHRydWVgLCBzbyB0aGUgZGFlbW9uIGh1bnRzIGFcbi8vIHNuYXBzaG90IG5hbWVkIFwidHJ1ZVwiOyBkZWNsYXJpbmcgaXQgc3RyaW5nIG1ha2VzIGBzdHlsZS1hcmNoaXZlIDxpZD5cbi8vIC0tcmVzdG9yZWAgc3dhbGxvdyB0aGUgbmV4dCBwb3NpdGlvbmFsLCB3aGljaCBpcyB0aGlzIHNwcmludCdzIG93biBkZWZlY3Rcbi8vIGNsYXNzIHJlLWludHJvZHVjZWQgYnkgaXRzIGZpeC5cbi8vXG4vLyBSdWxlZDogcmVuYW1lIHRoZSBCT09MRUFOIG9uZS4gYC0tcmVzdG9yZWAga2VlcHMgdGhlIGhvdXNlLXdpZGUgc3RyaW5nXG4vLyBzcGVsbGluZyBpdCBzaGFyZXMgd2l0aCBib3VudHksIGltYWdvLCBtYWdwaWUgYW5kIGdsYW1vdXIncyBvd24gc2VydmVyLnRzO1xuLy8gYHN0eWxlLWFyY2hpdmVgIHRha2VzIGAtLXVuYXJjaGl2ZWAsIHdoaWNoIG5hbWVzIHRoZSBpbnZlcnNlIG9mIGFyY2hpdmVcbi8vIGJldHRlciBhbnl3YXkuIEl0IGFsc28ga2lsbHMgYSBsaXZlIGJ1ZyBCWSBDT05TVFJVQ1RJT046IGBmbGFncy5yZXN0b3JlICE9PVxuLy8gdHJ1ZWAgbWVhbnQgYHN0eWxlLWFyY2hpdmUgPGlkPiAtLXJlc3RvcmUgZm9vYCBBUkNISVZFRCBpbnN0ZWFkIG9mIHJlc3RvcmluZyxcbi8vIGF0IGV4aXQgMCwgd2l0aCBubyBzaWduYWwuXG5jb25zdCBDTElfT1BUSU9OUyA9IHtcbiAgY29sb3JzOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgY29udGVudDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGNvc3Q6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBjdXN0b206IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBmaWxlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgaW50ZW50OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAga2luZDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGxhYmVsOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbW9kZWw6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBub3RlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcHJvbXB0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcHJvbXB0czogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHJlc3RvcmU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICByb3VuZDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHNlZWQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzZXNzaW9uOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc2luY2U6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzcmM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBcInN0YXJ0LXRpbWVvdXRcIjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHN0YXR1czogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRpbWVvdXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0aXRsZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHVybDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGZ1bGw6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgXCJuby1vcGVuXCI6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgdW5hcmNoaXZlOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG59IGFzIGNvbnN0O1xuXG5leHBvcnQgY29uc3QgUkVDT0dOSVpFRF9GTEFHUyA9IE9iamVjdC5rZXlzKENMSV9PUFRJT05TKS5tYXAoKGspID0+IGAtLSR7a31gKTtcblxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQXJncyhhcmdzOiBzdHJpbmdbXSk6IHtcbiAgcG9zOiBzdHJpbmdbXTtcbiAgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+O1xufSB7XG4gIHRyeSB7XG4gICAgY29uc3QgeyB2YWx1ZXMsIHBvc2l0aW9uYWxzIH0gPSBub2RlUGFyc2VBcmdzKHtcbiAgICAgIGFyZ3MsXG4gICAgICBvcHRpb25zOiBDTElfT1BUSU9OUyxcbiAgICAgIHN0cmljdDogdHJ1ZSxcbiAgICAgIGFsbG93UG9zaXRpb25hbHM6IHRydWUsXG4gICAgfSk7XG4gICAgcmV0dXJuIHsgcG9zOiBwb3NpdGlvbmFscywgZmxhZ3M6IHZhbHVlcyBhcyBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPiB9O1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc3QgZGV0YWlsID0gZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpO1xuICAgIC8vIFRoZSByZWplY3Rpb24gTkFNRVMgaXRzIHZhbGlkIHNldCAoYWNjIEEzJ3MgU0hPVUxEKTogYGNob2ljZXNgIGlzIHRoZVxuICAgIC8vIHJlY29nbml6ZWQgZmxhZyByZWdpc3RyeSwgc28gYW4gYWdlbnQgc2VsZi1jb3JyZWN0cyB3aXRob3V0IGEgbG9va3VwLlxuICAgIHRocm93IG5ldyBVc2FnZUVycm9yKGRldGFpbCwge1xuICAgICAgaGludDogXCJmb3IgZnJlZSB0ZXh0IGNvbnRhaW5pbmcgZGFzaGVzLCBwdXQgaXQgYWZ0ZXIgYSBiYXJlIC0tXCIsXG4gICAgICBjaG9pY2VzOiBSRUNPR05JWkVEX0ZMQUdTLFxuICAgIH0pO1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFNheUNtZChcbiAgcG9zOiBzdHJpbmdbXSxcbiAgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+LFxuKTogeyB0eXBlOiBcInNheVwiOyB0ZXh0OiBzdHJpbmc7IGtpbmQ/OiBzdHJpbmcgfSB7XG4gIGNvbnN0IGNtZDogeyB0eXBlOiBcInNheVwiOyB0ZXh0OiBzdHJpbmc7IGtpbmQ/OiBzdHJpbmcgfSA9IHtcbiAgICB0eXBlOiBcInNheVwiLFxuICAgIHRleHQ6IHBvcy5qb2luKFwiIFwiKSxcbiAgfTtcbiAgaWYgKHR5cGVvZiBmbGFncy5raW5kID09PSBcInN0cmluZ1wiKSBjbWQua2luZCA9IGZsYWdzLmtpbmQ7XG4gIHJldHVybiBjbWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFNlY3Rpb25DbWQoXG4gIHBvczogc3RyaW5nW10sXG4gIGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPixcbik6IHtcbiAgdHlwZTogXCJzZWN0aW9uXCI7XG4gIGtleTogc3RyaW5nO1xuICBzdGF0dXM/OiBzdHJpbmc7XG4gIGNvbnRlbnQ/OiBzdHJpbmc7XG4gIHByb21wdHM/OiBzdHJpbmdbXTtcbiAgY29sb3JzPzogQXJyYXk8eyBoZXg6IHN0cmluZzsgbmFtZT86IHN0cmluZyB9Pjtcbn0ge1xuICBjb25zdCBjbWQ6IHtcbiAgICB0eXBlOiBcInNlY3Rpb25cIjtcbiAgICBrZXk6IHN0cmluZztcbiAgICBzdGF0dXM/OiBzdHJpbmc7XG4gICAgY29udGVudD86IHN0cmluZztcbiAgICBwcm9tcHRzPzogc3RyaW5nW107XG4gICAgY29sb3JzPzogQXJyYXk8eyBoZXg6IHN0cmluZzsgbmFtZT86IHN0cmluZyB9PjtcbiAgfSA9IHsgdHlwZTogXCJzZWN0aW9uXCIsIGtleTogcG9zWzBdIH07XG4gIGlmICh0eXBlb2YgZmxhZ3Muc3RhdHVzID09PSBcInN0cmluZ1wiKSBjbWQuc3RhdHVzID0gZmxhZ3Muc3RhdHVzO1xuICBpZiAodHlwZW9mIGZsYWdzLmNvbnRlbnQgPT09IFwic3RyaW5nXCIpIGNtZC5jb250ZW50ID0gZmxhZ3MuY29udGVudDtcbiAgaWYgKHR5cGVvZiBmbGFncy5wcm9tcHRzID09PSBcInN0cmluZ1wiKVxuICAgIGNtZC5wcm9tcHRzID0gZmxhZ3MucHJvbXB0cy5zcGxpdChcInx8XCIpLm1hcCgocCkgPT4gcC50cmltKCkpO1xuICAvLyAtLWNvbG9ycyBcIiNGQUNDM0U6VHJlYXN1cmUgR29sZHx8IzI5M0QzNjpTdW5rZW4gQ2hhcmNvYWxcIiDihpIgc3RydWN0dXJlZCBzd2F0Y2hlc1xuICBpZiAodHlwZW9mIGZsYWdzLmNvbG9ycyA9PT0gXCJzdHJpbmdcIilcbiAgICBjbWQuY29sb3JzID0gZmxhZ3MuY29sb3JzXG4gICAgICAuc3BsaXQoXCJ8fFwiKVxuICAgICAgLm1hcCgocykgPT4ge1xuICAgICAgICBjb25zdCBpID0gcy5pbmRleE9mKFwiOlwiKTtcbiAgICAgICAgcmV0dXJuIGkgPj0gMFxuICAgICAgICAgID8geyBoZXg6IHMuc2xpY2UoMCwgaSkudHJpbSgpLCBuYW1lOiBzLnNsaWNlKGkgKyAxKS50cmltKCkgfVxuICAgICAgICAgIDogeyBoZXg6IHMudHJpbSgpIH07XG4gICAgICB9KVxuICAgICAgLmZpbHRlcigoYykgPT4gYy5oZXgpO1xuICByZXR1cm4gY21kO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VDdXN0b20odjogc3RyaW5nIHwgYm9vbGVhbiB8IHVuZGVmaW5lZCk6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gfCB1bmRlZmluZWQge1xuICBpZiAodHlwZW9mIHYgIT09IFwic3RyaW5nXCIpIHJldHVybiB1bmRlZmluZWQ7XG4gIGNvbnN0IG91dDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICBmb3IgKGNvbnN0IHBhaXIgb2Ygdi5zcGxpdChcIixcIikpIHtcbiAgICBjb25zdCBlcSA9IHBhaXIuaW5kZXhPZihcIj1cIik7XG4gICAgaWYgKGVxID4gMCkgb3V0W3BhaXIuc2xpY2UoMCwgZXEpLnRyaW0oKV0gPSBwYWlyLnNsaWNlKGVxICsgMSkudHJpbSgpO1xuICB9XG4gIHJldHVybiBPYmplY3Qua2V5cyhvdXQpLmxlbmd0aCA/IG91dCA6IHVuZGVmaW5lZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkR2VuQ21kKFxuICBzcmM6IHN0cmluZyxcbiAgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+LFxuKToge1xuICB0eXBlOiBcImdlbi5hZGRcIjtcbiAgc3JjOiBzdHJpbmc7XG4gIHByb21wdDogc3RyaW5nO1xuICBtb2RlbDogc3RyaW5nO1xuICByb3VuZDogbnVtYmVyO1xuICBzZWVkPzogbnVtYmVyO1xuICBjb3N0PzogbnVtYmVyO1xuICBsYWJlbD86IHN0cmluZztcbiAgY3VzdG9tPzogUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbn0ge1xuICBjb25zdCBjbWQ6IFJldHVyblR5cGU8dHlwZW9mIGJ1aWxkR2VuQ21kPiA9IHtcbiAgICB0eXBlOiBcImdlbi5hZGRcIixcbiAgICBzcmMsXG4gICAgcHJvbXB0OiB0eXBlb2YgZmxhZ3MucHJvbXB0ID09PSBcInN0cmluZ1wiID8gZmxhZ3MucHJvbXB0IDogXCJcIixcbiAgICBtb2RlbDogdHlwZW9mIGZsYWdzLm1vZGVsID09PSBcInN0cmluZ1wiID8gZmxhZ3MubW9kZWwgOiBcIlwiLFxuICAgIHJvdW5kOiB0eXBlb2YgZmxhZ3Mucm91bmQgPT09IFwic3RyaW5nXCIgPyBOdW1iZXIucGFyc2VJbnQoZmxhZ3Mucm91bmQsIDEwKSA6IDAsXG4gIH07XG4gIGlmICh0eXBlb2YgZmxhZ3Muc2VlZCA9PT0gXCJzdHJpbmdcIikgY21kLnNlZWQgPSBOdW1iZXIucGFyc2VJbnQoZmxhZ3Muc2VlZCwgMTApO1xuICBpZiAodHlwZW9mIGZsYWdzLmNvc3QgPT09IFwic3RyaW5nXCIpIGNtZC5jb3N0ID0gTnVtYmVyLnBhcnNlRmxvYXQoZmxhZ3MuY29zdCk7XG4gIGlmICh0eXBlb2YgZmxhZ3MubGFiZWwgPT09IFwic3RyaW5nXCIpIGNtZC5sYWJlbCA9IGZsYWdzLmxhYmVsO1xuICBjb25zdCBjdXN0b20gPSBwYXJzZUN1c3RvbShmbGFncy5jdXN0b20pO1xuICBpZiAoY3VzdG9tKSBjbWQuY3VzdG9tID0gY3VzdG9tO1xuICByZXR1cm4gY21kO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRHZW5Db3N0Q21kKFxuICBwb3M6IHN0cmluZ1tdLFxuICBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4sXG4pOiB7IHR5cGU6IFwiZ2VuLmNvc3RcIjsgaWQ6IHN0cmluZzsgY29zdDogbnVtYmVyIH0ge1xuICByZXR1cm4ge1xuICAgIHR5cGU6IFwiZ2VuLmNvc3RcIixcbiAgICBpZDogcG9zWzBdLFxuICAgIGNvc3Q6IHR5cGVvZiBmbGFncy5jb3N0ID09PSBcInN0cmluZ1wiID8gTnVtYmVyLnBhcnNlRmxvYXQoZmxhZ3MuY29zdCkgOiBOdW1iZXIuTmFOLFxuICB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRHZW5NZXRhQ21kKFxuICBwb3M6IHN0cmluZ1tdLFxuICBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4sXG4pOiB7IHR5cGU6IFwiZ2VuLm1ldGFcIjsgaWQ6IHN0cmluZzsgcHJvbXB0Pzogc3RyaW5nOyBjdXN0b20/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IH0ge1xuICBjb25zdCBjbWQ6IHsgdHlwZTogXCJnZW4ubWV0YVwiOyBpZDogc3RyaW5nOyBwcm9tcHQ/OiBzdHJpbmc7IGN1c3RvbT86IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gfSA9IHtcbiAgICB0eXBlOiBcImdlbi5tZXRhXCIsXG4gICAgaWQ6IHBvc1swXSxcbiAgfTtcbiAgaWYgKHR5cGVvZiBmbGFncy5wcm9tcHQgPT09IFwic3RyaW5nXCIpIGNtZC5wcm9tcHQgPSBmbGFncy5wcm9tcHQ7XG4gIGNvbnN0IGN1c3RvbSA9IHBhcnNlQ3VzdG9tKGZsYWdzLmN1c3RvbSk7XG4gIGlmIChjdXN0b20pIGNtZC5jdXN0b20gPSBjdXN0b207XG4gIHJldHVybiBjbWQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZFN0eWxlU2F2ZUNtZChwb3M6IHN0cmluZ1tdKToge1xuICB0eXBlOiBcInN0eWxlLnNhdmVcIjtcbiAgbGFiZWw6IHN0cmluZztcbn0ge1xuICByZXR1cm4geyB0eXBlOiBcInN0eWxlLnNhdmVcIiwgbGFiZWw6IHBvcy5qb2luKFwiIFwiKSB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRTdHlsZUFyY2hpdmVDbWQoXG4gIHBvczogc3RyaW5nW10sXG4gIGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPixcbik6IHsgdHlwZTogXCJzdHlsZS5hcmNoaXZlXCI7IGlkOiBzdHJpbmc7IGFyY2hpdmVkOiBib29sZWFuIH0ge1xuICByZXR1cm4ge1xuICAgIHR5cGU6IFwic3R5bGUuYXJjaGl2ZVwiLFxuICAgIGlkOiBwb3NbMF0sXG4gICAgYXJjaGl2ZWQ6ICFmbGFncy51bmFyY2hpdmUsXG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZEZvY3VzQ21kKFxuICBwb3M6IHN0cmluZ1tdLFxuICBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4sXG4pOiB7IHR5cGU6IFwiZm9jdXMucHVzaFwiOyBpZHM6IHN0cmluZ1tdOyBub3RlPzogc3RyaW5nIH0ge1xuICBjb25zdCBjbWQ6IHsgdHlwZTogXCJmb2N1cy5wdXNoXCI7IGlkczogc3RyaW5nW107IG5vdGU/OiBzdHJpbmcgfSA9IHtcbiAgICB0eXBlOiBcImZvY3VzLnB1c2hcIixcbiAgICBpZHM6IHBvcyxcbiAgfTtcbiAgaWYgKHR5cGVvZiBmbGFncy5ub3RlID09PSBcInN0cmluZ1wiKSBjbWQubm90ZSA9IGZsYWdzLm5vdGU7XG4gIHJldHVybiBjbWQ7XG59XG5cbi8vIFJlc29sdmUgYSBnZW4gaW1hZ2Ugc291cmNlIHRvIGFuIE9QVElNSVpFRCB3ZWJwIGRhdGEtVVJMICh0aGUgZGFlbW9uIHN0b3Jlc1xuLy8gaXQgYXMtaXMpLiAtLXVybCBkb3dubG9hZHM7IC0tZmlsZSByZWFkczsgLS1zcmMgaXMgYW4gZXhpc3RpbmcgZGF0YS1VUkwuXG5hc3luYyBmdW5jdGlvbiByZXNvbHZlR2VuU3JjKGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPik6IFByb21pc2U8c3RyaW5nPiB7XG4gIGlmICh0eXBlb2YgZmxhZ3MudXJsID09PSBcInN0cmluZ1wiKSB7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goZmxhZ3MudXJsKTtcbiAgICBpZiAoIXJlcy5vaykgZGllKGBnZW46IGZhaWxlZCB0byBmZXRjaCAtLXVybCAoSFRUUCAke3Jlcy5zdGF0dXN9KWAsIFwiaW50ZXJuYWxcIik7XG4gICAgY29uc3QgYnl0ZXMgPSBuZXcgVWludDhBcnJheShhd2FpdCByZXMuYXJyYXlCdWZmZXIoKSk7XG4gICAgbGV0IGJpbiA9IFwiXCI7XG4gICAgZm9yIChjb25zdCBiIG9mIGJ5dGVzKSBiaW4gKz0gU3RyaW5nLmZyb21DaGFyQ29kZShiKTtcbiAgICBjb25zdCBtaW1lID0gcmVzLmhlYWRlcnMuZ2V0KFwiY29udGVudC10eXBlXCIpID8/IFwiaW1hZ2UvcG5nXCI7XG4gICAgcmV0dXJuIG9wdGltaXplSW1hZ2VEYXRhVXJsKGBkYXRhOiR7bWltZX07YmFzZTY0LCR7YnRvYShiaW4pfWApO1xuICB9XG4gIGlmICh0eXBlb2YgZmxhZ3MuZmlsZSA9PT0gXCJzdHJpbmdcIikge1xuICAgIGNvbnN0IGJ5dGVzID0gbmV3IFVpbnQ4QXJyYXkoYXdhaXQgQnVuLmZpbGUoZmxhZ3MuZmlsZSkuYXJyYXlCdWZmZXIoKSk7XG4gICAgbGV0IGJpbiA9IFwiXCI7XG4gICAgZm9yIChjb25zdCBiIG9mIGJ5dGVzKSBiaW4gKz0gU3RyaW5nLmZyb21DaGFyQ29kZShiKTtcbiAgICByZXR1cm4gb3B0aW1pemVJbWFnZURhdGFVcmwoYGRhdGE6aW1hZ2UvcG5nO2Jhc2U2NCwke2J0b2EoYmluKX1gKTtcbiAgfVxuICBpZiAodHlwZW9mIGZsYWdzLnNyYyA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIG9wdGltaXplSW1hZ2VEYXRhVXJsKGZsYWdzLnNyYyk7XG4gIGRpZShcImdlbjogb25lIG9mIC0tdXJsLCAtLWZpbGUsIG9yIC0tc3JjIGlzIHJlcXVpcmVkXCIpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBwb3N0Q21kKHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCwgbXNnOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikge1xuICBjb25zdCBzID0gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbik7XG4gIGxldCBzdGF0dXM6IG51bWJlcjtcbiAgbGV0IGRhdGE6IHVua25vd247XG4gIHRyeSB7XG4gICAgKHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGkocy5wb3J0LCBcIlBPU1RcIiwgXCIvY21kXCIsIG1zZykpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICAvLyBgY2xvc2VgIGNhdXNlcyBCdW4uc2VydmUgdG8gc3RvcCBpbW1lZGlhdGVseSDigJQgdGhlIGNvbm5lY3Rpb24gcmVzZXRzXG4gICAgLy8gYmVmb3JlIHRoZSAyMDAgcmVzcG9uc2UgaXMgZmx1c2hlZC4gVHJlYXQgRUNPTk5SRVNFVCBvbiBjbG9zZSBhcyBzdWNjZXNzLlxuICAgIC8vIE9OTFkgYSByZXNldDogYSByZWZ1c2VkIGNvbm5lY3Rpb24gKHN0YWxlIHBvaW50ZXIsIGRhZW1vbiBhbHJlYWR5IGdvbmUpXG4gICAgLy8gaXMgYSB0cmFuc3BvcnQgZmFpbHVyZSBsaWtlIGFueSBvdGhlciBhbmQgcmlkZXMgdGhlIGludGVybmFsIGVudmVsb3BlIOKAlFxuICAgIC8vIHRoZSByZXZpZXcgZm91bmQgdGhlIG9sZCBjYXRjaC1hbGwgcmVwb3J0aW5nIHtvazp0cnVlfSBhZ2FpbnN0IGEgZGVhZCBwb3J0LlxuICAgIGNvbnN0IGNvZGUgPSBlcnIgJiYgdHlwZW9mIGVyciA9PT0gXCJvYmplY3RcIiAmJiBcImNvZGVcIiBpbiBlcnIgPyBTdHJpbmcoZXJyLmNvZGUpIDogXCJcIjtcbiAgICBjb25zdCBtZXNzYWdlID0gZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpO1xuICAgIGlmIChtc2cudHlwZSA9PT0gXCJjbG9zZVwiICYmIChjb2RlID09PSBcIkVDT05OUkVTRVRcIiB8fCBtZXNzYWdlLmluY2x1ZGVzKFwiRUNPTk5SRVNFVFwiKSkpIHtcbiAgICAgIHByaW50SnNvbih7IG9rOiB0cnVlLCBzZW50OiBcImNsb3NlXCIgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRocm93IGVycjtcbiAgfVxuICBpZiAoc3RhdHVzICE9PSAyMDApIGRhZW1vblJlZnVzZWQoXCJjbWRcIiwgc3RhdHVzLCBkYXRhKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIHNlbnQ6IG1zZy50eXBlIH0pO1xufVxuXG4vLyDilIDilIAgdmVyYnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmFzeW5jIGZ1bmN0aW9uIGNtZE9wZW4oZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KSB7XG4gIGNvbnN0IGRhZW1vbkFyZ3MgPSBbXCJydW5cIiwgU0VSVkVSX1NDUklQVF07XG4gIGlmIChmbGFncy50aXRsZSkgZGFlbW9uQXJncy5wdXNoKFwiLS10aXRsZVwiLCBTdHJpbmcoZmxhZ3MudGl0bGUpKTtcbiAgaWYgKGZsYWdzLmludGVudCkgZGFlbW9uQXJncy5wdXNoKFwiLS1pbnRlbnRcIiwgU3RyaW5nKGZsYWdzLmludGVudCkpO1xuICBpZiAoZmxhZ3MudGltZW91dCkgZGFlbW9uQXJncy5wdXNoKFwiLS10aW1lb3V0XCIsIFN0cmluZyhmbGFncy50aW1lb3V0KSk7XG4gIGlmIChmbGFncy5yZXN0b3JlKSBkYWVtb25BcmdzLnB1c2goXCItLXJlc3RvcmVcIiwgU3RyaW5nKGZsYWdzLnJlc3RvcmUpKTtcbiAgLy8gVGhlIHVzZXIncyBwcm9qZWN0IGRpciDigJQgY2FwdHVyZWQgaGVyZSBiZWNhdXNlIHRoZSBkYWVtb24gc3Bhd25zIHdpdGggYVxuICAvLyBwaW5uZWQgY3dkIChkYWVtb25Dd2QoKSksIHNvIGl0IGNhbid0IHJlYWQgdGhlIHJlYWwgY3dkIGl0c2VsZi5cbiAgZGFlbW9uQXJncy5wdXNoKFwiLS1wcm9qZWN0XCIsIHByb2Nlc3MuY3dkKCkpO1xuXG4gIC8vIG5vZGU6Y2hpbGRfcHJvY2VzcyAobm90IEJ1bi5zcGF3bikgaXMgZGVsaWJlcmF0ZTogdGhlIGRhZW1vbiBtdXN0IFNVUlZJVkVcbiAgLy8gdGhpcyBDTEkgcHJvY2VzcyBleGl0aW5nLCB3aGljaCBuZWVkcyBgZGV0YWNoZWQ6IHRydWVgICsgYHVucmVmKClgLlxuICAvLyBDb250cmFjdCA1IOKAlCBzZWUgZGFlbW9uQ3dkKCkuIEFuZCBjaGVjayB0aGUgY3dkIEVYSVNUUyBiZWZvcmUgc3Bhd25pbmc6XG4gIC8vIG5vZGUgcmVwb3J0cyBhIG1pc3NpbmcgY3dkIGFzIGBFTk9FTlQg4oCmIHBvc2l4X3NwYXduICdidW4nYCwgd2hpY2ggbmFtZXMgdGhlXG4gIC8vIG9uZSB0aGluZyB0aGF0IGlzIGZpbmUuIE1lYXN1cmVkIGJ5IGNhc3NhbmRyYSBhdCBhIGRlcHMtZnJlZSBkZXN0aW5hdGlvblxuICAvLyB3aXRoIGRpc3QvaW5kZXguaHRtbCByZW1vdmVkIChjb21tcyAjMTI2NSk6IGEgY29sZCBhZ2VudCByZWFkcyB0aGF0IGFuZFxuICAvLyByZWluc3RhbGxzIGJ1bi4gTmFtZSB0aGUgcmVhbCBhYnNlbmNlIGluc3RlYWQuXG4gIGNvbnN0IGN3ZCA9IGRhZW1vbkN3ZCgpO1xuICBpZiAoIWV4aXN0c1N5bmMoY3dkKSkge1xuICAgIGRpZShcbiAgICAgIGBnbGFtb3VyIGNhbm5vdCBzdGFydCBpdHMgZGFlbW9uOiB0aGUgd29ya2luZyBkaXJlY3RvcnkgaXQgbmVlZHMgaXMgbWlzc2luZyDigJQgJHtjd2R9YCxcbiAgICAgIFwiaW50ZXJuYWxcIixcbiAgICAgIHtcbiAgICAgICAgaGludDpcbiAgICAgICAgICBcImRldiBtb2RlIHdhcyByZXNvbHZlZCAobm8gZGlzdC9pbmRleC5odG1sIGF0IHRoZSBza2lsbCByb290IGFuZCBubyBTUEVMTEJPT0tfU1VSRkFDRV9NT0RFPXJlbGVhc2UpLCBcIiArXG4gICAgICAgICAgXCJzbyB0aGUgZGFlbW9uIG11c3QgcnVuIGZyb20gc3JjL2dsYW1vdXIvLCB3aGljaCBhIHNvdXJjZS1mcmVlIGluc3RhbGwgZG9lcyBub3QgaGF2ZS4gXCIgK1xuICAgICAgICAgIFwiRWl0aGVyIHRoZSBzaGlwcGVkIGRpc3QvIGlzIG1pc3NpbmcgKHJlaW5zdGFsbCB0aGUgc3BlbGwpIG9yIHlvdSBhcmUgaW4gYSBjaGVja291dCB3aXRob3V0IHNyYy9nbGFtb3VyLy5cIixcbiAgICAgIH0sXG4gICAgKTtcbiAgfVxuICBjb25zdCBjaGlsZCA9IHNwYXduKFwiYnVuXCIsIGRhZW1vbkFyZ3MsIHtcbiAgICBjd2QsXG4gICAgZGV0YWNoZWQ6IHRydWUsXG4gICAgc3RkaW86IFtcImlnbm9yZVwiLCBcInBpcGVcIiwgXCJpbmhlcml0XCJdLFxuICAgIGVudjogcHJvY2Vzcy5lbnYsXG4gIH0pO1xuICBjaGlsZC51bnJlZigpO1xuXG4gIC8vIFJlYWQgdGhlIGRhZW1vbidzIGZpcnN0IHN0ZG91dCBsaW5lIOKAlCBpdCBwcmludHMge3VybCwgcG9ydCwgc2Vzc2lvbl9pZH0uXG4gIC8vIEdlbmVyb3VzIGRlZmF1bHQ6IHRoZSBmaXJzdCBidW5kbGUgYnVpbGQgb2YgdGhlIFJlYWN0IHN1cmZhY2UgY2FuIHRha2UgdGVuc1xuICAvLyBvZiBzZWNvbmRzIGNvbGQsIGFuZCBhIHRvby1zaG9ydCBoYW5kc2hha2UgbWFrZXMgYG9wZW5gIHJlcG9ydCBmYWlsdXJlIHdoaWxlXG4gIC8vIHRoZSBkYWVtb24gYWN0dWFsbHkgY29tZXMgdXAgZmluZS4gT3ZlcnJpZGUgd2l0aCAtLXN0YXJ0LXRpbWVvdXQgPHNlY29uZHM+LlxuICBjb25zdCBzdGFydFRpbWVvdXRNcyA9XG4gICAgdHlwZW9mIGZsYWdzW1wic3RhcnQtdGltZW91dFwiXSA9PT0gXCJzdHJpbmdcIlxuICAgICAgPyBNYXRoLm1heCg1MDAwLCBOdW1iZXIucGFyc2VJbnQoU3RyaW5nKGZsYWdzW1wic3RhcnQtdGltZW91dFwiXSksIDEwKSAqIDEwMDApXG4gICAgICA6IDQ1MDAwO1xuICBjb25zdCBpbmZvID0gYXdhaXQgbmV3IFByb21pc2U8c3RyaW5nPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgbGV0IGJ1ZiA9IFwiXCI7XG4gICAgY29uc3QgdGltZW91dCA9IHNldFRpbWVvdXQoXG4gICAgICAoKSA9PlxuICAgICAgICByZWplY3QoXG4gICAgICAgICAgbmV3IEVycm9yKFxuICAgICAgICAgICAgYGRhZW1vbiBzdGFydCB0aW1lb3V0ICgke3N0YXJ0VGltZW91dE1zIC8gMTAwMH1zKSDigJQgZmlyc3QgYnVuZGxlIGJ1aWxkIGNhbiBiZSBzbG93OyByZXRyeSBvciBwYXNzIC0tc3RhcnQtdGltZW91dCA8c2Vjb25kcz5gLFxuICAgICAgICAgICksXG4gICAgICAgICksXG4gICAgICBzdGFydFRpbWVvdXRNcyxcbiAgICApO1xuICAgIC8vIGJpb21lLWlnbm9yZSBsaW50L3N0eWxlL25vTm9uTnVsbEFzc2VydGlvbjogc3RkaW8gXCJwaXBlXCIgZ3VhcmFudGVlcyBzdGRvdXRcbiAgICBjaGlsZC5zdGRvdXQhLm9uKFwiZGF0YVwiLCAoY2h1bms6IEJ1ZmZlcikgPT4ge1xuICAgICAgYnVmICs9IGNodW5rLnRvU3RyaW5nKCk7XG4gICAgICBjb25zdCBubCA9IGJ1Zi5pbmRleE9mKFwiXFxuXCIpO1xuICAgICAgaWYgKG5sID49IDApIHtcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVvdXQpO1xuICAgICAgICByZXNvbHZlKGJ1Zi5zbGljZSgwLCBubCkudHJpbSgpKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICBjaGlsZC5vbihcImVycm9yXCIsIChlcnIpID0+IHtcbiAgICAgIGNsZWFyVGltZW91dCh0aW1lb3V0KTtcbiAgICAgIHJlamVjdChlcnIpO1xuICAgIH0pO1xuICAgIGNoaWxkLm9uKFwiZXhpdFwiLCAoY29kZSkgPT4ge1xuICAgICAgaWYgKGNvZGUgIT09IG51bGwgJiYgY29kZSAhPT0gMCkge1xuICAgICAgICBjbGVhclRpbWVvdXQodGltZW91dCk7XG4gICAgICAgIHJlamVjdChuZXcgRXJyb3IoYGRhZW1vbiBleGl0ZWQgd2l0aCBjb2RlICR7Y29kZX1gKSk7XG4gICAgICB9XG4gICAgfSk7XG4gIH0pLmNhdGNoKChlcnI6IHVua25vd24pID0+IHtcbiAgICBjb25zdCBtc2cgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgZGllKGBnbGFtb3VyIHNlcnZlciBmYWlsZWQgdG8gc3RhcnQ6ICR7bXNnfWAsIFwiaW50ZXJuYWxcIik7XG4gIH0pO1xuXG4gIC8vIOKaoCBSRUxFQVNFIFRIRSBEQUVNT04nUyBTVERPVVQgUElQRSwgb3IgdGhpcyBDTEkgbmV2ZXIgZXhpdHMuXG4gIC8vXG4gIC8vIGBjaGlsZC51bnJlZigpYCBhYm92ZSByZWxlYXNlcyB0aGUgQ0hJTEQgUFJPQ0VTUyBoYW5kbGUuIFRoZSBwaXBlZCBzdGRvdXQgaXNcbiAgLy8gYSBTRVBBUkFURSByZWZmZWQgaGFuZGxlLCBhbmQgdGhlIGRhZW1vbiBydW5zIGZvcmV2ZXIg4oCUIHNvIG9uY2UgYG9wZW5gIHN0b3BzXG4gIC8vIGZvcmNlLWV4aXRpbmcsIHRoZSBwYXJlbnQncyBldmVudCBsb29wIHdhaXRzIG9uIGEgc3RyZWFtIHRoYXQgd2lsbCBuZXZlclxuICAvLyBjbG9zZS4gTWVhc3VyZWQ6IGBvcGVuIC0tbm8tb3BlbmAgc3RpbGwgcnVubmluZyBhdCA5MXM7IHdpdGggdGhpcyBsaW5lLCAxcy5cbiAgLy9cbiAgLy8gVGhpcyBiZWNhbWUgbGl2ZSB3aGVuIFAwIHJlcGxhY2VkIGBwcm9jZXNzLmV4aXQoY29kZSlgIHdpdGggYHByb2Nlc3MuZXhpdENvZGVgXG4gIC8vICsgYSBuYXR1cmFsIHJldHVybjogYHByb2Nlc3MuZXhpdGAgaGFkIGJlZW4gZG9pbmcgRE9VQkxFIERVVFksIGRyYWluaW5nIHN0ZG91dFxuICAvLyAoYnJva2VuIOKAlCBpdCB0cnVuY2F0ZWQgYXQgNjUsNTM2KSBBTkQgdGVybWluYXRpbmcgZGVzcGl0ZSBhIGxpdmUgY2hpbGQgcGlwZVxuICAvLyAobG9hZC1iZWFyaW5nLCBhbmQgdW5ub3RpY2VkKS4gUmVtb3ZpbmcgaXQgZml4ZWQgdGhlIGZpcnN0IGFuZCBleHBvc2VkIHRoZVxuICAvLyBzZWNvbmQuIGBqb2luLnRzYCBoYXMgdGhlIHNhbWUgc2hhcGUgYW5kIGlzIGRlbGliZXJhdGVseSBOT1QgY29udmVydGVkLlxuICAvL1xuICAvLyBgdW5yZWYoKWAgcmF0aGVyIHRoYW4gYGRlc3Ryb3koKWA6IGJvdGggbWVhc3VyZWQgY2xlYW4sIGFuZCB1bnJlZiBpcyB0aGVcbiAgLy8gY29uc2VydmF0aXZlIG9uZSDigJQgaXQgbGVhdmVzIHRoZSBzdHJlYW0gdXNhYmxlIGFuZCBvbmx5IHN0b3BzIGl0IGhvbGRpbmcgdGhlXG4gIC8vIGxvb3AuIFRoZSBoYW5kc2hha2UgaXMgdGhlIHNvbGUgcmVhZCwgc28gbm90aGluZyBkb3duc3RyZWFtIG5lZWRzIGl0LlxuICAvLyBiaW9tZS1pZ25vcmUgbGludC9zdHlsZS9ub05vbk51bGxBc3NlcnRpb246IHN0ZGlvIFwicGlwZVwiIGd1YXJhbnRlZXMgc3Rkb3V0XG4gIGNoaWxkLnN0ZG91dCEudW5yZWYoKTtcblxuICBsZXQgcGFyc2VkOiB7IHVybDogc3RyaW5nOyBwb3J0OiBudW1iZXI7IHNlc3Npb25faWQ6IHN0cmluZyB9O1xuICB0cnkge1xuICAgIHBhcnNlZCA9IEpTT04ucGFyc2UoaW5mbykgYXMgdHlwZW9mIHBhcnNlZDtcbiAgfSBjYXRjaCB7XG4gICAgZGllKGB1bmV4cGVjdGVkIG91dHB1dCBmcm9tIGRhZW1vbjogJHtpbmZvfWAsIFwiaW50ZXJuYWxcIik7XG4gIH1cblxuICBwcmludEpzb24ocGFyc2VkKTtcblxuICBpZiAoIWZsYWdzW1wibm8tb3BlblwiXSkge1xuICAgIC8vIFBsYXRmb3JtIG9wZW5lciDigJQgb3BlbiB0aGUgYnJvd3NlclxuICAgIGNvbnN0IG9wZW5lciA9XG4gICAgICBwcm9jZXNzLnBsYXRmb3JtID09PSBcImRhcndpblwiID8gXCJvcGVuXCIgOiBwcm9jZXNzLnBsYXRmb3JtID09PSBcIndpbjMyXCIgPyBcInN0YXJ0XCIgOiBcInhkZy1vcGVuXCI7XG4gICAgc3Bhd24ob3BlbmVyLCBbcGFyc2VkLnVybF0sIHsgZGV0YWNoZWQ6IHRydWUsIHN0ZGlvOiBcImlnbm9yZVwiIH0pLnVucmVmKCk7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kU3RhdGUoc2Vzc2lvbj86IHN0cmluZywgZnVsbCA9IGZhbHNlKSB7XG4gIGNvbnN0IHMgPSByZXF1aXJlU2Vzc2lvbihzZXNzaW9uKTtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaShzLnBvcnQsIFwiR0VUXCIsIGAvc3RhdGUke2Z1bGwgPyBcIlwiIDogXCI/bGVhbj0xXCJ9YCk7XG4gIGlmIChzdGF0dXMgIT09IDIwMCkgZGFlbW9uUmVmdXNlZChcInN0YXRlXCIsIHN0YXR1cywgZGF0YSk7XG4gIHByaW50SnNvbihkYXRhKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kVGFpbChzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsIHNpbmNlQXJnOiBudW1iZXIpIHtcbiAgbGV0IHNpbmNlID0gc2luY2VBcmc7XG4gIGxldCBkZWxheSA9IDI1MDtcbiAgbGV0IHN0b3BwZWQgPSBmYWxzZTtcbiAgLy8gUGluIHRoZSBzZXNzaW9uOiByZXNvbHZlIG9uY2UsIHRoZW4gUkVDT05ORUNUIHRvIHRoZSBTQU1FIHNlc3Npb24gb24gZXZlcnlcbiAgLy8gcmV0cnkg4oCUIG5ldmVyIHNpbGVudGx5IGhvcCB0byBhIG5ldyBcIm1vc3QgcmVjZW50XCIgZGFlbW9uLlxuICBsZXQgYm91bmRJZCA9IHNlc3Npb247XG4gIGxldCBncm91bmRlZCA9IGZhbHNlO1xuICBjb25zdCBzdG9wID0gKCkgPT4ge1xuICAgIHN0b3BwZWQgPSB0cnVlO1xuICAgIHByb2Nlc3MuZXhpdCgwKTtcbiAgfTtcbiAgcHJvY2Vzcy5vbihcIlNJR0lOVFwiLCBzdG9wKTtcbiAgcHJvY2Vzcy5vbihcIlNJR1RFUk1cIiwgc3RvcCk7XG5cbiAgd2hpbGUgKCFzdG9wcGVkKSB7XG4gICAgY29uc3QgcyA9IHJlYWRTZXNzaW9uKGJvdW5kSWQpO1xuICAgIGlmICghcykge1xuICAgICAgaWYgKGdyb3VuZGVkKSBwcm9jZXNzLmV4aXQoMCk7IC8vIHBpbm5lZCBzZXNzaW9uIHdlbnQgYXdheSDihpIgZG9uZVxuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXCIjIG5vIHNlc3Npb24geWV0LCByZXRyeWluZ+KAplxcblwiKTtcbiAgICAgIGF3YWl0IHNsZWVwKGRlbGF5KTtcbiAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCA1MDAwKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoIWJvdW5kSWQpIGJvdW5kSWQgPSBzLnNlc3Npb25faWQ7IC8vIHBpbiB0byB0aGUgZmlyc3QgcmVzb2x2ZWQgc2Vzc2lvblxuICAgIGlmICghZ3JvdW5kZWQpIHtcbiAgICAgIGdyb3VuZGVkID0gdHJ1ZTtcbiAgICAgIC8vIGdyb3VuZGluZyBsaW5lIOKAlCBwYXJzZWFibGUgaW4gTW9uaXRvciwgbmFtZXMgdGhlIGJpbmRpbmcgc28gYSB3cm9uZ1xuICAgICAgLy8gc2Vzc2lvbi9wb3J0IGlzIG9idmlvdXMgaW5zdGVhZCBvZiBzaWxlbnQuXG4gICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShcbiAgICAgICAgYCR7SlNPTi5zdHJpbmdpZnkoeyB0eXBlOiBcImdyb3VuZGluZ1wiLCBzZXNzaW9uX2lkOiBzLnNlc3Npb25faWQsIHBvcnQ6IHMucG9ydCB9KX1cXG5gLFxuICAgICAgKTtcbiAgICB9XG4gICAgbGV0IHJlczogUmVzcG9uc2U7XG4gICAgdHJ5IHtcbiAgICAgIHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cy5wb3J0fS9ldmVudHM/c2luY2U9JHtzaW5jZX1gKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIGF3YWl0IHNsZWVwKGRlbGF5KTtcbiAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCA1MDAwKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoIXJlcy5vaykge1xuICAgICAgYXdhaXQgc2xlZXAoZGVsYXkpO1xuICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIDUwMDApO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGRlbGF5ID0gMjUwO1xuICAgIGlmICghcmVzLmJvZHkpIHtcbiAgICAgIGF3YWl0IHNsZWVwKGRlbGF5KTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCByZWFkZXIgPSByZXMuYm9keS5nZXRSZWFkZXIoKTtcbiAgICBjb25zdCBkZWMgPSBuZXcgVGV4dERlY29kZXIoKTtcbiAgICBsZXQgYnVmID0gXCJcIjtcbiAgICB3aGlsZSAodHJ1ZSkge1xuICAgICAgbGV0IGNodW5rOiBSZWFkYWJsZVN0cmVhbVJlYWRSZXN1bHQ8VWludDhBcnJheT47XG4gICAgICB0cnkge1xuICAgICAgICBjaHVuayA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICBpZiAoY2h1bmsuZG9uZSkgYnJlYWs7XG4gICAgICBidWYgKz0gZGVjLmRlY29kZShjaHVuay52YWx1ZSwgeyBzdHJlYW06IHRydWUgfSk7XG4gICAgICBmb3IgKGxldCBzZXAgPSBidWYuaW5kZXhPZihcIlxcblxcblwiKTsgc2VwID49IDA7IHNlcCA9IGJ1Zi5pbmRleE9mKFwiXFxuXFxuXCIpKSB7XG4gICAgICAgIGNvbnN0IGJsb2NrID0gYnVmLnNsaWNlKDAsIHNlcCk7XG4gICAgICAgIGJ1ZiA9IGJ1Zi5zbGljZShzZXAgKyAyKTtcbiAgICAgICAgY29uc3QgZGF0YUxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgICBmb3IgKGNvbnN0IGxpbmUgb2YgYmxvY2suc3BsaXQoXCJcXG5cIikpIHtcbiAgICAgICAgICBpZiAobGluZS5zdGFydHNXaXRoKFwiOlwiKSkge1xuICAgICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXCI6IGdsYW1vdXIta2VlcGFsaXZlXFxuXCIpO1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoXCJkYXRhOlwiKSkgZGF0YUxpbmVzLnB1c2gobGluZS5zbGljZSg1KS50cmltKCkpO1xuICAgICAgICB9XG4gICAgICAgIGlmICghZGF0YUxpbmVzLmxlbmd0aCkgY29udGludWU7XG4gICAgICAgIGNvbnN0IHBheWxvYWQgPSBkYXRhTGluZXMuam9pbihcIlxcblwiKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBldiA9IEpTT04ucGFyc2UocGF5bG9hZCkgYXMgeyBpZD86IG51bWJlcjsgdHlwZT86IHN0cmluZyB9O1xuICAgICAgICAgIGlmICh0eXBlb2YgZXYuaWQgPT09IFwibnVtYmVyXCIgJiYgZXYuaWQgPiBzaW5jZSkgc2luY2UgPSBldi5pZDtcbiAgICAgICAgICBpZiAoZXYudHlwZSA9PT0gXCJjbG9zZWRcIikge1xuICAgICAgICAgICAgLy8gUDBmIOKAlCBTSEFQRSBCOiB0aGUgZHJhaW4gY2FsbGJhY2sgcmlkZXMgVEhJUyB3cml0ZSwgc28gaXQgZmlyZXNcbiAgICAgICAgICAgIC8vIG9uIHRoaXMgd3JpdGUncyBjb21wbGV0aW9uLiBOT1QgYSB0cmFpbGluZyBgd3JpdGUoXCJcIiwgY2IpYCDigJQgYVxuICAgICAgICAgICAgLy8gZHJhaW4gY2FsbGJhY2sgY292ZXJzIG9ubHkgaXRzIG93biB3cml0ZSBhbmQgaXMgbm90IGEgYmFycmllclxuICAgICAgICAgICAgLy8gKG1lYXN1cmVkIGJ5dGUtZm9yLWJ5dGUgYXMgYnJva2VuIGFzIG5vIGZpeCksIGFuZCB0aGF0IGlzIGV4YWN0bHlcbiAgICAgICAgICAgIC8vIHRoZSBoZWxwZXIgdGhpcyB3cml0ZS10aGVuLWV4aXQgc2hhcGUgaW52aXRlcy5cbiAgICAgICAgICAgIC8vXG4gICAgICAgICAgICAvLyBQRVItU0lURSBQUkVDT05ESVRJT04sIHJlYWQgYXQgVEhJUyBzaXRlIHJhdGhlciB0aGFuIGNhcnJpZWQgb3ZlclxuICAgICAgICAgICAgLy8gZnJvbSBhIHNpYmxpbmc6IHRoZSBleGl0IHNpdHMgaW5zaWRlIGB3aGlsZSAoIXN0b3BwZWQpYCAtPlxuICAgICAgICAgICAgLy8gYHdoaWxlICh0cnVlKWAgLT4gdGhlIGZyYW1lIGxvb3AsIHNvIGBwcm9jZXNzLmV4aXRDb2RlYCArIGFcbiAgICAgICAgICAgIC8vIG5hdHVyYWwgcmV0dXJuIChzaGFwZSBEKSBkb2VzIE5PVCBsZWF2ZSB0aGUgdGFpbCDigJQgaXQgZmFsbHNcbiAgICAgICAgICAgIC8vIHRocm91Z2ggYW5kIHRoZSBsb29wcyBnbyByb3VuZCBhZ2Fpbi4gVGhlIGV4cGxpY2l0IGByZXR1cm5gIGlzXG4gICAgICAgICAgICAvLyB3aGF0IGV4aXRzIHRoZSBsb29wczsgdGhlIGNhbGxiYWNrIGlzIHdoYXQgZHJhaW5zLiBCb3RoLCBmb3JcbiAgICAgICAgICAgIC8vIGRpZmZlcmVudCByZWFzb25zLlxuICAgICAgICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7cGF5bG9hZH1cXG5gLCAoKSA9PiBwcm9jZXNzLmV4aXQoMCkpO1xuICAgICAgICAgICAgc3RvcHBlZCA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke3BheWxvYWR9XFxuYCk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIC8qIHNraXAgbWFsZm9ybWVkIGZyYW1lICovXG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgLy8gc3RyZWFtIGVuZGVkIOKAlCBzZXNzaW9uIGxpa2VseSBjbG9zZWQ7IGxvb3Agd2lsbCByZXRyeSBvciBleGl0LlxuICAgIGF3YWl0IHNsZWVwKGRlbGF5KTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjbWRJbmZvKHNlc3Npb24/OiBzdHJpbmcpIHtcbiAgY29uc3QgcyA9IHJlYWRTZXNzaW9uKHNlc3Npb24pO1xuICBpZiAoIXMpIGRpZShcIm5vIHJ1bm5pbmcgZ2xhbW91ciBzZXNzaW9uXCIsIFwibm90X2ZvdW5kXCIsIE5PX1NFU1NJT05fSElOVCk7XG4gIHByaW50SnNvbihzKTtcbn1cblxuLy8gVGhlIHBsdWdpbiBtYW5pZmVzdCBpcyB0aGUgb25lIHZlcnNpb24gc291cmNlOyB0aGUgQ0xJIHJlYWRzIGl0IHJhdGhlciB0aGFuXG4vLyBtaXJyb3JpbmcgdGhlIG51bWJlciAoYXN0cm9sYWJlJ3MgcGF0dGVybiwgdmlhIG1pbmQtbWFwcGVyKS4gTGF5b3V0LWRlcGVuZGVudCxcbi8vIHNvIGFic2VuY2UgZGVncmFkZXMgdG8gXCJ1bmtub3duXCIgaW5zdGVhZCBvZiBpbnZlbnRpbmcgb25lLlxuZnVuY3Rpb24gdmVyc2lvbkluZm8oKTogeyBuYW1lOiBzdHJpbmc7IHZlcnNpb246IHN0cmluZyB9IHtcbiAgdHJ5IHtcbiAgICBjb25zdCByYXcgPSByZWFkRmlsZVN5bmMoam9pbihTS0lMTF9ST09ULCBcIi4uXCIsIFwiLi5cIiwgXCIuY2xhdWRlLXBsdWdpblwiLCBcInBsdWdpbi5qc29uXCIpLCBcInV0ZjhcIik7XG4gICAgY29uc3QgcGtnID0gSlNPTi5wYXJzZShyYXcpIGFzIHsgdmVyc2lvbj86IHVua25vd24gfTtcbiAgICBpZiAodHlwZW9mIHBrZy52ZXJzaW9uID09PSBcInN0cmluZ1wiKSByZXR1cm4geyBuYW1lOiBcImdsYW1vdXJcIiwgdmVyc2lvbjogcGtnLnZlcnNpb24gfTtcbiAgfSBjYXRjaCB7XG4gICAgLyogZmFsbCB0aHJvdWdoIHRvIHVua25vd24gKi9cbiAgfVxuICByZXR1cm4geyBuYW1lOiBcImdsYW1vdXJcIiwgdmVyc2lvbjogXCJ1bmtub3duXCIgfTtcbn1cblxuLy8g4pSA4pSAIFRIRSBDT01NQU5EIFRBQkxFLCBBUyBBIFNUUlVDVFVSRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vXG4vLyBUaGUgZGlzcGF0Y2hlciwgdGhlIHN0YWdlLTIgZmxhZyBjaGVjaywgdGhlIHJlamVjdGlvbnMnIGBjaG9pY2VzYCwgdGhlXG4vLyBoZWxwIHRleHQgYW5kIHRoZSBgc2NoZW1hYCBkZWNsYXJhdGlvbiBhbGwgd2FsayBUSElTLiBJdCByZXBsYWNlZCBhIGJhcmVcbi8vIGBzd2l0Y2hgLCB3aGljaCBvbmx5IHRoZSBkaXNwYXRjaGVyIGNvdWxkIHdhbGsg4oCUIGhlbHAgYW5kIHRoZSBzd2l0Y2ggaGFkXG4vLyBhbHJlYWR5IGRyaWZ0ZWQgb25jZSAodGhlIGBvcGVuYCByb3cgbG9zdCAtLXN0YXJ0LXRpbWVvdXQpIOKAlCBhbmQgYSBzY2hlbWFcbi8vIGVtaXR0ZWQgZnJvbSBhbnl0aGluZyBvdGhlciB0aGFuIHRoZSBzdHJ1Y3R1cmUgdGhhdCByb3V0ZXMgdGhlIGJlaGF2aW91clxuLy8gaXMgYSBkb2N1bWVudCB0aGF0IGxpZXMgYXMgc29vbiBhcyBhbnlvbmUgZWRpdHMgdGhlIG90aGVyIHNpZGUuXG4vL1xuLy8gYGZsYWdzYCBpcyB0aGUgdmVyYidzIE9XTiBhY2NlcHRlZCBzZXQsIHR5cGVkIGFnYWluc3QgdGhlIHJlZ2lzdHJ5LCBzbyBhXG4vLyB2ZXJiIGNhbm5vdCBuYW1lIGEgZmxhZyB0aGUgcGFyc2VyIGRvZXMgbm90IGRlZmluZS4gYHNlc3Npb25gIGlzIGxpc3RlZFxuLy8gcGVyIHZlcmIgcmF0aGVyIHRoYW4gbWVyZ2VkIGFzIGEgZ2xvYmFsOiBgb3BlbmAgc3Bhd25zIGEgc2Vzc2lvbiBpbnN0ZWFkIG9mXG4vLyB0YXJnZXRpbmcgb25lLCBhbmQgYGhlbHBgIHRha2VzIG5vdGhpbmcuXG50eXBlIEZsYWcgPSBrZXlvZiB0eXBlb2YgQ0xJX09QVElPTlM7XG50eXBlIEZsYWdzID0gUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj47XG50eXBlIFBvc2l0aW9uYWxTcGVjID0geyBuYW1lOiBzdHJpbmc7IHJlcXVpcmVkOiBib29sZWFuOyB2YXJpYWRpYz86IGJvb2xlYW4gfTtcbnR5cGUgQ29tbWFuZFNwZWMgPSB7XG4gIG5hbWU6IHN0cmluZztcbiAgZmxhZ3M6IHJlYWRvbmx5IEZsYWdbXTtcbiAgcG9zaXRpb25hbHM6IFBvc2l0aW9uYWxTcGVjW107XG4gIC8vIFRoZSBvbmUtbGluZSBkZXNjcmlwdGlvbiBoZWxwIHByaW50cyBiZXNpZGUgdGhlIHVzYWdlLlxuICBkZXNjcmliZTogc3RyaW5nO1xuICBydW46IChwb3M6IHN0cmluZ1tdLCBmbGFnczogRmxhZ3MsIHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCkgPT4gUHJvbWlzZTx2b2lkPiB8IHZvaWQ7XG59O1xuXG5jb25zdCBTRVNTSU9OID0gW1wic2Vzc2lvblwiXSBhcyBjb25zdCBzYXRpc2ZpZXMgcmVhZG9ubHkgRmxhZ1tdO1xuY29uc3QgUCA9IHtcbiAgdGV4dDogW3sgbmFtZTogXCJ0ZXh0XCIsIHJlcXVpcmVkOiB0cnVlLCB2YXJpYWRpYzogdHJ1ZSB9XSxcbiAgaWQ6IFt7IG5hbWU6IFwiaWRcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gIGlkVGV4dDogW1xuICAgIHsgbmFtZTogXCJpZFwiLCByZXF1aXJlZDogdHJ1ZSB9LFxuICAgIHsgbmFtZTogXCJ0ZXh0XCIsIHJlcXVpcmVkOiB0cnVlLCB2YXJpYWRpYzogdHJ1ZSB9LFxuICBdLFxuICBpZHM6IFt7IG5hbWU6IFwiaWRcIiwgcmVxdWlyZWQ6IHRydWUsIHZhcmlhZGljOiB0cnVlIH1dLFxuICBub25lOiBbXSBhcyBQb3NpdGlvbmFsU3BlY1tdLFxufSBzYXRpc2ZpZXMgUmVjb3JkPHN0cmluZywgUG9zaXRpb25hbFNwZWNbXT47XG5cbmNvbnN0IENPTU1BTkRTOiBDb21tYW5kU3BlY1tdID0gW1xuICB7XG4gICAgbmFtZTogXCJvcGVuXCIsXG4gICAgZmxhZ3M6IFtcInRpdGxlXCIsIFwiaW50ZW50XCIsIFwibm8tb3BlblwiLCBcInRpbWVvdXRcIiwgXCJzdGFydC10aW1lb3V0XCIsIFwicmVzdG9yZVwiXSxcbiAgICBwb3NpdGlvbmFsczogUC5ub25lLFxuICAgIGRlc2NyaWJlOiBcInNwYXduIGEgc2Vzc2lvbiAob3BlbnMgdGhlIGJyb3dzZXIpOyBwcmludHMge3VybCwgcG9ydCwgc2Vzc2lvbl9pZH1cIixcbiAgICBydW46IChfcG9zLCBmbGFncykgPT4gY21kT3BlbihmbGFncyksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInRhaWxcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwic2luY2VcIl0sXG4gICAgcG9zaXRpb25hbHM6IFAubm9uZSxcbiAgICBkZXNjcmliZTogXCJTU0UgdXNlciBldmVudHMg4oaSIEpTT05MICh3cmFwIHdpdGggTW9uaXRvcjsgd2FpdHMgZm9yIGEgc2Vzc2lvbiwgbmV2ZXIgZXhpdHMgNSlcIixcbiAgICBydW46IChfcG9zLCBmbGFncywgc2Vzc2lvbikgPT5cbiAgICAgIGNtZFRhaWwoc2Vzc2lvbiwgdHlwZW9mIGZsYWdzLnNpbmNlID09PSBcInN0cmluZ1wiID8gTnVtYmVyLnBhcnNlSW50KGZsYWdzLnNpbmNlLCAxMCkgOiAtMSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInN0YXRlXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcImZ1bGxcIl0sXG4gICAgcG9zaXRpb25hbHM6IFAubm9uZSxcbiAgICBkZXNjcmliZTogXCJsZWFuIHN0YXRlIHNuYXBzaG90ICgtLWZ1bGwgZm9yIHJhdyBpbmNsLiBiYXNlNjQpXCIsXG4gICAgcnVuOiAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IGNtZFN0YXRlKHNlc3Npb24sIGZsYWdzLmZ1bGwgPT09IHRydWUpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJpbnRlbnRcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogUC50ZXh0LFxuICAgIGRlc2NyaWJlOiBcInVwZGF0ZSB0aGUgc2Vzc2lvbiBpbnRlbnRcIixcbiAgICBydW46IChwb3MsIF9mbGFncywgc2Vzc2lvbikgPT4gcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwiaW50ZW50XCIsIHRleHQ6IHBvcy5qb2luKFwiIFwiKSB9KSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiYW5ub3RhdGVcIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogUC5pZFRleHQsXG4gICAgZGVzY3JpYmU6IFwid3JpdGUgYWdlbnQgYW5ub3RhdGlvbiBvbnRvIGEgbGlicmFyeSBpdGVtXCIsXG4gICAgcnVuOiAocG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGNvbnN0IFtpZCwgLi4ud29yZHNdID0gcG9zO1xuICAgICAgcmV0dXJuIHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcIml0ZW0uYW5ub3RhdGVcIiwgaWQsIGFnZW50OiB3b3Jkcy5qb2luKFwiIFwiKSB9KTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzYXlcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwia2luZFwiXSxcbiAgICBwb3NpdGlvbmFsczogUC50ZXh0LFxuICAgIGRlc2NyaWJlOiBcInBvc3QgYWdlbnQgZGlhbG9ndWUgaW50byB0aGUgY29udmVyc2F0aW9uICgtLWtpbmQgaW5mb3x3b3JraW5nfHJlc3VsdHxlcnJvcilcIixcbiAgICBydW46IChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiBwb3N0Q21kKHNlc3Npb24sIGJ1aWxkU2F5Q21kKHBvcywgZmxhZ3MpKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic2VjdGlvblwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJzdGF0dXNcIiwgXCJjb250ZW50XCIsIFwicHJvbXB0c1wiLCBcImNvbG9yc1wiXSxcbiAgICBwb3NpdGlvbmFsczogW3sgbmFtZTogXCJrZXlcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgZGVzY3JpYmU6ICdzaGFwZSBhIHN0eWxlLWd1aWRlIHNlY3Rpb24gKC0tcHJvbXB0cyBhfHxiOyAtLWNvbG9ycyBcIiNoZXg6TmFtZXx8I2hleDpOYW1lXCIpJyxcbiAgICBydW46IChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiBwb3N0Q21kKHNlc3Npb24sIGJ1aWxkU2VjdGlvbkNtZChwb3MsIGZsYWdzKSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcInN0YXR1c1wiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbXG4gICAgICB7IG5hbWU6IFwib258b2ZmXCIsIHJlcXVpcmVkOiB0cnVlIH0sXG4gICAgICB7IG5hbWU6IFwidGV4dFwiLCByZXF1aXJlZDogZmFsc2UsIHZhcmlhZGljOiB0cnVlIH0sXG4gICAgXSxcbiAgICBkZXNjcmliZTogXCJzaG93L2hpZGUgdGhlIHdvcmtpbmcgc3Bpbm5lclwiLFxuICAgIHJ1bjogKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBvbiA9IHBvc1swXSA9PT0gXCJvblwiO1xuICAgICAgY29uc3QgdGV4dCA9IHBvcy5zbGljZSgxKS5qb2luKFwiIFwiKSB8fCB1bmRlZmluZWQ7XG4gICAgICByZXR1cm4gcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwic3RhdHVzXCIsIGJ1c3k6IG9uLCAuLi4odGV4dCA/IHsgdGV4dCB9IDoge30pIH0pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImdlblwiLFxuICAgIGZsYWdzOiBbXG4gICAgICAuLi5TRVNTSU9OLFxuICAgICAgXCJ1cmxcIixcbiAgICAgIFwiZmlsZVwiLFxuICAgICAgXCJzcmNcIixcbiAgICAgIFwicHJvbXB0XCIsXG4gICAgICBcIm1vZGVsXCIsXG4gICAgICBcInJvdW5kXCIsXG4gICAgICBcInNlZWRcIixcbiAgICAgIFwiY29zdFwiLFxuICAgICAgXCJsYWJlbFwiLFxuICAgICAgXCJjdXN0b21cIixcbiAgICBdLFxuICAgIHBvc2l0aW9uYWxzOiBQLm5vbmUsXG4gICAgZGVzY3JpYmU6XG4gICAgICBcInBvc3QgYSBnZW5lcmF0ZWQgaW1hZ2UgKG9uZSBvZiAtLXVybHwtLWZpbGV8LS1zcmMsIGFuZCAtLXByb21wdCAtLW1vZGVsIC0tcm91bmQgcmVxdWlyZWQpXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGlmICghZmxhZ3MucHJvbXB0IHx8ICFmbGFncy5tb2RlbCB8fCAhZmxhZ3Mucm91bmQpXG4gICAgICAgIGRpZShcbiAgICAgICAgICBgdXNhZ2U6ICR7dXNhZ2VPZihmaW5kQ29tbWFuZChcImdlblwiKSBhcyBDb21tYW5kU3BlYyl9IOKAlCAtLXByb21wdCwgLS1tb2RlbCBhbmQgLS1yb3VuZCBhcmUgcmVxdWlyZWRgLFxuICAgICAgICApO1xuICAgICAgY29uc3Qgc3JjID0gYXdhaXQgcmVzb2x2ZUdlblNyYyhmbGFncyk7XG4gICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIGJ1aWxkR2VuQ21kKHNyYywgZmxhZ3MpKTtcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJnZW4tY29zdFwiLFxuICAgIGZsYWdzOiBbLi4uU0VTU0lPTiwgXCJjb3N0XCJdLFxuICAgIHBvc2l0aW9uYWxzOiBQLmlkLFxuICAgIGRlc2NyaWJlOiBcImJhY2tmaWxsIGEgZ2VuZXJhdGVkIGltYWdlJ3MgY29zdCAoLS1jb3N0IDxuPiByZXF1aXJlZClcIixcbiAgICBydW46IChwb3MsIGZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBjb3N0ID0gdHlwZW9mIGZsYWdzLmNvc3QgPT09IFwic3RyaW5nXCIgPyBOdW1iZXIucGFyc2VGbG9hdChmbGFncy5jb3N0KSA6IE51bWJlci5OYU47XG4gICAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShjb3N0KSlcbiAgICAgICAgZGllKGB1c2FnZTogJHt1c2FnZU9mKGZpbmRDb21tYW5kKFwiZ2VuLWNvc3RcIikgYXMgQ29tbWFuZFNwZWMpfSDigJQgLS1jb3N0IG11c3QgYmUgYSBudW1iZXJgKTtcbiAgICAgIHJldHVybiBwb3N0Q21kKHNlc3Npb24sIGJ1aWxkR2VuQ29zdENtZChwb3MsIGZsYWdzKSk7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwiZ2VuLW1ldGFcIixcbiAgICBmbGFnczogWy4uLlNFU1NJT04sIFwicHJvbXB0XCIsIFwiY3VzdG9tXCJdLFxuICAgIHBvc2l0aW9uYWxzOiBQLmlkLFxuICAgIGRlc2NyaWJlOiBcImJhY2tmaWxsIHRoZSByZWFsIHByb21wdCAvIHJlZnMgb250byBhIGdlbiAoLS1wcm9tcHQgYW5kL29yIC0tY3VzdG9tKVwiLFxuICAgIHJ1bjogKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHtcbiAgICAgIGlmIChmbGFncy5wcm9tcHQgPT09IHVuZGVmaW5lZCAmJiBmbGFncy5jdXN0b20gPT09IHVuZGVmaW5lZClcbiAgICAgICAgZGllKFxuICAgICAgICAgIGB1c2FnZTogJHt1c2FnZU9mKGZpbmRDb21tYW5kKFwiZ2VuLW1ldGFcIikgYXMgQ29tbWFuZFNwZWMpfSDigJQgZ2l2ZSAtLXByb21wdCBvciAtLWN1c3RvbWAsXG4gICAgICAgICk7XG4gICAgICByZXR1cm4gcG9zdENtZChzZXNzaW9uLCBidWlsZEdlbk1ldGFDbWQocG9zLCBmbGFncykpO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImZvY3VzXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcIm5vdGVcIl0sXG4gICAgcG9zaXRpb25hbHM6IFAuaWRzLFxuICAgIGRlc2NyaWJlOiBcInNjb3BlIHRoZSBmb2N1cyBsZW5zIHRvIHRoZXNlIGl0ZW1zICgrIC0tbm90ZSB0byBhc2spXCIsXG4gICAgcnVuOiAocG9zLCBmbGFncywgc2Vzc2lvbikgPT4gcG9zdENtZChzZXNzaW9uLCBidWlsZEZvY3VzQ21kKHBvcywgZmxhZ3MpKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic3R5bGUtc2F2ZVwiLFxuICAgIGZsYWdzOiBTRVNTSU9OLFxuICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcImxhYmVsXCIsIHJlcXVpcmVkOiB0cnVlLCB2YXJpYWRpYzogdHJ1ZSB9XSxcbiAgICBkZXNjcmliZTogXCJjb2RpZnkgdGhlIGN1cnJlbnQgc3R5bGUg4oaSIHByb2plY3QgdHJheVwiLFxuICAgIHJ1bjogKHBvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiBwb3N0Q21kKHNlc3Npb24sIGJ1aWxkU3R5bGVTYXZlQ21kKHBvcykpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJzdHlsZS1hcmNoaXZlXCIsXG4gICAgZmxhZ3M6IFsuLi5TRVNTSU9OLCBcInVuYXJjaGl2ZVwiXSxcbiAgICBwb3NpdGlvbmFsczogUC5pZCxcbiAgICBkZXNjcmliZTogXCJhcmNoaXZlIChvciAtLXVuYXJjaGl2ZSkgYSBzYXZlZCBzdHlsZVwiLFxuICAgIHJ1bjogKHBvcywgZmxhZ3MsIHNlc3Npb24pID0+IHBvc3RDbWQoc2Vzc2lvbiwgYnVpbGRTdHlsZUFyY2hpdmVDbWQocG9zLCBmbGFncykpLFxuICB9LFxuICB7XG4gICAgbmFtZTogXCJ0cmF5XCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFAubm9uZSxcbiAgICBkZXNjcmliZTogXCJsaXN0IHRoZSBwcm9qZWN0J3Mgc2F2ZWQgc3R5bGVzXCIsXG4gICAgcnVuOiBhc3luYyAoX3BvcywgX2ZsYWdzLCBzZXNzaW9uKSA9PiB7XG4gICAgICBjb25zdCBzID0gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbik7XG4gICAgICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpKHMucG9ydCwgXCJHRVRcIiwgXCIvc3RhdGU/bGVhbj0xXCIpO1xuICAgICAgaWYgKHN0YXR1cyAhPT0gMjAwKSBkYWVtb25SZWZ1c2VkKFwidHJheVwiLCBzdGF0dXMsIGRhdGEpO1xuICAgICAgcHJpbnRKc29uKChkYXRhIGFzIHsgc3RhdGU/OiB7IHRyYXk/OiB1bmtub3duW10gfSB9KT8uc3RhdGU/LnRyYXkgPz8gW10pO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImNsb3NlXCIsXG4gICAgZmxhZ3M6IFNFU1NJT04sXG4gICAgcG9zaXRpb25hbHM6IFAubm9uZSxcbiAgICBkZXNjcmliZTogXCJzaHV0IGRvd24gdGhlIHNlc3Npb25cIixcbiAgICBydW46IChfcG9zLCBfZmxhZ3MsIHNlc3Npb24pID0+IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcImNsb3NlXCIgfSksXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImluZm9cIixcbiAgICBmbGFnczogU0VTU0lPTixcbiAgICBwb3NpdGlvbmFsczogUC5ub25lLFxuICAgIGRlc2NyaWJlOiBcInByaW50IHRoZSByZXNvbHZlZCBkaXNjb3ZlcnkgSlNPTlwiLFxuICAgIHJ1bjogKF9wb3MsIF9mbGFncywgc2Vzc2lvbikgPT4gY21kSW5mbyhzZXNzaW9uKSxcbiAgfSxcbiAge1xuICAgIG5hbWU6IFwic2NoZW1hXCIsXG4gICAgZmxhZ3M6IFtdLFxuICAgIHBvc2l0aW9uYWxzOiBQLm5vbmUsXG4gICAgZGVzY3JpYmU6IFwiZW1pdCB0aGlzIENMSSdzIGFjYyBkZWNsYXJhdGlvbiAod2Fsa2VkIGZyb20gdGhlIGNvbW1hbmQgdGFibGUpXCIsXG4gICAgcnVuOiAoKSA9PiB7XG4gICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeShidWlsZERlY2xhcmF0aW9uKCksIG51bGwsIDIpfVxcbmApO1xuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiBcImhlbHBcIixcbiAgICBmbGFnczogW10sXG4gICAgcG9zaXRpb25hbHM6IFAubm9uZSxcbiAgICBkZXNjcmliZTogXCJzaG93IHRoaXMgbWVzc2FnZVwiLFxuICAgIHJ1bjogKCkgPT4ge1xuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7cmVuZGVySGVscCgpfVxcbmApO1xuICAgIH0sXG4gIH0sXG5dO1xuXG4vLyBSb290IGludGVyY2VwdG9ycyDigJQgdG9rZW5zIHRoZSBST09UIGFuc3dlcnMgaXRzZWxmLCBiZWZvcmUgYW55IHZlcmIuIE5vdFxuLy8gY29tbWFuZHMgYW5kIG5vdCByZWdpc3RyeSBmbGFncywgc28gdGhleSBhcmUgZGVjbGFyZWQgZXhwbGljaXRseSBhdFxuLy8gcGF0aCBbXSByYXRoZXIgdGhhbiB3YWxrZWQgcGFzdC5cbmNvbnN0IFJPT1RfSU5URVJDRVBUT1JTID0gW1xuICB7IG5hbWU6IFwiLS1oZWxwXCIsIHJ1bnM6IFwiaGVscFwiIH0sXG4gIHsgbmFtZTogXCItaFwiLCBydW5zOiBcImhlbHBcIiB9LFxuICB7IG5hbWU6IFwiLS12ZXJzaW9uXCIsIHJ1bnM6IFwidmVyc2lvblwiIH0sXG4gIHsgbmFtZTogXCItVlwiLCBydW5zOiBcInZlcnNpb25cIiB9LFxuXSBhcyBjb25zdDtcblxuY29uc3QgZmluZENvbW1hbmQgPSAodG9rZW46IHN0cmluZyk6IENvbW1hbmRTcGVjIHwgdW5kZWZpbmVkID0+XG4gIENPTU1BTkRTLmZpbmQoKGMpID0+IGMubmFtZSA9PT0gdG9rZW4pO1xuXG4vLyBUaGUgdmVyYiB0b2tlbiBpbiBhIHJhdyBhcmd2LCBmb3VuZCB0aGUgd2F5IHRoZSBwYXJzZXIgd2lsbCBmaW5kIGl0OiBhXG4vLyBzdHJpbmcgZmxhZyBDT05TVU1FUyB0aGUgbmV4dCB0b2tlbiAoYC0tc2Vzc2lvbiBhYmMgc2F5YCDihpIgXCJzYXlcIiwgbm90XG4vLyBcImFiY1wiKSwgYC0ta2V5PXZhbHVlYCBjb25zdW1lcyBub3RoaW5nLCBhIGJhcmUgYC0tYCBlbmRzIGZsYWcgcGFyc2luZywgYW5kXG4vLyB0aGUgZmlyc3QgdG9rZW4gbGVmdCBzdGFuZGluZyBpcyB0aGUgdmVyYi4gVXNlZCBvbmx5IHRvIG5hbWUgdGhlIHZlcmIgb24gYVxuLy8gcmVqZWN0aW9uIHJhaXNlZCBCRUZPUkUgdGhlIHBhcnNlIHN1Y2NlZWRzIChhIHN0cmF5IGZsYWcpIOKAlCB0aGUgcGFyc2UncyBvd25cbi8vIHBvc2l0aW9uYWxzIGFyZSB0aGUgdHJ1dGggYWZ0ZXJ3YXJkcy4gQSBuYWl2ZSBcImZpcnN0IG5vbi1kYXNoIHRva2VuXCIgd2FzXG4vLyB0aGUgcmV2aWV3J3MgZmluZGluZzogaXQgbmFtZWQgYSBmbGFnJ3MgdmFsdWUgYXMgdGhlIHZlcmIuXG5leHBvcnQgZnVuY3Rpb24gdmVyYlRva2VuKGFyZ3Y6IHN0cmluZ1tdKTogc3RyaW5nIHwgbnVsbCB7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgYXJndi5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGEgPSBhcmd2W2ldIGFzIHN0cmluZztcbiAgICBpZiAoYSA9PT0gXCItLVwiKSByZXR1cm4gYXJndltpICsgMV0gPz8gbnVsbDtcbiAgICBpZiAoYS5zdGFydHNXaXRoKFwiLS1cIikpIHtcbiAgICAgIGlmIChhLmluY2x1ZGVzKFwiPVwiKSkgY29udGludWU7XG4gICAgICBjb25zdCBrZXkgPSBhLnNsaWNlKDIpIGFzIGtleW9mIHR5cGVvZiBDTElfT1BUSU9OUztcbiAgICAgIGlmIChrZXkgaW4gQ0xJX09QVElPTlMgJiYgQ0xJX09QVElPTlNba2V5XS50eXBlID09PSBcInN0cmluZ1wiKSBpKys7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGEuc3RhcnRzV2l0aChcIi1cIikpIGNvbnRpbnVlO1xuICAgIHJldHVybiBhO1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG4vLyBUaGUgZGVyaXZlZCB2aWV3cyB0aGUgdGVzdHMgYW5kIHRoZSByZWplY3Rpb25zIHJlYWQuIFZFUkJTIGlzIHRoZSByb3N0ZXI7XG4vLyBWRVJCX1NQRUMgaXMgZWFjaCB2ZXJiJ3MgYWNjZXB0ZWQgZmxhZ3M7IGZsYWdzRm9yIHJlbmRlcnMgb25lIHJvdyBhcyB0aGVcbi8vIGBjaG9pY2VzYCBhIHJlamVjdGlvbiBjYXJyaWVzLlxuZXhwb3J0IGNvbnN0IFZFUkJTOiByZWFkb25seSBzdHJpbmdbXSA9IENPTU1BTkRTLm1hcCgoYykgPT4gYy5uYW1lKTtcbmV4cG9ydCBjb25zdCBWRVJCX1NQRUM6IFJlY29yZDxzdHJpbmcsIHJlYWRvbmx5IEZsYWdbXT4gPSBPYmplY3QuZnJvbUVudHJpZXMoXG4gIENPTU1BTkRTLm1hcCgoYykgPT4gW2MubmFtZSwgYy5mbGFnc10pLFxuKTtcbmV4cG9ydCBjb25zdCBmbGFnc0ZvciA9ICh2ZXJiOiBzdHJpbmcpOiBzdHJpbmdbXSA9PlxuICBbLi4uKGZpbmRDb21tYW5kKHZlcmIpPy5mbGFncyA/PyBbXSldLm1hcCgoaykgPT4gYC0tJHtrfWApLnNvcnQoKTtcblxuLy8g4pSA4pSAIGhlbHAgYW5kIHRoZSBkZWNsYXJhdGlvbiwgYm90aCB3YWxrZWQgZnJvbSBDT01NQU5EUyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuY29uc3QgcmVuZGVyRmxhZyA9IChrOiBGbGFnKTogc3RyaW5nID0+XG4gIENMSV9PUFRJT05TW2tdLnR5cGUgPT09IFwiYm9vbGVhblwiID8gYFstLSR7a31dYCA6IGBbLS0ke2t9IC4uXWA7XG5cbmNvbnN0IHJlbmRlclBvc2l0aW9uYWwgPSAocDogUG9zaXRpb25hbFNwZWMpOiBzdHJpbmcgPT4ge1xuICBjb25zdCBpbm5lciA9IHAudmFyaWFkaWMgPyBgJHtwLm5hbWV9Li4uYCA6IHAubmFtZTtcbiAgcmV0dXJuIHAucmVxdWlyZWQgPyBgPCR7aW5uZXJ9PmAgOiBgWyR7aW5uZXJ9XWA7XG59O1xuXG4vLyBUaGUgdXNhZ2UgbGluZTogdmVyYiwgcG9zaXRpb25hbHMsIHRoZW4gdGhlIHZlcmIncyBvd24gZmxhZ3MgKHNlc3Npb24gaXNcbi8vIHJlbmRlcmVkIG9uY2UgaW4gdGhlIGZvb3Rlciwgbm90IG9uIGV2ZXJ5IHJvdykuXG5leHBvcnQgZnVuY3Rpb24gdXNhZ2VPZihzcGVjOiBDb21tYW5kU3BlYyk6IHN0cmluZyB7XG4gIGNvbnN0IHBhcnRzID0gW1xuICAgIHNwZWMubmFtZSxcbiAgICAuLi5zcGVjLnBvc2l0aW9uYWxzLm1hcChyZW5kZXJQb3NpdGlvbmFsKSxcbiAgICAuLi5zcGVjLmZsYWdzLmZpbHRlcigoaykgPT4gayAhPT0gXCJzZXNzaW9uXCIpLm1hcChyZW5kZXJGbGFnKSxcbiAgXTtcbiAgcmV0dXJuIHBhcnRzLmpvaW4oXCIgXCIpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVySGVscCgpOiBzdHJpbmcge1xuICBjb25zdCByb3dzID0gQ09NTUFORFMubWFwKChjKSA9PiBbdXNhZ2VPZihjKSwgYy5kZXNjcmliZV0gYXMgY29uc3QpO1xuICBjb25zdCB3aWR0aCA9IE1hdGgubWluKE1hdGgubWF4KC4uLnJvd3MubWFwKChbdV0pID0+IHUubGVuZ3RoKSksIDQ0KTtcbiAgY29uc3QgYm9keSA9IHJvd3NcbiAgICAubWFwKChbdXNhZ2UsIGRlc2NyaWJlXSkgPT5cbiAgICAgIHVzYWdlLmxlbmd0aCA8PSB3aWR0aFxuICAgICAgICA/IGAgICR7dXNhZ2UucGFkRW5kKHdpZHRoKX0gICR7ZGVzY3JpYmV9YFxuICAgICAgICA6IGAgICR7dXNhZ2V9XFxuICAke1wiXCIucGFkRW5kKHdpZHRoKX0gICR7ZGVzY3JpYmV9YCxcbiAgICApXG4gICAgLmpvaW4oXCJcXG5cIik7XG4gIHJldHVybiBgZ2xhbW91ciDigJQgYSBncm91bmRlZCB2aXN1YWwgY29udmVyc2F0aW9uIHN1cmZhY2UuXG5cbiR7Ym9keX1cbiAgJHtST09UX0lOVEVSQ0VQVE9SUy5tYXAoKGkpID0+IGkubmFtZSkuam9pbihcIiB8IFwiKX0gIHJvb3QgdG9rZW5zOiBoZWxwLCBvciB7bmFtZSwgdmVyc2lvbn0gYXMgSlNPTlxuXG4gIEFkZCAtLXNlc3Npb24gPGlkPiB0byBhbnkgdmVyYiB0aGF0IHRhbGtzIHRvIGEgc2Vzc2lvbiAoZGVmYXVsdDogbW9zdCByZWNlbnQpLlxuICBFYWNoIHZlcmIgYWNjZXB0cyBvbmx5IHRoZSBmbGFncyBvbiBpdHMgcm93OyBhIHJlY29nbml6ZWQgZmxhZyBvbiB0aGUgd3JvbmdcbiAgdmVyYiBpcyByZWZ1c2VkLCBhbmQgdGhlIHJlamVjdGlvbiBsaXN0cyB0aGUgdmVyYidzIG93biBmbGFncy5cblxuICBPdXRwdXQ6IGV2ZXJ5IHZlcmIgcHJpbnRzIEpTT04gb24gc3Rkb3V0IGJ5IGRlZmF1bHQsIG9uZSBkb2N1bWVudCBwZXIgYW5zd2VyIOKAlFxuICBleGNlcHQgdGFpbCwgYSBzdHJlYW0gdGhhdCBwcmludHMgb25lIEpTT04gbGluZSBwZXIgZXZlbnQsIGFuZCBoZWxwLCB3aGljaCBpc1xuICBwcm9zZS4gRmFpbHVyZXMgYXJlIG9uZSBKU09OIGVudmVsb3BlIG9uIHN0ZGVyciBhbmQgZXhpdCBub24temVybyAoMiA9IHVzYWdlLFxuICAxID0gaW50ZXJuYWwsIDUgPSBub3QgZm91bmQsIDYgPSBjb25mbGljdCkg4oCUIGV4Y2VwdCB0YWlsLCB3aGljaCB3YWl0cyBmb3IgYVxuICBzZXNzaW9uIGluc3RlYWQgb2YgZmFpbGluZyBhbmQgd3JpdGVzIGl0cyByZXRyeS9rZWVwYWxpdmUgbm90ZXMgdG8gc3RkZXJyIGFzXG4gICcjJy1wcmVmaXhlZCBwcm9zZS5gO1xufVxuXG4vLyBhY2MgZGVjbGFyYXRpb24gZm9ybWF0IHYwLCBnZW5lcmF0ZWQgYnkgV0FMS0lORyBDT01NQU5EUyBhbmQgQ0xJX09QVElPTlMg4oCUXG4vLyB0aGUgc2FtZSBzdHJ1Y3R1cmVzIHRoZSBwYXJzZXIgYW5kIGRpc3BhdGNoZXIgY29uc3VtZSDigJQgYXQgYW5zd2VyIHRpbWUsIHNvXG4vLyBgcHJvdmVuYW5jZTogXCJlbWl0dGVkXCJgIGlzIHRydWUgcmF0aGVyIHRoYW4gY2xhaW1lZC4gUGlwZXMgc3RyYWlnaHQgaW50b1xuLy8gYGFjYyBjaGVjayA8Y2xpLnRzPiAtLWRlY2xhcmF0aW9uIDwoY2xpLnRzIHNjaGVtYSlgLlxuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkRGVjbGFyYXRpb24oKSB7XG4gIC8vIEV2ZXJ5IHJlZ2lzdHJ5IGZsYWcgaXMgYWNjZXB0ZWQgdG9kYXk7IGEgcmVmdXNhbCBsaXN0IHdvdWxkIGFkZFxuICAvLyBzdGF0dXM6IFwicmVmdXNlZFwiIGVudHJpZXMgaGVyZSB0aGUgZGF5IGEgdmVyYiByZWNvZ25pc2VzLWFuZC1kZWNsaW5lcyBvbmUuXG4gIGNvbnN0IGFyZyA9IChrOiBGbGFnKSA9PiAoeyBuYW1lOiBgLS0ke2t9YCwgdHlwZTogQ0xJX09QVElPTlNba10udHlwZSwgc3RhdHVzOiBcInZhbGlkXCIgfSk7XG4gIGNvbnN0IGNvbW1hbmRzOiB7XG4gICAgcGF0aDogc3RyaW5nW107XG4gICAgYXJnczogeyBuYW1lOiBzdHJpbmc7IHR5cGU6IFwic3RyaW5nXCIgfCBcImJvb2xlYW5cIjsgc3RhdHVzOiBzdHJpbmcgfVtdO1xuICAgIHBvc2l0aW9uYWxzOiBQb3NpdGlvbmFsU3BlY1tdO1xuICB9W10gPSBbXG4gICAge1xuICAgICAgLy8gcGF0aCBbXSBJUyB0aGUgcm9vdDogb25lIHJlcXVpcmVkIHRva2VuIHNlbGVjdGluZyBhIHZlcmIsIG9yIGFuXG4gICAgICAvLyBpbnRlcmNlcHRvciB0aGUgcm9vdCBhbnN3ZXJzIGl0c2VsZi5cbiAgICAgIHBhdGg6IFtdLFxuICAgICAgYXJnczogUk9PVF9JTlRFUkNFUFRPUlMubWFwKChpKSA9PiAoe1xuICAgICAgICBuYW1lOiBpLm5hbWUsXG4gICAgICAgIHR5cGU6IFwiYm9vbGVhblwiIGFzIGNvbnN0LFxuICAgICAgICBzdGF0dXM6IFwidmFsaWRcIixcbiAgICAgIH0pKSxcbiAgICAgIHBvc2l0aW9uYWxzOiBbeyBuYW1lOiBcInZlcmJcIiwgcmVxdWlyZWQ6IHRydWUgfV0sXG4gICAgfSxcbiAgICAuLi5DT01NQU5EUy5tYXAoKGMpID0+ICh7XG4gICAgICBwYXRoOiBbYy5uYW1lXSxcbiAgICAgIGFyZ3M6IFsuLi5jLmZsYWdzXS5tYXAoYXJnKSxcbiAgICAgIHBvc2l0aW9uYWxzOiBjLnBvc2l0aW9uYWxzLFxuICAgIH0pKSxcbiAgXTtcbiAgcmV0dXJuIHtcbiAgICBmb3JtYXRWZXJzaW9uOiBcIjBcIixcbiAgICBwcm92ZW5hbmNlOiBcImVtaXR0ZWRcIixcbiAgICBzZWxmRGVzY3JpcHRpb246IHsgYXJnczogW1wic2NoZW1hXCJdIH0sXG4gICAgY29tbWFuZHMsXG4gIH07XG59XG5cbi8vIEV2ZXJ5IGZhaWx1cmUgZnVubmVscyB0aHJvdWdoIGhlcmUgYW5kIFJFVFVSTlMgaXRzIGNvZGUsIHNvIHRoZSBydW50aW1lXG4vLyBkcmFpbnMgc3Rkb3V0LiBVbmNhdWdodCwgYSBmYWlsdXJlIHdvdWxkIHN1cmZhY2UgYXMgYSByYXcgc3RhY2sgdHJhY2UgYXQgZXhpdFxuLy8gMSwgd2hpY2ggaXMgbm90IGEgdXNhZ2UgZXJyb3IgdG8gYW55b25lIHJlYWRpbmcgaXQuXG5hc3luYyBmdW5jdGlvbiBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gYXdhaXQgZGlzcGF0Y2goYXJndik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBpZiAoZSBpbnN0YW5jZW9mIENsaUVycm9yKSByZXR1cm4gd3JpdGVFbnZlbG9wZShlKTtcbiAgICBjb25zdCBjb2RlID1cbiAgICAgIGUgJiYgdHlwZW9mIGUgPT09IFwib2JqZWN0XCIgJiYgXCJjb2RlXCIgaW4gZSA/IFN0cmluZygoZSBhcyB7IGNvZGU6IHVua25vd24gfSkuY29kZSkgOiBcIlwiO1xuICAgIGNvbnN0IG1zZyA9IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKTtcbiAgICAvLyBBIG5hbWVkIGZpbGUgdGhhdCBpcyBub3QgdGhlcmUgKC0tZmlsZSBwYXRocykg4oCUIHRoZSBjYWxsZXIncy5cbiAgICBpZiAoY29kZSA9PT0gXCJFTk9FTlRcIikgcmV0dXJuIHdyaXRlRW52ZWxvcGUobmV3IFVzYWdlRXJyb3IobXNnKSk7XG4gICAgLy8gRXZlcnl0aGluZyBlbHNlIGlzIGdsYW1vdXIncyBvd24gZmF1bHQ6IG9uZSBJTlRFUk5BTCBlbnZlbG9wZSwgbmV2ZXIgYVxuICAgIC8vIHN0YWNrIHRyYWNlIOKAlCB0aGUgcHJvY2VzcyBjb250cmFjdCBpcyBKU09OIG9uIHN0ZGVyciBmb3IgRVZFUlkgZmFpbHVyZS5cbiAgICByZXR1cm4gd3JpdGVFbnZlbG9wZShuZXcgQ2xpRXJyb3IoXCJpbnRlcm5hbFwiLCBtc2cpKTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBkaXNwYXRjaChhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIC8vIFJPT1QgSU5URVJDRVBUT1JTIEZJUlNULCBiZWZvcmUgYW55IGZsYWcgcGFyc2luZyAobWFncGllL2FzdHJvbGFiZVxuICAvLyBwYXR0ZXJuKS4gVGhleSBhcmUgbm90IGNvbW1hbmRzIGFuZCBub3QgcmVnaXN0cnkgZmxhZ3Mg4oCUIGBzdGF0ZSAtLXZlcnNpb25gXG4gIC8vIHN0YXlzIHJlZnVzZWQg4oCUIHdoaWNoIGlzIHdoeSB0aGV5IGFyZSBkZWNsYXJlZCBleHBsaWNpdGx5IGF0IHBhdGggW10gYW5kXG4gIC8vIHdoeSBhIGdlbmVyYXRvciB3YWxraW5nIFwidGhlIGNvbW1hbmRzXCIgd291bGQgd2FsayBwYXN0IHRoZW0uXG4gIGNvbnN0IGludGVyY2VwdG9yID0gUk9PVF9JTlRFUkNFUFRPUlMuZmluZCgoaSkgPT4gaS5uYW1lID09PSBhcmd2WzBdKTtcbiAgaWYgKGludGVyY2VwdG9yICE9PSB1bmRlZmluZWQgfHwgYXJndlswXSA9PT0gXCJ2ZXJzaW9uXCIpIHtcbiAgICBjb25zdCBydW5zID0gaW50ZXJjZXB0b3I/LnJ1bnMgPz8gXCJ2ZXJzaW9uXCI7XG4gICAgaWYgKHJ1bnMgPT09IFwiaGVscFwiKSBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtyZW5kZXJIZWxwKCl9XFxuYCk7XG4gICAgZWxzZSBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeSh2ZXJzaW9uSW5mbygpKX1cXG5gKTtcbiAgICByZXR1cm4gMDtcbiAgfVxuXG4gIC8vIFRoZSBXSE9MRSBhcmd2IGlzIHBhcnNlZCwgdmVyYiBpbmNsdWRlZCwgc28gYSBiYXJlIGAtLWAgaXMgaG9ub3VyZWQgYXRcbiAgLy8gdGhlIHJvb3QgKGFjYyBBNik6IGAtLSAtLXhgIHlpZWxkcyB0aGUgcG9zaXRpb25hbCBcIi0teFwiLCB3aGljaCBpcyB0aGVuIGFuXG4gIC8vIHVua25vd24gdmVyYiDigJQgbm90IGFuIHVua25vd24gb3B0aW9uLlxuICAvLyBOYW1lIHRoZSB2ZXJiIEJFRk9SRSBwYXJzaW5nLCBzbyBhIHBhcnNlciByZWplY3Rpb24ncyBlbnZlbG9wZSBzdGlsbCBzYXlzXG4gIC8vIHdoYXQgd2FzIGJlaW5nIHJ1bi5cbiAgQ1VSUkVOVF9DT01NQU5EID0gdmVyYlRva2VuKGFyZ3YpO1xuICBsZXQgcGFyc2VkOiBSZXR1cm5UeXBlPHR5cGVvZiBwYXJzZUFyZ3M+O1xuICB0cnkge1xuICAgIHBhcnNlZCA9IHBhcnNlQXJncyhhcmd2KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGlmICghKGUgaW5zdGFuY2VvZiBVc2FnZUVycm9yKSkgdGhyb3cgZTtcbiAgICAvLyBBbiB1bmtub3duIGZsYWcncyByZWplY3Rpb24gbmFtZXMgdGhlIHNldCBBVCBUSElTIFBBVEgsIG5vdCB0aGUgd2hvbGVcbiAgICAvLyByZWdpc3RyeTogdGhlIHZlcmIncyBvd24gZmxhZ3Mgd2hlbiB0aGUgdmVyYiBpcyBvbmUgb2Ygb3VycywgdGhlIHZlcmJcbiAgICAvLyByb3N0ZXIgd2hlbiB0aGVyZSBpcyBubyB2ZXJiIHlldCAodGhlIHJvb3QgYWNjZXB0cyBubyBmbGFncyBvZiBpdHMgb3duKS5cbiAgICAvLyBUaGlzIGlzIHdoYXQgYSByZWNvcmRlZC1zdXJmYWNlIGNlbnN1cyByZWFkcywgcGF0aCBieSBwYXRoLlxuICAgIGNvbnN0IHNwZWMgPSBDVVJSRU5UX0NPTU1BTkQgPT09IG51bGwgPyB1bmRlZmluZWQgOiBmaW5kQ29tbWFuZChDVVJSRU5UX0NPTU1BTkQpO1xuICAgIGlmIChzcGVjICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBVc2FnZUVycm9yKGUubWVzc2FnZSwgeyBoaW50OiBlLmhpbnQsIGNob2ljZXM6IGZsYWdzRm9yKHNwZWMubmFtZSkgfSk7XG4gICAgfVxuICAgIC8vIEF0IHRoZSByb290IHRoZSBmbGFncyB0aGUgdG9vbCBhY2NlcHRzIGFyZSB0aGUgaW50ZXJjZXB0b3JzLCBhbmQgdGhhdCBpc1xuICAgIC8vIHRoZSBzZXQgbmFtZWQg4oCUIHRoZSBzYW1lIGFycmF5IGBzY2hlbWFgIGRlY2xhcmVzIGF0IHBhdGggW10sIHNvIHRoZVxuICAgIC8vIHJvb3QgaXMgZGlmZmFibGUuIFRoZSB2ZXJiIHJvc3RlciByaWRlcyB0aGUgaGludDogdGhlIG5leHQgYWN0IGlzIGEgdmVyYi5cbiAgICB0aHJvdyBuZXcgVXNhZ2VFcnJvcihlLm1lc3NhZ2UsIHtcbiAgICAgIGhpbnQ6IGBubyB2ZXJiIGdpdmVuIOKAlCB2ZXJiczogJHtWRVJCUy5qb2luKFwiIFwiKX0gKHJ1bjogY2xpLnRzIGhlbHApYCxcbiAgICAgIGNob2ljZXM6IFJPT1RfSU5URVJDRVBUT1JTLm1hcCgoaSkgPT4gaS5uYW1lKSxcbiAgICB9KTtcbiAgfVxuICBjb25zdCBbdmVyYiwgLi4ucG9zXSA9IHBhcnNlZC5wb3M7XG4gIGNvbnN0IGZsYWdzID0gcGFyc2VkLmZsYWdzO1xuICBDVVJSRU5UX0NPTU1BTkQgPSB2ZXJiID8/IG51bGw7XG5cbiAgaWYgKHZlcmIgPT09IHVuZGVmaW5lZCkge1xuICAgIC8vIEJhcmUgaW52b2NhdGlvbiBpcyBhIHVzYWdlIGVycm9yIChhY2MgRDIpLCBhbmQgdGhlIHJlamVjdGlvbiBuYW1lc1xuICAgIC8vIHRoZSByb3N0ZXIgc28gdGhlIGNhbGxlcidzIG5leHQgY29tbWFuZCBjYW4gYmUgcmlnaHQuXG4gICAgdGhyb3cgbmV3IFVzYWdlRXJyb3IoXCJubyB2ZXJiIGdpdmVuXCIsIHsgaGludDogXCJydW46IGNsaS50cyBoZWxwXCIsIGNob2ljZXM6IFsuLi5WRVJCU10gfSk7XG4gIH1cbiAgY29uc3Qgc3BlYyA9IGZpbmRDb21tYW5kKHZlcmIpO1xuICBpZiAoc3BlYyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IFVzYWdlRXJyb3IoYHVua25vd24gdmVyYiBcIiR7dmVyYn1cImAsIHtcbiAgICAgIGhpbnQ6IFwicnVuOiBjbGkudHMgaGVscFwiLFxuICAgICAgY2hvaWNlczogWy4uLlZFUkJTXSxcbiAgICB9KTtcbiAgfVxuXG4gIC8vIFN0YWdlIDI6IGEgcmVjb2duaXplZCBmbGFnIHRoaXMgdmVyYiBkb2VzIG5vdCB0YWtlIOKAlCBNSVNQTEFDRUQsIG5vdFxuICAvLyB1bmtub3duLiBBbiBhZ2VudCB0b2xkIGEgcmVhbCBmbGFnIGlzIHVua25vd24gZ29lcyBodW50aW5nIGEgdHlwbyBpdCBkaWRcbiAgLy8gbm90IG1ha2UuIFRoZSB2ZXJiIGlzIHJlc29sdmVkIGZpcnN0IGJlY2F1c2Ugd2hpY2ggZmxhZ3MgYXJlIGxlZ2FsIGlzIGFcbiAgLy8gcXVlc3Rpb24gYWJvdXQgdGhlIHZlcmIuXG4gIGNvbnN0IGFsbG93ZWQgPSBuZXcgU2V0PHN0cmluZz4oc3BlYy5mbGFncyk7XG4gIGNvbnN0IHN0cmF5ID0gT2JqZWN0LmtleXMoZmxhZ3MpLmZpbmQoKGspID0+ICFhbGxvd2VkLmhhcyhrKSk7XG4gIGlmIChzdHJheSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3QgYWNjZXB0ZWQgPSBmbGFnc0ZvcihzcGVjLm5hbWUpO1xuICAgIHRocm93IG5ldyBVc2FnZUVycm9yKFxuICAgICAgYC0tJHtzdHJheX0gaXMgbm90IGFjY2VwdGVkIGJ5IFxcYCR7c3BlYy5uYW1lfVxcYCAoaXQgaXMgYSByZWNvZ25pemVkIGdsYW1vdXIgZmxhZywganVzdCBub3QgdGhpcyB2ZXJiJ3MpYCxcbiAgICAgIGFjY2VwdGVkLmxlbmd0aCA+IDAgPyB7IGNob2ljZXM6IGFjY2VwdGVkIH0gOiB7IGhpbnQ6IGAke3NwZWMubmFtZX0gdGFrZXMgbm8gZmxhZ3NgIH0sXG4gICAgKTtcbiAgfVxuXG4gIC8vIEFyaXR5LCBlbmZvcmNlZCBGUk9NIFRIRSBERUNMQVJFRCBTSEFQRTogdGhlIHRhYmxlJ3MgcG9zaXRpb25hbCBzcGVjIGlzXG4gIC8vIHdoYXQgYHNjaGVtYWAgcHVibGlzaGVzIGFuZCB3aGF0IGhlbHAgcHJpbnRzLCBzbyBlbmZvcmNpbmcgaXQgaGVyZSBrZWVwc1xuICAvLyBib3RoIHRydWUgYnkgY29uc3RydWN0aW9uLiBBIHZlcmIncyBvd24gZmluZXIgY2hlY2tzIChhIG51bWVyaWMgLS1jb3N0LFxuICAvLyBhIHJlcXVpcmVkIGZsYWcpIGxpdmUgaW4gaXRzIGhhbmRsZXIgYW5kIG5hbWUgdGhlIHNhbWUgdXNhZ2UgbGluZS5cbiAgY29uc3QgcmVxdWlyZWQgPSBzcGVjLnBvc2l0aW9uYWxzLmZpbHRlcigocCkgPT4gcC5yZXF1aXJlZCkubGVuZ3RoO1xuICBjb25zdCB2YXJpYWRpYyA9IHNwZWMucG9zaXRpb25hbHMuc29tZSgocCkgPT4gcC52YXJpYWRpYyk7XG4gIGlmIChwb3MubGVuZ3RoIDwgcmVxdWlyZWQgfHwgKCF2YXJpYWRpYyAmJiBwb3MubGVuZ3RoID4gc3BlYy5wb3NpdGlvbmFscy5sZW5ndGgpKSB7XG4gICAgdGhyb3cgbmV3IFVzYWdlRXJyb3IoYHVzYWdlOiAke3VzYWdlT2Yoc3BlYyl9YCwgeyBoaW50OiBzcGVjLmRlc2NyaWJlIH0pO1xuICB9XG5cbiAgY29uc3Qgc2Vzc2lvbiA9IHR5cGVvZiBmbGFncy5zZXNzaW9uID09PSBcInN0cmluZ1wiID8gZmxhZ3Muc2Vzc2lvbiA6IHVuZGVmaW5lZDtcbiAgYXdhaXQgc3BlYy5ydW4ocG9zLCBmbGFncywgc2Vzc2lvbik7XG4gIHJldHVybiAwO1xufVxuXG4vKipcbiAqIFRoZSBDTEkncyBlbnRyeSwgZm9yIHRoZSBMQVVOQ0hFUiBhdFxuICogYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9nbGFtb3VyL3NjcmlwdHMvY2xpLnRzYC5cbiAqXG4gKiDim5QgYGltcG9ydC5tZXRhLm1haW5gIElTIEZBTFNFIElOIFRIRSBCVU5ETEUg4oCUIGBkaXN0L2NsaS5qc2AgaXMgSU1QT1JURUQgYnlcbiAqIHRoZSBsYXVuY2hlciwgbmV2ZXIgZXhlY3V0ZWQgYXMgdGhlIHByb2Nlc3MgZW50cnksIHNvIGFuIGBpZiAoaW1wb3J0Lm1ldGEubWFpbilgXG4gKiBibG9jayBoZXJlIHdvdWxkIG5ldmVyIHJ1bjogdGhlIENMSSB3b3VsZCBwcmludCBub3RoaW5nIGFuZCBleGl0IDAgZm9yIGV2ZXJ5XG4gKiB2ZXJiLiBUaGlzIGV4cG9ydCBpcyB3aGF0IHJlcGxhY2VzIGl0LlxuICpcbiAqIOKblCBJVCBSRVRVUk5TIFRIRSBDT0RFIFJBVEhFUiBUSEFOIFNFVFRJTkcgSVQuIGBwcm9jZXNzLmV4aXRDb2RlYCArIGEgbmF0dXJhbFxuICogcmV0dXJuLCBORVZFUiBgcHJvY2Vzcy5leGl0KGNvZGUpYDogQnVuJ3Mgc3Rkb3V0IGlzIEFTWU5DSFJPTk9VUyBvbiBhIHBpcGVcbiAqIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBmaWxlKSwgc28gYW4gZXhwbGljaXQgZXhpdCBkaXNjYXJkcyB3aGF0ZXZlciBoYXMgbm90XG4gKiBkcmFpbmVkIOKAlCBtZWFzdXJlZCBhdCBleGFjdGx5IDY1LDUzNiBieXRlcy4gVGhlIHBheWxvYWQgaXMgY29tcGxldGUgYW5kIG9ubHlcbiAqIHRoZSB3cml0ZSBpcyBsb3N0LCBzbyB0aGUgY2FsbGVyIGdldHMgd2VsbC1mb3JtZWQtbG9va2luZyBKU09OIHRoYXQgc3RvcHNcbiAqIG1pZC1zdHJpbmcuIGdsYW1vdXIncyBgc3RhdGUgLS1mdWxsYCBzaGlwcyBiYXNlNjQgcGF5bG9hZHMgZmFyIHBhc3QgdGhhdFxuICogYm91bmRhcnksIHNvIHRoaXMgaXMgbm90IHRoZW9yZXRpY2FsIGhlcmUuIFJlcHJvZHVjZWQsIGZpeGVkIGFuZCBnYXRlZCBpblxuICogYm91bnR5IGZpcnN0IChQMCwgIzc3LyM3OCkuIFRoZSBhc3NpZ25tZW50IGhhcHBlbnMgb25jZSwgaW4gdGhlIGxhdW5jaGVyLlxuICpcbiAqIOKblCBBTkQgSVQgVEFLRVMgTk8gQVJHVU1FTlRTOiB0aGUgY29tbWFuZCBsaW5lIGJlbG9uZ3MgdG8gdGhlIGZpbGUgdGhhdCBQQVJTRVNcbiAqIGl0LiBBIGxhdW5jaGVyIHJlYWRpbmcgYHByb2Nlc3MuYXJndmAgd291bGQgbWF0Y2ggdGhlIGFyZy1wYXJzaW5nIHByZWRpY2F0ZSBpblxuICogYGdyaW1vaXJlL2xpYi9lbnRyeS1wb2ludHMudHNgIGFuZCB0aGUgZmxhZyB3YXJkIHdvdWxkIGp1ZGdlIHRoaXMgc3BlbGwnc1xuICogZG9jdW1lbnRlZCBmbGFncyBhZ2FpbnN0IGEgZmlsZSB0aGF0IHJlY29nbmlzZXMgbm9uZS5cbiAqXG4gKiDimqAgVU5MSUtFIFRIRSBEQUVNT04sIFRIRSBTT1VSQ0UgS0VFUFMgTk8gU0VDT05EIEVOVFJZIEFORCBORUVEUyBOT05FIChEMTIpOlxuICogYFNDUklQVF9ESVJgJ3MgY29uc3VtZXJzIGhlcmUgYXJlIGFsbCBhbmNlc3Rvci1yZWxhdGl2ZSBhbmQgY29ycmVjdCBmcm9tIGVpdGhlclxuICogYWRkcmVzcywgYnV0IHRoZSBzb3VyY2UgaGFzIG5vIGBpbXBvcnQubWV0YS5tYWluYCBibG9jayBlaXRoZXIsIHNvIHRoZXJlIGlzIG9uZVxuICogZW50cnkgYW5kIGl0IGlzIHRoaXMgb25lLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuKCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHJldHVybiBhd2FpdCBtYWluKHByb2Nlc3MuYXJndi5zbGljZSgyKSk7XG59XG5cbmV4cG9ydCB7IG1haW4gfTtcbiIsCiAgICAiLy8gQnJvd3Nlci1zYWZlIGltYWdlLW9wdGltaXphdGlvbiBQT0xJQ1kgKHNoYXJlZCBieSB0aGUgYnJvd3NlciBkcm9wIHBhdGggYW5kXG4vLyB0aGUgc2VydmVyIHBhdGgpLiBObyBuYXRpdmUgZGVwcyDigJQgc2FmZSB0byBpbXBvcnQgaW50byB0aGUgUmVhY3QgYnVuZGxlLlxuLy8gVGhlIEJ1bi5JbWFnZSBpbXBsZW1lbnRhdGlvbiBsaXZlcyBpbiBpbWFnZU9wdGltaXplLnNlcnZlci50cy5cbmV4cG9ydCBjb25zdCBPUFRJTUlaRSA9IHsgbWF4RGltOiAxMjAwLCBxdWFsaXR5OiAwLjg1IH0gYXMgY29uc3Q7XG4iLAogICAgIi8vIFNlcnZlci9DTEktb25seTogbmF0aXZlIEJ1bi5JbWFnZSBkb3duc2NhbGUgKyB3ZWJwLiBEbyBOT1QgaW1wb3J0IGZyb20gYnJvd3NlclxuLy8gY29kZSAodGhlIGJyb3dzZXIgZHJvcCBwYXRoIHVzZXMgPGNhbnZhcz4pLiBSZXF1aXJlcyBCdW4gPj0gMS4zLjE0LlxuaW1wb3J0IHsgT1BUSU1JWkUgfSBmcm9tIFwiLi4vLi4vLi4vcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL2dsYW1vdXIvc2hhcmVkL2ltYWdlT3B0aW1pemVcIjtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG9wdGltaXplSW1hZ2VCdWZmZXIoXG4gIGlucHV0OiBVaW50OEFycmF5LFxuKTogUHJvbWlzZTx7IGRhdGE6IFVpbnQ4QXJyYXk7IG1pbWU6IFwiaW1hZ2Uvd2VicFwiIH0+IHtcbiAgY29uc3QgZGF0YSA9IGF3YWl0IG5ldyBCdW4uSW1hZ2UoaW5wdXQpXG4gICAgLnJlc2l6ZShPUFRJTUlaRS5tYXhEaW0sIE9QVElNSVpFLm1heERpbSwge1xuICAgICAgZml0OiBcImluc2lkZVwiLFxuICAgICAgd2l0aG91dEVubGFyZ2VtZW50OiB0cnVlLFxuICAgIH0pXG4gICAgLndlYnAoeyBxdWFsaXR5OiBNYXRoLnJvdW5kKE9QVElNSVpFLnF1YWxpdHkgKiAxMDApIH0pXG4gICAgLmJ5dGVzKCk7XG4gIHJldHVybiB7IGRhdGE6IG5ldyBVaW50OEFycmF5KGRhdGEpLCBtaW1lOiBcImltYWdlL3dlYnBcIiB9O1xufVxuXG4vLyBEZWNvZGUgYSBiYXNlNjQgZGF0YS1VUkwsIG9wdGltaXplIHRoZSByYXN0ZXIsIHJlLWVuY29kZSBhcyBhIHdlYnAgZGF0YS1VUkwuXG4vLyBVc2VkIGJ5IHRoZSBDTEkgYGdlbmAgdmVyYiAodGhlIGFnZW50IHBvc3RzIGEgbWVkaWEtZm9yZ2UgaW1hZ2Ugd2l0aCBub1xuLy8gYnJvd3NlciA8Y2FudmFzPiBhdmFpbGFibGUpLiBUaHJvd3Mgb24gYSBub24tYmFzZTY0LWRhdGEtVVJMIGlucHV0LlxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG9wdGltaXplSW1hZ2VEYXRhVXJsKGRhdGFVcmw6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IG0gPSAvXmRhdGE6KFteOyxdKyk7YmFzZTY0LCguKikkL3MuZXhlYyhkYXRhVXJsKTtcbiAgaWYgKCFtKSB0aHJvdyBuZXcgRXJyb3IoXCJvcHRpbWl6ZUltYWdlRGF0YVVybDogZXhwZWN0ZWQgYSBiYXNlNjQgZGF0YS1VUkxcIik7XG4gIGNvbnN0IGJ5dGVzID0gVWludDhBcnJheS5mcm9tKGF0b2IobVsyXSksIChjKSA9PiBjLmNoYXJDb2RlQXQoMCkpO1xuICBjb25zdCB7IGRhdGEgfSA9IGF3YWl0IG9wdGltaXplSW1hZ2VCdWZmZXIoYnl0ZXMpO1xuICBsZXQgYmluID0gXCJcIjtcbiAgZm9yIChjb25zdCBiIG9mIGRhdGEpIGJpbiArPSBTdHJpbmcuZnJvbUNoYXJDb2RlKGIpO1xuICByZXR1cm4gYGRhdGE6aW1hZ2Uvd2VicDtiYXNlNjQsJHtidG9hKGJpbil9YDtcbn1cbiIKICBdLAogICJtYXBwaW5ncyI6ICI7Ozs7QUErQkE7QUFDQTtBQUNBO0FBQ0E7QUFDQSxzQkFBUzs7O0FDaENGLElBQU0sV0FBVyxFQUFFLFFBQVEsTUFBTSxTQUFTLEtBQUs7OztBQ0N0RCxlQUFzQixtQkFBbUIsQ0FDdkMsT0FDbUQ7QUFBQSxFQUNuRCxNQUFNLE9BQU8sTUFBTSxJQUFJLElBQUksTUFBTSxLQUFLLEVBQ25DLE9BQU8sU0FBUyxRQUFRLFNBQVMsUUFBUTtBQUFBLElBQ3hDLEtBQUs7QUFBQSxJQUNMLG9CQUFvQjtBQUFBLEVBQ3RCLENBQUMsRUFDQSxLQUFLLEVBQUUsU0FBUyxLQUFLLE1BQU0sU0FBUyxVQUFVLEdBQUcsRUFBRSxDQUFDLEVBQ3BELE1BQU07QUFBQSxFQUNULE9BQU8sRUFBRSxNQUFNLElBQUksV0FBVyxJQUFJLEdBQUcsTUFBTSxhQUFhO0FBQUE7QUFNMUQsZUFBc0Isb0JBQW9CLENBQUMsU0FBa0M7QUFBQSxFQUMzRSxNQUFNLElBQUksK0JBQStC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QUFJLEVBQUUsTUFBTSxHQUFHLEtBQUssc0JBQXNCLENBQ3RGO0FBQUEsRUFDRjtBQUFBLEVBTUEsTUFBTSxXQUFXLEtBQUssWUFBWSxPQUFPLENBQUMsTUFBTSxFQUFFLFFBQVEsRUFBRTtBQUFBLEVBQzVELE1BQU0sV0FBVyxLQUFLLFlBQVksS0FBSyxDQUFDLE1BQU0sRUFBRSxRQUFRO0FBQUEsRUFDeEQsSUFBSSxJQUFJLFNBQVMsWUFBYSxDQUFDLFlBQVksSUFBSSxTQUFTLEtBQUssWUFBWSxRQUFTO0FBQUEsSUFDaEYsTUFBTSxJQUFJLFdBQVcsVUFBVSxRQUFRLElBQUksS0FBSyxFQUFFLE1BQU0sS0FBSyxTQUFTLENBQUM7QUFBQSxFQUN6RTtBQUFBLEVBRUEsTUFBTSxVQUFVLE9BQU8sTUFBTSxZQUFZLFdBQVcsTUFBTSxVQUFVO0FBQUEsRUFDcEUsTUFBTSxLQUFLLElBQUksS0FBSyxPQUFPLE9BQU87QUFBQSxFQUNsQyxPQUFPO0FBQUE7QUErQlQsZUFBc0IsR0FBRyxHQUFvQjtBQUFBLEVBQzNDLE9BQU8sTUFBTSxLQUFLLFFBQVEsS0FBSyxNQUFNLENBQUMsQ0FBQztBQUFBOyIsCiAgImRlYnVnSWQiOiAiQjk1QjREQjRENTg2MTNDRTY0NzU2RTIxNjQ3NTZFMjEiLAogICJuYW1lcyI6IFtdCn0=
