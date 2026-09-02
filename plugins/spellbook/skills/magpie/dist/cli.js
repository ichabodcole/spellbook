#!/usr/bin/env bun
// @bun

// src/magpie/backend/cli.ts
import { spawn } from "child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "fs";
import { tmpdir } from "os";
import { basename, dirname as dirname2, join as join3 } from "path";
import { fileURLToPath } from "url";
import { parseArgs as nodeParseArgs } from "util";

// plugins/spellbook/skills/magpie/scripts/backend.ts
import { join } from "path";

// plugins/spellbook/skills/magpie/shared/alpha.ts
var ALPHA_AUTO_TYPES = new Set([
  "illustration",
  "sticker",
  "icon",
  "wordmark"
]);
var ALPHA_FORBIDDEN_TYPES = new Set([
  "palette",
  "screenshot",
  "typography"
]);
function shouldRemove(type, policy) {
  if (policy === "none")
    return false;
  if (policy === "all")
    return !ALPHA_FORBIDDEN_TYPES.has(type);
  return ALPHA_AUTO_TYPES.has(type);
}

// plugins/spellbook/skills/magpie/scripts/backend.ts
var REMOVE_PY = join(import.meta.dir, "remove.py");
function shortId(prefix) {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  const hex = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${hex}`;
}
var rembgBackend = {
  name: "rembg",
  async cut(crop, outPath, opts = {}) {
    const [x1, y1, x2, y2] = crop.bbox;
    const args = [
      "python3",
      REMOVE_PY,
      "--source",
      crop.sourcePath,
      "--bbox",
      `${x1},${y1},${x2},${y2}`,
      "--type",
      crop.type,
      "--out",
      outPath
    ];
    if (opts.alpha)
      args.push("--alpha", opts.alpha);
    if (typeof opts.pad === "number")
      args.push("--pad", String(opts.pad));
    if (opts.model)
      args.push("--model", opts.model);
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);
    if (exitCode !== 0) {
      throw new Error(`rembg remove.py failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`);
    }
    const line = stdout.trim().split(`
`).filter(Boolean).pop() ?? "";
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`rembg remove.py produced no parseable JSON line: ${stdout.trim()}`);
    }
    return { id: shortId("cut"), backend: "rembg", path: parsed.out ?? outPath };
  }
};
var mediaForgeBackend = {
  name: "media-forge",
  async cut(crop, outPath, opts = {}) {
    const model = opts.model;
    if (!model)
      throw new Error("mediaForgeBackend.cut requires opts.model (a bg-remove model id)");
    const args = [
      "media-forge",
      "generate",
      "bg-remove",
      `--model=${model}`,
      `--ref=${crop.sourcePath}`,
      "--format",
      "json"
    ];
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);
    if (exitCode !== 0) {
      throw new Error(`media-forge bg-remove failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(stdout.trim().split(`
`).filter(Boolean).pop() ?? "");
    } catch {
      throw new Error(`media-forge produced no parseable JSON line: ${stdout.trim()}`);
    }
    const url = parsed?.data?.outputs?.[0]?.presignedUrl;
    if (!url)
      throw new Error(`media-forge returned no output url: ${stdout.trim()}`);
    const res = await fetch(url);
    if (!res.ok)
      throw new Error(`media-forge output download failed (HTTP ${res.status})`);
    await Bun.write(outPath, res);
    return { id: shortId("cut"), backend: "media-forge", path: outPath };
  }
};
function isMediaForgeModel(model) {
  return model.includes("/");
}
var REMOVAL_BACKENDS = {
  [rembgBackend.name]: rembgBackend,
  [mediaForgeBackend.name]: mediaForgeBackend
};

// plugins/spellbook/skills/magpie/scripts/discover.ts
import { dirname, extname, join as join2, resolve } from "path";
var OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
var DEFAULT_MODEL = "google/gemini-3.5-flash";
var PROMPT = `Identify every distinct extractable visual element in this image. "Distinct extractable" means: a single visually-coherent asset a designer would want to pull out as its own file \u2014 a logo, an icon, a sticker, a color swatch row, a piece of cover art, a UI screenshot. Do NOT include background, texture, or surrounding canvas.

For each element, return a bounding box using Google's normalized coordinate system (image is [0, 1000] on both axes, 0,0 top-left) in the documented order: [y_min, x_min, y_max, x_max].

Return ONLY a JSON array, no prose, in this exact shape:
[
  {"name": "<short_snake_case_name>", "type": "<one of: wordmark, tagline, icon, illustration, sticker, palette, typography, screenshot, other>", "box_2d": [y_min, x_min, y_max, x_max]}
]

Naming rules:
- Use distinctive snake_case names; if there are multiple of the same kind, differentiate descriptively (icon_mammoth, icon_gear, sticker_coffee, sticker_skateboard).
- The \`type\` field is critical \u2014 the extract step uses it to decide whether to run background removal.
`;
var MAX_IMAGE_BYTES = 30 * 1024 * 1024;
var WARN_IMAGE_BYTES = 15 * 1024 * 1024;
var MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif"
};

class DiscoverError extends Error {
}
function parseBboxes(content) {
  let s = content.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(s);
  if (fence)
    s = fence[1];
  return JSON.parse(s);
}
function normalizedToPixel(box, width, height) {
  const [y1, x1, y2, x2] = box;
  const px1 = Math.max(0, Math.round(x1 / 1000 * width));
  const py1 = Math.max(0, Math.round(y1 / 1000 * height));
  const px2 = Math.min(width, Math.round(x2 / 1000 * width));
  const py2 = Math.min(height, Math.round(y2 / 1000 * height));
  return [px1, py1, px2, py2];
}
function elementsFromRaw(raw, width, height) {
  const elements = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object")
      continue;
    const e = entry;
    const name = e.name;
    const kind = typeof e.type === "string" ? e.type : "other";
    const box = e.box_2d;
    if (!name || typeof name !== "string" || !Array.isArray(box))
      continue;
    elements.push({
      name,
      type: kind,
      box_2d: box,
      bbox_pixel: normalizedToPixel(box, width, height)
    });
  }
  return elements;
}
function mimeForPath(path) {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? "image/png";
}
async function encodeImageDataUrl(path) {
  const file = Bun.file(path);
  const size = file.size;
  if (size > MAX_IMAGE_BYTES) {
    const mb = (size / 1048576).toFixed(1);
    const limit = Math.floor(MAX_IMAGE_BYTES / 1048576);
    throw new DiscoverError(`${path} is ${mb} MB, above the ${limit} MB limit. Resize before retrying ` + `(e.g. ImageMagick: \`magick in.png -resize 2000x2000\\> out.png\`).`);
  }
  if (size > WARN_IMAGE_BYTES) {
    process.stderr.write(`WARN: ${path} is ${(size / 1048576).toFixed(1)} MB; large requests sometimes hit OpenRouter's payload limits.
`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const b64 = Buffer.from(bytes).toString("base64");
  return `data:${mimeForPath(path)};base64,${b64}`;
}
async function imageSize(path) {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const meta = await new Bun.Image(bytes).metadata();
  return [meta.width ?? 0, meta.height ?? 0];
}
async function sourceSha256_16(path) {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 16);
}
async function callOpenRouter(apiKey, model, imageDataUrl, prompt) {
  const body = {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: imageDataUrl } }
        ]
      }
    ],
    temperature: 0
  };
  const ctrl = new AbortController;
  const timer = setTimeout(() => ctrl.abort(), 180000);
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/ichabodcole/spellbook",
        "X-Title": "magpie"
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new DiscoverError(`OpenRouter HTTP ${res.status}: ${text}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
async function discover(imagePath, opts = {}) {
  const model = opts.model ?? DEFAULT_MODEL;
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new DiscoverError("OPENROUTER_API_KEY env var not set");
  }
  if (!await Bun.file(imagePath).exists()) {
    throw new DiscoverError(`image not found: ${imagePath}`);
  }
  const [size, dataUrl, sha] = await Promise.all([
    imageSize(imagePath),
    encodeImageDataUrl(imagePath),
    sourceSha256_16(imagePath)
  ]);
  const [width, height] = size;
  const resp = await callOpenRouter(apiKey, model, dataUrl, PROMPT);
  const choices = resp.choices;
  const content = choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new DiscoverError(`unexpected response shape from OpenRouter (no choices[0].message.content):
${JSON.stringify(resp).slice(0, 2000)}`);
  }
  const usage = resp.usage ?? {};
  const cost = typeof usage.cost === "number" ? usage.cost : 0;
  const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const completionTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  const details = usage.completion_tokens_details ?? {};
  const reasoningTokens = typeof details.reasoning_tokens === "number" ? details.reasoning_tokens : 0;
  let raw;
  try {
    raw = parseBboxes(content);
  } catch (ex) {
    throw new DiscoverError(`model returned non-JSON output:
${content}

Parse error: ${ex instanceof Error ? ex.message : String(ex)}`);
  }
  return {
    source: resolve(imagePath),
    source_size: [width, height],
    source_sha256_16: sha,
    model,
    cost_usd: cost,
    tokens: { prompt: promptTokens, completion: completionTokens, reasoning: reasoningTokens },
    elements: elementsFromRaw(raw, width, height)
  };
}
if (false) {}

// plugins/spellbook/skills/magpie/shared/types.ts
var AGENT_EVENT_TYPES = Object.freeze([
  "ready",
  "connected",
  "disconnected",
  "say",
  "source.added",
  "extract",
  "removeBg",
  "retryRemoval",
  "phase.advance",
  "phase.set",
  "export",
  "submit",
  "closed"
]);

// plugins/spellbook/skills/magpie/scripts/reduce.ts
function randHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
function newId(prefix) {
  return `${prefix}-${randHex(4)}`;
}

// plugins/spellbook/skills/magpie/shared/versions.ts
function chosenVersion(el) {
  const vs = el.versions ?? [];
  return vs.find((v) => v.id === el.chosenVersionId) ?? vs[0];
}

// src/kit/lib/printJson.ts
function printJson(data) {
  process.stdout.write(`${JSON.stringify(data)}
`);
}

// src/magpie/backend/cli.ts
process.stdout.on("error", (e) => {
  if (e.code === "EPIPE")
    process.exit(0);
});
var SCRIPT_DIR = dirname2(fileURLToPath(import.meta.url));
var SERVER_SCRIPT = join3(SCRIPT_DIR, "..", "scripts", "server.ts");
var SKILL_ROOT = join3(SCRIPT_DIR, "..");
var DIST_DIR = join3(SKILL_ROOT, "dist");
var SURFACE_CWD = join3(SKILL_ROOT, "..", "..", "..", "..", "src", "magpie");
function daemonCwd() {
  if (process.env.SPELLBOOK_SURFACE_MODE === "release")
    return SKILL_ROOT;
  if (process.env.SPELLBOOK_SURFACE_MODE === "dev")
    return SURFACE_CWD;
  return existsSync(join3(DIST_DIR, "index.html")) ? SKILL_ROOT : SURFACE_CWD;
}
function readPluginVersion() {
  try {
    const pluginJsonPath = join3(SCRIPT_DIR, "..", "..", "..", ".claude-plugin", "plugin.json");
    return JSON.parse(readFileSync(pluginJsonPath, "utf-8")).version ?? null;
  } catch {
    return null;
  }
}
var PLUGIN_VERSION = readPluginVersion();
var EXIT_FOR = {
  usage: 2,
  internal: 1,
  not_found: 5,
  conflict: 6
};
var CURRENT_COMMAND = null;
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
    meta: { command: CURRENT_COMMAND }
  })}
`;
}
function die(msg, kind = "usage", extra) {
  process.stderr.write(errorEnvelope(kind, msg, extra));
  process.exit(EXIT_FOR[kind]);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function sessionFilePath(session) {
  return session ? join3(tmpdir(), `magpie-${session}.json`) : join3(tmpdir(), "magpie-latest.json");
}
function readSession(session) {
  try {
    return JSON.parse(readFileSync(sessionFilePath(session), "utf8"));
  } catch {
    return null;
  }
}
function requireSession(session) {
  const s = readSession(session);
  if (!s)
    die("no running magpie session \u2014 run: cli.ts open", "not_found");
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
  alpha: { type: "string" },
  bbox: { type: "string" },
  ids: { type: "string" },
  intent: { type: "string" },
  label: { type: "string" },
  model: { type: "string" },
  name: { type: "string" },
  options: { type: "string" },
  pad: { type: "string" },
  restore: { type: "string" },
  session: { type: "string" },
  since: { type: "string" },
  timeout: { type: "string" },
  title: { type: "string" },
  type: { type: "string" },
  full: { type: "boolean" },
  "no-open": { type: "boolean" },
  remove: { type: "boolean" },
  stdin: { type: "boolean" }
};
var VERB_SPEC = {
  open: ["title", "intent", "timeout", "restore", "no-open"],
  sessions: [],
  tail: ["session", "since"],
  state: ["session", "full"],
  say: ["session", "stdin"],
  ask: ["session", "options"],
  status: ["session"],
  source: ["session"],
  discover: ["session"],
  extract: ["session", "ids", "remove", "alpha", "pad", "model", "label"],
  export: ["session", "ids"],
  "element-add": ["session", "bbox", "name", "type"],
  "element-remove": ["session"],
  cmd: ["session", "stdin"],
  close: ["session"],
  info: ["session"],
  help: []
};
var VERBS = Object.keys(VERB_SPEC);
var isVerb = (v) => Object.hasOwn(VERB_SPEC, v);
var flagsFor = (verb) => VERB_SPEC[verb].map((k) => `--${k}`).sort();

class UsageError extends Error {
}
function parseArgs(args, verb) {
  let parsed;
  try {
    parsed = nodeParseArgs({
      args,
      options: CLI_OPTIONS,
      strict: true,
      allowPositionals: true
    });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  if (verb) {
    const allowed = new Set(VERB_SPEC[verb]);
    const stray = Object.keys(parsed.values).find((k) => !allowed.has(k));
    if (stray) {
      throw new UsageError(`--${stray} is not accepted by \`${verb}\` (it is a recognized magpie flag, just not this verb's)`);
    }
  }
  return {
    pos: parsed.positionals,
    flags: parsed.values
  };
}
async function readStdin() {
  return (await Bun.stdin.text()).trim();
}
async function postCmd(session, msg) {
  const s = requireSession(session);
  const { status } = await api(s.port, "POST", "/cmd", msg);
  if (status !== 200)
    die(`cmd failed (HTTP ${status}) \u2014 is the session still alive?`, "internal");
  printJson({ ok: true, sent: msg.type });
}
async function cmdOpen(flags) {
  const args = ["run", SERVER_SCRIPT];
  if (flags.title)
    args.push("--title", String(flags.title));
  if (flags.intent)
    args.push("--intent", String(flags.intent));
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
  die("magpie server failed to start within 5s", "internal");
}
async function cmdState(session, full = false) {
  const s = requireSession(session);
  const { status, data } = await api(s.port, "GET", `/state${full ? "" : "?lean=1"}`);
  if (status !== 200)
    die(`state failed (HTTP ${status})`, "internal");
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
            process.stderr.write(`: magpie-keepalive
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
    die("no running magpie session", "not_found");
  printJson(s);
}
function cmdSessions() {
  const home = process.env.MAGPIE_HOME ?? join3(process.env.HOME ?? "", ".magpie");
  const dir = join3(home, "snapshots");
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    printJson({ sessions: [] });
    return;
  }
  const rows = [];
  for (const f of files) {
    const path = join3(dir, f);
    try {
      const st = JSON.parse(readFileSync(path, "utf8"));
      rows.push({
        id: f.replace(/\.json$/, ""),
        title: st.title,
        elements: Array.isArray(st.elements) ? st.elements.length : 0,
        mtime: statSync(path).mtimeMs
      });
    } catch {}
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  printJson({ sessions: rows });
}
async function cmdSource(session, imagePath) {
  const file = Bun.file(imagePath);
  if (!await file.exists())
    die(`image not found: ${imagePath}`, "not_found");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 16);
  const meta = await new Bun.Image(bytes).metadata();
  await postCmd(session, {
    type: "source.set",
    path: imagePath,
    size: [meta.width ?? 0, meta.height ?? 0],
    sha
  });
}
async function cmdElementAdd(session, flags) {
  const raw = typeof flags.bbox === "string" ? flags.bbox : "";
  const parts = raw.split(",").map((n) => parseInt(n.trim(), 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    die('usage: element-add --bbox "x1,y1,x2,y2" [--name <name>] [--type <type>]');
  }
  const element = { bbox: parts };
  if (typeof flags.name === "string")
    element.name = flags.name;
  if (typeof flags.type === "string")
    element.type = flags.type;
  await postCmd(session, { type: "element.add", element });
}
async function cmdDiscover(session) {
  const s = requireSession(session);
  const { status, data } = await api(s.port, "GET", "/state");
  if (status !== 200)
    die(`state failed (HTTP ${status})`, "internal");
  const src = data.state?.source;
  const path = src?.path;
  if (!path)
    die("no source set \u2014 drop a composite (or run: source <imagePath>) first", "conflict");
  let manifest;
  try {
    manifest = await discover(path);
  } catch (e) {
    if (e instanceof DiscoverError)
      die(`discover failed: ${e.message}`, "internal");
    throw e;
  }
  const elements = manifest.elements.map((e) => ({
    id: newId("e"),
    name: e.name,
    type: e.type,
    bbox: e.bbox_pixel,
    status: "proposed"
  }));
  const cost = manifest.cost_usd ? ` \u2014 $${manifest.cost_usd.toFixed(4)}` : "";
  process.stderr.write(`magpie: discovered ${elements.length} element(s) on ${path}${cost}
`);
  await postCmd(session, { type: "elements.set", elements });
}
function sanitize(name) {
  const cleaned = Array.from(name || "").map((c) => /[A-Za-z0-9\-_.]/.test(c) ? c : "_").join("").replace(/^\.+/, "");
  return cleaned || "element";
}
function cutoutFilename(name, backend) {
  return `${sanitize(name)}${backend === "crop" ? "" : `.${backend}`}.png`;
}
async function cmdExtract(session, flags) {
  const s = requireSession(session);
  if (!s.files_dir)
    die("session has no files_dir \u2014 cannot materialize cutouts", "conflict");
  let alpha = flags.remove === true ? "auto" : "none";
  if (typeof flags.alpha === "string") {
    if (!["auto", "all", "none"].includes(flags.alpha)) {
      die(`--alpha must be auto|all|none (got ${flags.alpha})`);
    }
    alpha = flags.alpha;
  }
  const reqModel = typeof flags.model === "string" ? flags.model : undefined;
  const useMediaForge = reqModel ? isMediaForgeModel(reqModel) : false;
  const rembgModel = reqModel && !useMediaForge ? reqModel : undefined;
  const explicitLabel = typeof flags.label === "string" ? flags.label : undefined;
  const label = alpha === "none" ? "crop" : explicitLabel ?? (useMediaForge ? reqModel.split("/")[1] ?? "cloud" : reqModel ?? "rembg");
  const pad = typeof flags.pad === "string" ? parseInt(flags.pad, 10) : 0;
  if (Number.isNaN(pad))
    die("--pad must be a number");
  const idFilter = typeof flags.ids === "string" ? new Set(flags.ids.split(",").map((x) => x.trim()).filter(Boolean)) : undefined;
  const { status, data } = await api(s.port, "GET", "/state");
  if (status !== 200)
    die(`state failed (HTTP ${status})`, "internal");
  const st = data.state;
  const sourcePath = st?.source?.path;
  if (!sourcePath)
    die("no source set \u2014 drop a composite (or run: source <imagePath>) first", "conflict");
  let elements = (st?.elements ?? []).filter((e) => e.status !== "dropped");
  if (idFilter)
    elements = elements.filter((e) => idFilter.has(e.id));
  let keptWhole = 0;
  if (alpha !== "none") {
    const before = elements.length;
    elements = elements.filter((e) => shouldRemove(e.type, alpha));
    keptWhole = before - elements.length;
  }
  if (!elements.length) {
    die(keptWhole > 0 ? `nothing to remove \u2014 ${keptWhole} selected element${keptWhole === 1 ? " is a" : "s are"} kept-whole type${keptWhole === 1 ? "" : "s"} (palette/screenshot/typography)` : idFilter ? "no matching extractable elements for --ids" : "no extractable elements (all dropped or none discovered)");
  }
  await api(s.port, "POST", "/cmd", { type: "status", busy: true, text: "extracting\u2026" });
  let done = 0;
  let failed = 0;
  try {
    for (const el of elements) {
      const outPath = join3(s.files_dir, cutoutFilename(el.name, label));
      try {
        const cutout = useMediaForge ? await mediaForgeBackend.cut({
          sourcePath: join3(s.files_dir, cutoutFilename(el.name, "crop")),
          bbox: el.bbox,
          type: el.type
        }, outPath, { model: reqModel }) : await rembgBackend.cut({ sourcePath, bbox: el.bbox, type: el.type }, outPath, {
          alpha,
          pad,
          model: rembgModel
        });
        await api(s.port, "POST", "/cmd", {
          type: "element.addVersion",
          id: el.id,
          version: {
            id: newId("v"),
            model: label,
            kind: label === "crop" ? "raw" : useMediaForge ? "cloud" : "local",
            path: cutout.path,
            rev: 0
          },
          choose: true
        });
        done++;
        process.stderr.write(`magpie: cut ${el.name} (${el.type}, ${label}) \u2192 ${cutout.path}
`);
      } catch (e) {
        failed++;
        process.stderr.write(`magpie: cut FAILED for ${el.name}: ${e instanceof Error ? e.message : String(e)}
`);
      }
    }
  } finally {
    await api(s.port, "POST", "/cmd", { type: "status", busy: false });
  }
  printJson({ ok: true, cut: done, failed, total: elements.length, keptWhole, model: label });
}
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
function buildGalleryHtml(title, assets) {
  const types = [...new Set(assets.map((a) => a.type))].sort();
  const typeChips = ["all", ...types].map((t) => {
    const n = t === "all" ? assets.length : assets.filter((a) => a.type === t).length;
    return `<button class="chip${t === "all" ? " active" : ""}" data-filter="${escapeHtml(t)}">${escapeHtml(t)} <span class="n">${n}</span></button>`;
  }).join("");
  const cards = assets.map((a) => `      <figure class="card" data-type="${escapeHtml(a.type)}">
        <div class="thumb"><img src="${escapeHtml(a.file)}" alt="${escapeHtml(a.name)}"></div>
        <figcaption>
          <span class="name">${escapeHtml(a.name)}</span>
          <span class="meta">${escapeHtml(a.type)} \xB7 ${escapeHtml(a.model)}${a.kind ? ` (${escapeHtml(a.kind)})` : ""}</span>
        </figcaption>
      </figure>`).join(`
`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(title)} \u2014 magpie assets</title>
<style>
  :root { --cream:#f6f1e7; --ink:#14181b; --line:#e2d9c6; --indigo:#5b5bf0; }
  body { font-family:-apple-system,system-ui,sans-serif; background:var(--cream); color:var(--ink); margin:0; padding:28px; }
  h1 { font-size:20px; font-weight:700; margin:0; } .count { color:#9a8f78; font-weight:400; }
  .toolbar { display:flex; gap:18px; align-items:center; flex-wrap:wrap; margin:16px 0 4px; }
  .group { display:flex; gap:6px; align-items:center; }
  .label { font-size:11px; color:#9a8f78; text-transform:uppercase; letter-spacing:.04em; }
  /* backdrop = color swatches (not words); transparent = a mini checker square */
  .sw { width:22px; height:22px; padding:0; border:1px solid var(--line); border-radius:5px; cursor:pointer; box-sizing:border-box; }
  .sw.active { outline:2px solid var(--indigo); outline-offset:1px; }
  .sw.checker { background-color:#fff;
    background-image:linear-gradient(45deg,#c9c9c9 25%,transparent 25%),linear-gradient(-45deg,#c9c9c9 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#c9c9c9 75%),linear-gradient(-45deg,transparent 75%,#c9c9c9 75%);
    background-size:8px 8px; background-position:0 0,0 4px,4px -4px,-4px 0; }
  /* size = a small S/M/L segmented control */
  .seg { font:inherit; font-size:12px; padding:4px 9px; border:1px solid var(--line); background:#fffdf8; color:var(--ink); cursor:pointer; }
  .seg:first-child { border-radius:6px 0 0 6px; } .seg:last-child { border-radius:0 6px 6px 0; } .seg+.seg { border-left:none; }
  .seg.active { background:var(--indigo); color:#fff; border-color:var(--indigo); }
  .chip { font:inherit; font-size:12px; padding:4px 10px; border:1px solid var(--line); border-radius:999px; background:#fffdf8; color:var(--ink); cursor:pointer; }
  .chip.active { background:var(--indigo); color:#fff; border-color:var(--indigo); }
  .chip .n { opacity:.6; margin-left:2px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(170px,1fr)); gap:10px; margin-top:16px; }
  body[data-size="sm"] .grid { grid-template-columns:repeat(auto-fill,minmax(132px,1fr)); }
  body[data-size="lg"] .grid { grid-template-columns:repeat(auto-fill,minmax(264px,1fr)); gap:14px; }
  .card { background:#fffdf8; border:1px solid var(--line); border-radius:10px; overflow:hidden; min-width:0; }
  .thumb { height:160px; display:flex; align-items:center; justify-content:center; background-color:#fff;
    background-image:linear-gradient(45deg,#e7e0d2 25%,transparent 25%),linear-gradient(-45deg,#e7e0d2 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#e7e0d2 75%),linear-gradient(-45deg,transparent 75%,#e7e0d2 75%);
    background-size:16px 16px; background-position:0 0,0 8px,8px -8px,-8px 0; }
  body[data-size="sm"] .thumb { height:112px; } body[data-size="lg"] .thumb { height:240px; }
  body[data-bg="white"] .thumb { background:#fff!important; background-image:none!important; }
  body[data-bg="gray"] .thumb { background:#8a8a8a!important; background-image:none!important; }
  body[data-bg="black"] .thumb { background:#111!important; background-image:none!important; }
  .thumb img { max-width:88%; max-height:88%; object-fit:contain; }
  figcaption { padding:7px 9px; display:flex; flex-direction:column; gap:1px; min-width:0; }
  .name, .meta { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .name { font-size:12.5px; font-weight:600; } .meta { font-size:11px; color:#6f6c66; }
</style></head><body data-bg="checker" data-size="md">
  <h1>\uD83D\uDC26 ${escapeHtml(title)} <span class="count">\u2014 ${assets.length} asset${assets.length === 1 ? "" : "s"}</span></h1>
  <div class="toolbar">
    <div class="group"><span class="label">Backdrop</span>
      <button class="sw checker active" data-bg-btn="checker" title="Transparent"></button>
      <button class="sw" data-bg-btn="white" style="background:#ffffff" title="White"></button>
      <button class="sw" data-bg-btn="gray" style="background:#8a8a8a" title="Gray"></button>
      <button class="sw" data-bg-btn="black" style="background:#111111" title="Black"></button>
    </div>
    <div class="group"><span class="label">Size</span>
      <button class="seg" data-size-btn="sm" title="Small">S</button>
      <button class="seg active" data-size-btn="md" title="Medium">M</button>
      <button class="seg" data-size-btn="lg" title="Large">L</button>
    </div>
    <div class="group"><span class="label">Type</span>${typeChips}</div>
  </div>
  <div class="grid">
${cards}
  </div>
  <script>
    var body=document.body;
    function wire(sel, apply){ document.querySelectorAll(sel).forEach(function(b){ b.addEventListener('click', function(){
      apply(b);
      document.querySelectorAll(sel).forEach(function(x){ x.classList.toggle('active', x===b); });
    }); }); }
    wire('[data-bg-btn]', function(b){ body.dataset.bg=b.dataset.bgBtn; });
    wire('[data-size-btn]', function(b){ body.dataset.size=b.dataset.sizeBtn; });
    var cards=[].slice.call(document.querySelectorAll('.card'));
    wire('[data-filter]', function(b){ var t=b.dataset.filter;
      cards.forEach(function(c){ c.style.display=(t==='all'||c.dataset.type===t)?'':'none'; }); });
  </script>
</body></html>
`;
}
async function cmdExport(session, flags) {
  const s = requireSession(session);
  if (!s.files_dir)
    die("session has no files_dir \u2014 cannot build a bundle", "conflict");
  const idFilter = typeof flags.ids === "string" ? new Set(flags.ids.split(",").map((x) => x.trim()).filter(Boolean)) : undefined;
  const { status, data } = await api(s.port, "GET", "/state");
  if (status !== 200)
    die(`state failed (HTTP ${status})`, "internal");
  const st = data.state;
  let elements = (st?.elements ?? []).filter((e) => e.status !== "dropped");
  if (idFilter)
    elements = elements.filter((e) => idFilter.has(e.id));
  if (!elements.length)
    die(idFilter ? "no matching elements for --ids" : "no assets to export", "conflict");
  const title = st?.title ?? "magpie";
  const stageDir = join3(s.files_dir, "bundle-stage");
  const zipName = "magpie-bundle.zip";
  let result = null;
  let failure = null;
  try {
    rmSync(stageDir, { recursive: true, force: true });
    const assetsDir = join3(stageDir, "assets");
    const cropsDir = join3(stageDir, "crops");
    mkdirSync(assetsDir, { recursive: true });
    const manifest = [];
    for (const el of elements) {
      const chosen = chosenVersion(el);
      if (!chosen)
        continue;
      const chosenFile = join3(s.files_dir, basename(chosen.path));
      if (!existsSync(chosenFile)) {
        process.stderr.write(`magpie export: missing file for ${el.name} (${chosen.model})
`);
        continue;
      }
      const fileBase = `${sanitize(el.name)}.png`;
      copyFileSync(chosenFile, join3(assetsDir, fileBase));
      let cropPath = null;
      if (chosen.model !== "crop") {
        const cropFile = join3(s.files_dir, cutoutFilename(el.name, "crop"));
        if (existsSync(cropFile)) {
          mkdirSync(cropsDir, { recursive: true });
          copyFileSync(cropFile, join3(cropsDir, fileBase));
          cropPath = `crops/${fileBase}`;
        }
      }
      manifest.push({
        name: el.name,
        type: el.type,
        model: chosen.model,
        kind: chosen.kind ?? null,
        bbox: el.bbox,
        file: `assets/${fileBase}`,
        crop: cropPath
      });
    }
    if (!manifest.length)
      throw new Error("no chosen assets found to export (files missing?)");
    writeFileSync(join3(stageDir, "manifest.json"), JSON.stringify({ title, count: manifest.length, assets: manifest }, null, 2));
    writeFileSync(join3(stageDir, "gallery.html"), buildGalleryHtml(title, manifest));
    const zipPath = join3(s.files_dir, zipName);
    rmSync(zipPath, { force: true });
    const proc = Bun.spawn(["zip", "-r", "-q", zipPath, "."], {
      cwd: stageDir,
      stdout: "pipe",
      stderr: "pipe"
    });
    const [zerr, zcode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (zcode !== 0)
      throw new Error(`zip failed (exit ${zcode}): ${zerr.trim()}`);
    await api(s.port, "POST", "/cmd", {
      type: "bundle.set",
      name: zipName,
      count: manifest.length
    });
    process.stderr.write(`magpie: bundled ${manifest.length} asset(s) \u2192 ${zipPath}
`);
    result = { count: manifest.length };
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
    await api(s.port, "POST", "/cmd", { type: "status", busy: false });
  }
  if (failure || !result)
    die(`export failed: ${failure ?? "unknown"}`, "internal");
  printJson({ ok: true, bundle: zipName, count: result.count });
}
var HELP = `magpie \u2014 a standing review surface for extracting assets from a composite image.

  open   [--title ..] [--intent ..] [--no-open] [--timeout S] [--restore <id|path>]
  sessions                            list saved (resumable) sessions
  tail   [--since N]                  SSE user events \u2192 JSONL (wrap with Monitor)
  state  [--full]                     lean state snapshot (add --full for raw)
  say    [text...] [--stdin]          post agent dialogue (text args OR piped stdin)
  ask    <text...> [--options "a|b|c"]   ask the user a question (in-thread)
  status on [text...] | status off    show/hide the "magpie working" spinner
  source <imagePath>                  register the composite under review (computes sha + size)
  discover                            run discover on the current source \u2192 post the breakdown (needs OPENROUTER_API_KEY)
  extract [--ids a,b] [--remove] [--alpha auto|all|none] [--pad N] [--model <m>] [--label <name>]
          cut slices (crop-only; --remove adds rembg). --model = a rembg model name (isnet-general-use,
          birefnet-general, \u2026) OR a media-forge bg-remove model id (a provider path like
          fal-ai/bria/background/remove \u2014 DISCOVER via \`media-forge models list\`, never hardcode);
          --label sets the version's friendly strip label (defaults sensibly)
  export [--ids a,b]                  build magpie-bundle.zip \u2014 assets/ (chosen finals) + crops/ (raw crops) + manifest.json + gallery.html (backdrop toggle + type filters)
  element-add --bbox "x1,y1,x2,y2" [--name ..] [--type ..]   box a region (source px)
  element-remove <id>                 retract a boxed region
  cmd    [--stdin]                    POST a raw AgentCommand JSON body from stdin
  close | info | help
  --version                           print magpie's version as JSON

  Add --session <id> to target a specific session (default: most recent). It is
  accepted by every verb that acts on a session \u2014 not by open, sessions or help,
  which do not have one to target.

  Flags are scoped to their verb: extract's --pad is not accepted by say. A
  rejection lists what the verb it names does accept.

  Output: magpie prints JSON by default on stdout. Every verb writes ONE JSON
  document there \u2014 except \`tail\`, which is a stream and writes one per line
  (JSONL). Prose, liveness and diagnostics go to stderr. \`--full\`
  widens the state payload; it does not switch formats.`;
async function main(argv) {
  const [verb, ...rest] = argv;
  CURRENT_COMMAND = verb ?? null;
  if (verb === "--help" || verb === "-h") {
    process.stdout.write(`${HELP}
`);
    return 0;
  }
  if (verb === "--version" || verb === "-V") {
    printJson({ name: "magpie", version: PLUGIN_VERSION });
    return 0;
  }
  if (verb === undefined) {
    process.stderr.write(errorEnvelope("usage", "no verb given", { hint: "run: cli.ts help", choices: VERBS }));
    return 2;
  }
  if (!isVerb(verb)) {
    process.stderr.write(errorEnvelope("usage", `unknown verb "${verb}"`, {
      hint: "run: cli.ts help",
      choices: VERBS
    }));
    return 2;
  }
  let pos;
  let flags;
  try {
    ({ pos, flags } = parseArgs(rest, verb));
  } catch (e) {
    if (!(e instanceof UsageError))
      throw e;
    process.stderr.write(errorEnvelope("usage", e.message, {
      hint: `flags are scoped to the verb \u2014 choices lists what \`${verb}\` accepts; for free text containing dashes use --stdin, or put it after a bare --`,
      choices: flagsFor(verb)
    }));
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
    case "say": {
      const text = flags.stdin === true ? await readStdin() : pos.join(" ");
      if (!text)
        die("usage: say <text...> | say --stdin");
      await postCmd(session, { type: "say", text });
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
    case "status":
      await postCmd(session, {
        type: "status",
        busy: pos[0] === "on",
        text: pos.slice(1).join(" ")
      });
      break;
    case "source":
      if (!pos.length)
        die("usage: source <imagePath>");
      await cmdSource(session, pos[0]);
      break;
    case "discover":
      await cmdDiscover(session);
      break;
    case "extract":
      await cmdExtract(session, flags);
      break;
    case "export":
      await cmdExport(session, flags);
      break;
    case "element-add":
      await cmdElementAdd(session, flags);
      break;
    case "element-remove":
      if (!pos.length)
        die("usage: element-remove <id>");
      await postCmd(session, { type: "element.remove", id: pos[0] });
      break;
    case "cmd": {
      const raw = flags.stdin === true ? await readStdin() : pos.join(" ");
      if (!raw)
        die("usage: cmd --stdin  (pipe a JSON AgentCommand body)");
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        die("cmd: body is not valid JSON");
      }
      await postCmd(session, body);
      break;
    }
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
      process.stdout.write(`${HELP}
`);
      break;
    default:
      die(`no handler for verb "${verb}"`, "internal");
  }
  return 0;
}
if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
async function run() {
  return await main(process.argv.slice(2));
}
export {
  run,
  parseArgs,
  main,
  cutoutFilename,
  VERB_SPEC
};

//# debugId=CC84C23C90F7F80464756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL21hZ3BpZS9iYWNrZW5kL2NsaS50cyIsICIuLi9zY3JpcHRzL2JhY2tlbmQudHMiLCAiLi4vc2hhcmVkL2FscGhhLnRzIiwgIi4uL3NjcmlwdHMvZGlzY292ZXIudHMiLCAiLi4vc2hhcmVkL3R5cGVzLnRzIiwgIi4uL3NjcmlwdHMvcmVkdWNlLnRzIiwgIi4uL3NoYXJlZC92ZXJzaW9ucy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L2xpYi9wcmludEpzb24udHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiIyEvdXNyL2Jpbi9lbnYgYnVuXG5cbi8vIG1hZ3BpZSBDTEkg4oCUIHRoaW4sIHN0YXRlbGVzcyB3cmFwcGVyIGFyb3VuZCB0aGUgcGVyLXNlc3Npb24gZGFlbW9uJ3MgSFRUUFxuLy8gc3VyZmFjZSAoc2VydmVyLnRzKS4gT25lIEhUVFAgcm91bmQtdHJpcCBwZXIgdmVyYi4gYHRhaWxgIHN0cmVhbXMgU1NFIHVzZXJcbi8vIGV2ZW50cyBhcyBKU09OTCBmb3IgTW9uaXRvciB0byB3cmFwIChhIGBncm91bmRpbmdgIGFuY2hvciBsaW5lIGZpcnN0KS5cbi8vXG4vLyBMaWZlY3ljbGU6XG4vLyAgIGJ1biBjbGkudHMgb3BlbiBbLS10aXRsZSAuLl0gWy0taW50ZW50IC4uXSBbLS1yZXN0b3JlIDxpZD5dIFstLXRpbWVvdXQgU10gWy0tbm8tb3Blbl1cbi8vICAgYnVuIGNsaS50cyB0YWlsIFstLXNpbmNlIE5dICAgICAgICAgICAgIyBTU0UgdXNlciBldmVudHMg4oaSIEpTT05MIChNb25pdG9yIHRoaXMpXG4vLyAgIGJ1biBjbGkudHMgc3RhdGUgWy0tZnVsbF0gICAgICAgICAgICAgICMgbGVhbiBzdGF0ZSBzbmFwc2hvdCAoYWRkIC0tZnVsbCBmb3IgcmF3KVxuLy9cbi8vIERyaXZpbmcgdGhlIHN1cmZhY2UgKFBPU1QgL2NtZCk6XG4vLyAgIGJ1biBjbGkudHMgc2F5IFt0ZXh0Li4uXSBbLS1zdGRpbl0gICAgICAgICAgICAgICAgICMgcG9zdCBhZ2VudCBkaWFsb2d1ZSAodGV4dCBvciBwaXBlZCBzdGRpbilcbi8vICAgYnVuIGNsaS50cyBhc2sgPHRleHQuLi4+IFstLW9wdGlvbnMgXCJhfGJ8Y1wiXSAgICAgICAjIGFzayB0aGUgdXNlciAoaW4tdGhyZWFkKVxuLy8gICBidW4gY2xpLnRzIHN0YXR1cyBvbiBbdGV4dC4uLl0gfCBzdGF0dXMgb2ZmICAgICAgICAjIHRoZSB3b3JraW5nIHNwaW5uZXJcbi8vICAgYnVuIGNsaS50cyBzb3VyY2UgPGltYWdlUGF0aD4gICAgICAgICAgICAgICAgICAgICAgIyBzZXQgdGhlIGNvbXBvc2l0ZSB1bmRlciByZXZpZXcgKGNvbXB1dGVzIHNoYSArIHNpemUpXG4vLyAgIGJ1biBjbGkudHMgY21kIFstLXN0ZGluXSAgICAgICAgICAgICAgICAgICAgICAgICAgICAjIFBPU1QgYSByYXcgQWdlbnRDb21tYW5kIEpTT04gYm9keSAoZnJvbSBzdGRpbilcbi8vICAgYnVuIGNsaS50cyBjbG9zZSB8IGluZm8gfCBzZXNzaW9ucyB8IGhlbHBcbi8vXG4vLyBgLS1zdGRpbmAgcmVhZHMgdGhlIGJvZHkgZnJvbSBzdGRpbiBzbyBuYXR1cmFsLWxhbmd1YWdlIHRleHQgaXMgbmV2ZXIgaW5saW5lZFxuLy8gaW50byBhIHNoZWxsLXBhcnNlZCBhcmcuIFBheWxvYWQgb24gc3Rkb3V0LCBsaXZlbmVzcy9lY2hvIG9uIHN0ZGVyci5cbi8vXG4vLyBBbGwgdmVyYnMgdGFyZ2V0IHRoZSBtb3N0IHJlY2VudCBzZXNzaW9uIGJ5IGRlZmF1bHQ7IHBhc3MgLS1zZXNzaW9uIDxpZD4uXG5cbmltcG9ydCB7IHNwYXduIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHtcbiAgY29weUZpbGVTeW5jLFxuICBleGlzdHNTeW5jLFxuICBta2RpclN5bmMsXG4gIHJlYWRkaXJTeW5jLFxuICByZWFkRmlsZVN5bmMsXG4gIHJtU3luYyxcbiAgc3RhdFN5bmMsXG4gIHdyaXRlRmlsZVN5bmMsXG59IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgYmFzZW5hbWUsIGRpcm5hbWUsIGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoIH0gZnJvbSBcIm5vZGU6dXJsXCI7XG5pbXBvcnQgeyBwYXJzZUFyZ3MgYXMgbm9kZVBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcbmltcG9ydCB7XG4gIHR5cGUgQWxwaGFQb2xpY3ksXG4gIGlzTWVkaWFGb3JnZU1vZGVsLFxuICBtZWRpYUZvcmdlQmFja2VuZCxcbiAgcmVtYmdCYWNrZW5kLFxuICBzaG91bGRSZW1vdmUsXG59IGZyb20gXCIuLi8uLi8uLi9wbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvbWFncGllL3NjcmlwdHMvYmFja2VuZFwiO1xuaW1wb3J0IHsgRGlzY292ZXJFcnJvciwgZGlzY292ZXIgfSBmcm9tIFwiLi4vLi4vLi4vcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL21hZ3BpZS9zY3JpcHRzL2Rpc2NvdmVyXCI7XG5pbXBvcnQgeyBuZXdJZCB9IGZyb20gXCIuLi8uLi8uLi9wbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvbWFncGllL3NjcmlwdHMvcmVkdWNlXCI7XG5pbXBvcnQgdHlwZSB7IEVsZW1lbnQgfSBmcm9tIFwiLi4vLi4vLi4vcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL21hZ3BpZS9zaGFyZWQvdHlwZXNcIjtcbmltcG9ydCB7IGNob3NlblZlcnNpb24gfSBmcm9tIFwiLi4vLi4vLi4vcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL21hZ3BpZS9zaGFyZWQvdmVyc2lvbnNcIjtcbmltcG9ydCB7IHByaW50SnNvbiB9IGZyb20gXCIuLi8uLi9raXQvbGliL3ByaW50SnNvblwiO1xuXG4vLyBTd2FsbG93IEVQSVBFIChhIGRvd25zdHJlYW0gYGhlYWRgL01vbml0b3IgY2xvc2luZyBvdXIgc3Rkb3V0IHNob3VsZG4ndCBjcmFzaCkuXG5wcm9jZXNzLnN0ZG91dC5vbihcImVycm9yXCIsIChlOiBOb2RlSlMuRXJybm9FeGNlcHRpb24pID0+IHtcbiAgaWYgKGUuY29kZSA9PT0gXCJFUElQRVwiKSBwcm9jZXNzLmV4aXQoMCk7XG59KTtcblxuY29uc3QgU0NSSVBUX0RJUiA9IGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcbi8vIFNlZSB0aGUgYXN0cm9sYWJlIHR3aW46IGBkaXN0L2AgYW5kIGBzY3JpcHRzL2AgYXJlIHRoZSBzYW1lIGRlcHRoLCBzbyBvbmx5XG4vLyBhIFNJQkxJTkctcmVsYXRpdmUgcGF0aCBicmVha3Mgd2hlbiB0aGlzIGV4ZWN1dGVzIGFzIGAuLi9kaXN0L2NsaS5qc2AuXG5jb25zdCBTRVJWRVJfU0NSSVBUID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwic2NyaXB0c1wiLCBcInNlcnZlci50c1wiKTtcbmNvbnN0IFNLSUxMX1JPT1QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIik7XG5jb25zdCBESVNUX0RJUiA9IGpvaW4oU0tJTExfUk9PVCwgXCJkaXN0XCIpO1xuLy8gZGV2OiB0aGUgZGFlbW9uIHNlcnZlcyBhIEJ1bi1idW5kbGVkIFJlYWN0IHN1cmZhY2UsIGFuZCBCdW4gcmVhZHMgYnVuZmlnLnRvbWxcbi8vICh0aGUgVGFpbHdpbmQgcGx1Z2luKSBmcm9tIGN3ZCBPTkxZLCBzbyB0aGUgZGFlbW9uJ3MgY3dkIE1VU1QgYmUgc3JjL21hZ3BpZS9cbi8vIChzZWFtcyBDb250cmFjdCA1IGN3ZC1waW4pIOKAlCBsYXVuY2hlZCBhbnl3aGVyZSBlbHNlLCBUYWlsd2luZCBpcyBTSUxFTlRMWVxuLy8gc2tpcHBlZCBhbmQgdGhlIHN1cmZhY2UgcmVuZGVycyB1bnN0eWxlZC4gcmVsZWFzZTogZGlzdC8gaXMgcHJlLWJ1aWx0IGFuZFxuLy8gc3RhdGljIOKAlCBubyBidW5maWcgcmVhZCwgc28gdGhpcyBwYXRoIG5lZWQgbm90IGV4aXN0IGF0IGFsbCAoYSBzb3VyY2UtZnJlZVxuLy8gbWFya2V0cGxhY2UgY2xvbmUgaGFzIG5vIHRvcC1sZXZlbCBzcmMvKSwgYW5kIHBpbm5pbmcgY3dkIHRoZXJlIGFueXdheSB3b3VsZFxuLy8gYnJlYWsgdGhlIHNwYXduLlxuLy9cbi8vIOKblCBUSEUgRElTQ1JJTUlOQVRPUiBJUyBkaXN0L2luZGV4Lmh0bWwsIE5PVCBkaXN0Ly4gbWFncGllJ3MgZGlzdC8gaGFzIGhlbGRcbi8vIGNsaS5qcyBzaW5jZSBTbGljZSAyIHdpdGggbm8gaW5kZXguaHRtbCwgd2hpY2ggaXMgZXhhY3RseSB3aHkgdGhpcyBkYWVtb25cbi8vIHN0YXllZCBjb3JyZWN0bHkgaW4gZGV2IG1vZGU7IHRoZSBmaXJzdCBzdXJmYWNlIGJ1aWxkIHRvIGxhbmQgaGVyZSBmbGlwcyBpdC5cbmNvbnN0IFNVUkZBQ0VfQ1dEID0gam9pbihTS0lMTF9ST09ULCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwic3JjXCIsIFwibWFncGllXCIpO1xuXG5mdW5jdGlvbiBkYWVtb25Dd2QoKTogc3RyaW5nIHtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwicmVsZWFzZVwiKSByZXR1cm4gU0tJTExfUk9PVDtcbiAgaWYgKHByb2Nlc3MuZW52LlNQRUxMQk9PS19TVVJGQUNFX01PREUgPT09IFwiZGV2XCIpIHJldHVybiBTVVJGQUNFX0NXRDtcbiAgcmV0dXJuIGV4aXN0c1N5bmMoam9pbihESVNUX0RJUiwgXCJpbmRleC5odG1sXCIpKSA/IFNLSUxMX1JPT1QgOiBTVVJGQUNFX0NXRDtcbn1cblxuLy8gT3VyIHBsdWdpbiB2ZXJzaW9uIChmcm9tIHBsdWdpbi5qc29uKSDigJQgdGhlIG9uZSBudW1iZXIgbWFncGllIGNhbiBob25lc3RseVxuLy8gcmVwb3J0IGFzIGl0cyBvd24uIEQxIGFza3MgYSBDTEkgdG8gYW5zd2VyIGAtLXZlcnNpb25gOyBhbiBhZ2VudCB0aGF0IGNhbm5vdFxuLy8gdGVsbCB3aGljaCBidWlsZCBpdCBpcyBkcml2aW5nIGNhbm5vdCB0ZWxsIGEgbWlzc2luZyBmZWF0dXJlIGZyb20gYSBzdGFsZVxuLy8gaW5zdGFsbC4gQmVzdC1lZmZvcnQ6IG51bGwgaWYgdGhlIHJlYWQgZmFpbHMsIGFuZCBgLS12ZXJzaW9uYCBzYXlzIHNvIHJhdGhlclxuLy8gdGhhbiBpbnZlbnRpbmcgb25lLiBTYW1lIHJlc29sdXRpb24gZ3JhcGV2aW5lIHVzZXMuXG5mdW5jdGlvbiByZWFkUGx1Z2luVmVyc2lvbigpOiBzdHJpbmcgfCBudWxsIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBwbHVnaW5Kc29uUGF0aCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuY2xhdWRlLXBsdWdpblwiLCBcInBsdWdpbi5qc29uXCIpO1xuICAgIHJldHVybiBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwbHVnaW5Kc29uUGF0aCwgXCJ1dGYtOFwiKSkudmVyc2lvbiA/PyBudWxsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuY29uc3QgUExVR0lOX1ZFUlNJT04gPSByZWFkUGx1Z2luVmVyc2lvbigpO1xuXG50eXBlIFNlc3Npb24gPSB7XG4gIHVybDogc3RyaW5nO1xuICBwb3J0OiBudW1iZXI7XG4gIHNlc3Npb25faWQ6IHN0cmluZztcbiAgdGl0bGU6IHN0cmluZztcbiAgZmlsZXNfZGlyPzogc3RyaW5nO1xufTtcblxuLy8g4pSA4pSAIGVycm9yIGVudmVsb3BlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy9cbi8vIG1hZ3BpZSBkZWNsYXJlcyBgZGVmYXVsdE91dHB1dDogXCJqc29uXCJgLCBhbmQgdGhhdCBkZWNsYXJhdGlvbiBpcyBhYm91dCBFVkVSWVxuLy8gc3RyZWFtLCBub3QganVzdCB0aGUgaGFwcHkgcGF0aC4gQSBjYWxsZXIgdGhhdCBnZXRzIG9uZSBKU09OIGRvY3VtZW50IGZyb20gYVxuLy8gdmVyYiBhbmQgcHJvc2UgZnJvbSBhIGZhaWx1cmUgaGFzIHRvIHBhcnNlIHR3byBmb3JtYXRzIHRvIHVzZSBvbmUgdG9vbCDigJQgYW5kXG4vLyB0aGUgZmFpbHVyZSBpcyB0aGUgY2FzZSB3aGVyZSBpdCBjYW4gbGVhc3QgYWZmb3JkIHRvIGd1ZXNzLiBTbyBhIGZhaWx1cmUgaXNcbi8vIE9ORSBKU09OIGRvY3VtZW50IG9uIHN0ZGVyciwgYW5kIHN0ZG91dCBzdGF5cyBlbXB0eSBiZWNhdXNlIHN0ZG91dCBjYXJyaWVzXG4vLyBkYXRhIGFuZCBhIGZhaWx1cmUgaGFzIG5vbmUuXG4vL1xuLy8gYGtpbmRgIGlzIHRoZSBjb250cmFjdDsgYG1lc3NhZ2VgIGlzIHByZXNlbnRhdGlvbi4gUmV3b3JkaW5nIGEgbWVzc2FnZSBtdXN0XG4vLyBuZXZlciBicmVhayBhIGNhbGxlciwgd2hpY2ggaXQgZG9lcyB0aGUgbW9tZW50IGFueW9uZSBtYXRjaGVzIG9uIHByb3NlLlxuLy8gRXhpdCBjb2RlcyBmb2xsb3cgdGhlIGFjYyB0YXhvbm9teTogdXNhZ2UgZXJyb3JzIGFyZSB0aGUgY2FsbGVyJ3MgdG8gZml4IGJ5XG4vLyBjaGFuZ2luZyB0aGUgY29tbWFuZCwgaW50ZXJuYWwgZmF1bHRzIGFyZSBub3QsIGFuZCBjb2xsYXBzaW5nIHRoZW0gaW50byBvbmVcbi8vIG51bWJlciBsZWF2ZXMgYW4gYWdlbnQgd2l0aCBub3RoaW5nIHRvIHJvdXRlIG9uLlxudHlwZSBFcnJLaW5kID0gXCJ1c2FnZVwiIHwgXCJpbnRlcm5hbFwiIHwgXCJub3RfZm91bmRcIiB8IFwiY29uZmxpY3RcIjtcblxuY29uc3QgRVhJVF9GT1I6IFJlY29yZDxFcnJLaW5kLCBudW1iZXI+ID0ge1xuICB1c2FnZTogMiwgLy8gdGhlIGNhbGxlciBjYW4gZml4IHRoaXMgYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmRcbiAgaW50ZXJuYWw6IDEsIC8vIG1hZ3BpZSBicm9rZTsgdGhlIGludm9jYXRpb24gbWF5IGhhdmUgYmVlbiBmaW5lXG4gIG5vdF9mb3VuZDogNSwgLy8gdGhlIG5hbWVkIHRoaW5nIGRvZXMgbm90IGV4aXN0XG4gIGNvbmZsaWN0OiA2LCAvLyBhIHByZWNvbmRpdGlvbiBmYWlsZWRcbn07XG5cbi8vIFRoZSB2ZXJiIHVuZGVyIGV4ZWN1dGlvbiwgc28gdGhlIGVudmVsb3BlIGNhbiBuYW1lIGl0LiBTZXQgb25jZSBieSBtYWluKCkuXG5sZXQgQ1VSUkVOVF9DT01NQU5EOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuZnVuY3Rpb24gZXJyb3JFbnZlbG9wZShcbiAga2luZDogRXJyS2luZCxcbiAgbWVzc2FnZTogc3RyaW5nLFxuICBleHRyYT86IHsgaGludD86IHN0cmluZzsgY2hvaWNlcz86IHN0cmluZ1tdIH0sXG4pOiBzdHJpbmcge1xuICByZXR1cm4gYCR7SlNPTi5zdHJpbmdpZnkoe1xuICAgIG9rOiBmYWxzZSxcbiAgICBlcnJvcjoge1xuICAgICAga2luZCxcbiAgICAgIGV4aXRfY29kZTogRVhJVF9GT1Jba2luZF0sXG4gICAgICAvLyBPbmx5IHJhdGUgbGltaXRzIGFyZSB3b3J0aCByZXRyeWluZyB1bmNoYW5nZWQ7IG5vdGhpbmcgbWFncGllIHJhaXNlcyBpcy5cbiAgICAgIHJldHJ5YWJsZTogZmFsc2UsXG4gICAgICBtZXNzYWdlLFxuICAgICAgLi4uKGV4dHJhPy5oaW50ID8geyBoaW50OiBleHRyYS5oaW50IH0gOiB7fSksXG4gICAgICAuLi4oZXh0cmE/LmNob2ljZXMgPyB7IGNob2ljZXM6IGV4dHJhLmNob2ljZXMgfSA6IHt9KSxcbiAgICB9LFxuICAgIG1ldGE6IHsgY29tbWFuZDogQ1VSUkVOVF9DT01NQU5EIH0sXG4gIH0pfVxcbmA7XG59XG5cbmZ1bmN0aW9uIGRpZShcbiAgbXNnOiBzdHJpbmcsXG4gIGtpbmQ6IEVycktpbmQgPSBcInVzYWdlXCIsXG4gIGV4dHJhPzogeyBoaW50Pzogc3RyaW5nOyBjaG9pY2VzPzogc3RyaW5nW10gfSxcbik6IG5ldmVyIHtcbiAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoZXJyb3JFbnZlbG9wZShraW5kLCBtc2csIGV4dHJhKSk7XG4gIHByb2Nlc3MuZXhpdChFWElUX0ZPUltraW5kXSk7XG59XG5cbmZ1bmN0aW9uIHNsZWVwKG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+IHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIG1zKSk7XG59XG5cbmZ1bmN0aW9uIHNlc3Npb25GaWxlUGF0aChzZXNzaW9uPzogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHNlc3Npb24gPyBqb2luKHRtcGRpcigpLCBgbWFncGllLSR7c2Vzc2lvbn0uanNvbmApIDogam9pbih0bXBkaXIoKSwgXCJtYWdwaWUtbGF0ZXN0Lmpzb25cIik7XG59XG5cbmZ1bmN0aW9uIHJlYWRTZXNzaW9uKHNlc3Npb24/OiBzdHJpbmcpOiBTZXNzaW9uIHwgbnVsbCB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHNlc3Npb25GaWxlUGF0aChzZXNzaW9uKSwgXCJ1dGY4XCIpKSBhcyBTZXNzaW9uO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5mdW5jdGlvbiByZXF1aXJlU2Vzc2lvbihzZXNzaW9uPzogc3RyaW5nKTogU2Vzc2lvbiB7XG4gIGNvbnN0IHMgPSByZWFkU2Vzc2lvbihzZXNzaW9uKTtcbiAgaWYgKCFzKSBkaWUoXCJubyBydW5uaW5nIG1hZ3BpZSBzZXNzaW9uIOKAlCBydW46IGNsaS50cyBvcGVuXCIsIFwibm90X2ZvdW5kXCIpO1xuICByZXR1cm4gcztcbn1cblxuYXN5bmMgZnVuY3Rpb24gYXBpKFxuICBwb3J0OiBudW1iZXIsXG4gIG1ldGhvZDogc3RyaW5nLFxuICBwYXRoOiBzdHJpbmcsXG4gIGJvZHk/OiB1bmtub3duLFxuKTogUHJvbWlzZTx7IHN0YXR1czogbnVtYmVyOyBkYXRhOiB1bmtub3duIH0+IHtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fSR7cGF0aH1gLCB7XG4gICAgbWV0aG9kLFxuICAgIGhlYWRlcnM6IGJvZHkgIT09IHVuZGVmaW5lZCA/IHsgXCJjb250ZW50LXR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSA6IHVuZGVmaW5lZCxcbiAgICBib2R5OiBib2R5ICE9PSB1bmRlZmluZWQgPyBKU09OLnN0cmluZ2lmeShib2R5KSA6IHVuZGVmaW5lZCxcbiAgfSk7XG4gIGxldCBkYXRhOiB1bmtub3duID0gbnVsbDtcbiAgdHJ5IHtcbiAgICBkYXRhID0gYXdhaXQgcmVzLmpzb24oKTtcbiAgfSBjYXRjaCB7fVxuICByZXR1cm4geyBzdGF0dXM6IHJlcy5zdGF0dXMsIGRhdGEgfTtcbn1cblxuLy8gU3BsaXQgYXJndiBpbnRvIHBvc2l0aW9uYWxzICsgZmxhZ3MuIGAtLWZsYWcgdmFsdWVgLCBgLS1mbGFnPXZhbHVlYCwgb3IgYm9vbGVhbi5cbi8vICM4MSAvIEQ0IOKAlCBUSEUgUkVDT0dOSVpFRCBTRVQsIEFUIFBBUlNFUiBBTFRJVFVERS5cbi8vXG4vLyBUaGUgaGFuZC1yb2xsZWQgcGFyc2VyIGhhZCBubyByZWdpc3RyeSwgc28gYW4gdW5rbm93biBmbGFnIHdhcyBhY2NlcHRlZCBhdFxuLy8gZXhpdCAwIGFuZCB0aGUgdmVyYiByYW4gYW55d2F5LCBhbmQgZnJlZSBwcm9zZSBjb250YWluaW5nIGEgYC0td29yZGAgd2FzXG4vLyBzaWxlbnRseSB0cnVuY2F0ZWQgYXQgdGhhdCB3b3JkLiBgbm9kZTp1dGlsYCBzdHJpY3Qgc3VwcGxpZXMgcmVqZWN0aW9uLCB0aGVcbi8vIGA9YCBmb3JtIGFuZCB0aGUgYC0tYCB0ZXJtaW5hdG9yIGZyb20gdGhlIHN0YW5kYXJkIGxpYnJhcnkuXG4vL1xuLy8gVHlwZXMgYXJlIHRob3RoJ3MgYXVkaXRlZCBhcnRpZmFjdCAoMTUgc3RyaW5nIMK3IDQgYm9vbGVhbiksIGVhY2ggc2V0dGxlZCBieVxuLy8gdW5hbWJpZ3VvdXMgZXZpZGVuY2UgYXQgZXZlcnkgY29uc3VtcHRpb24gc2l0ZS4gR2V0dGluZyBvbmUgd3JvbmcgaXMgbm90IGFcbi8vIG5vLW9wOiBhIFwic3RyaW5nXCIgdGhhdCBzaG91bGQgYmUgYm9vbGVhbiBTV0FMTE9XUyBUSEUgTkVYVCBQT1NJVElPTkFMLCBhbmQgYVxuLy8gXCJib29sZWFuXCIgdGhhdCBzaG91bGQgYmUgc3RyaW5nIGJyZWFrcyB0aGUgc3BhY2UgZm9ybS5cbmNvbnN0IENMSV9PUFRJT05TID0ge1xuICBhbHBoYTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGJib3g6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBpZHM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBpbnRlbnQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBsYWJlbDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIG1vZGVsOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbmFtZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIG9wdGlvbnM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBwYWQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICByZXN0b3JlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc2Vzc2lvbjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHNpbmNlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdGltZW91dDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRpdGxlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdHlwZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGZ1bGw6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgXCJuby1vcGVuXCI6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgcmVtb3ZlOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHN0ZGluOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG59IGFzIGNvbnN0O1xuXG4vLyBXSElDSCBGTEFHUyBFQUNIIFZFUkIgQUNDRVBUUyDigJQgYW5kIHRoZSBvbmx5IHNvdXJjZSBvZiB0aGUgdmVyYiBzZXQuXG4vL1xuLy8gVGhlIHBhcnNlciB1c2VkIHRvIGVuZm9yY2UgT05FIEdMT0JBTCByZWdpc3RyeTogZXZlcnkgdmVyYiBhY2NlcHRlZCBldmVyeVxuLy8gZmxhZywgc28gYGNsb3NlIC0tYWxwaGEgYXV0b2AgYW5kIGBzYXkgLS1iYm94IDEsMiwzLDRgIHBhcnNlZCBjbGVhbiBhbmQgZGlkXG4vLyBub3RoaW5nLiBBIHJlY29yZGVkLXN1cmZhY2UgY2Vuc3VzIGNvdW50ZWQgMjg5IHN1Y2ggZmxhZy9wYXRoIHBhaXJzIOKAlCAyODlcbi8vIGludm9jYXRpb25zIG1hZ3BpZSBhY2NlcHRlZCBhdCBleGl0IDAgYW5kIGNvdWxkIG5vdCBhY3Qgb24uIFRoYXQgaXMgdGhlXG4vLyBmYWlsdXJlIHRoaXMgd2hvbGUga2l0IGlzIG5hbWVkIGZvcjogdGhlIHRvb2wgZG9lcyB0aGUgd3JvbmcgdGhpbmcgYW5kIHJlcG9ydHNcbi8vIHN1Y2Nlc3MuIEFuIHVua25vd24tZmxhZyBjaGVjayBhdCB0aGUgcm9vdCBjYW5ub3Qgc2VlIGl0LCBiZWNhdXNlIG5vbmUgb2YgdGhlXG4vLyBmbGFncyBhcmUgdW5rbm93biDigJQgdGhleSBhcmUganVzdCBub3Qga25vd24gSEVSRS5cbi8vXG4vLyBTbyB0aGUgcmVjb2duaXplZCBzZXQgaXMgcGVyIHZlcmIsIGFuZCB0aGlzIHRhYmxlIGlzIGl0LiBgVkVSQlNgIGlzIGRlcml2ZWRcbi8vIGZyb20gaXRzIGtleXMgYW5kIGVhY2ggdmVyYiBwYXJzZXMgYWdhaW5zdCBpdHMgb3duIG9wdGlvbnMsIHdoaWNoIG1lYW5zIHRoZVxuLy8gaGVscCB0ZXh0LCB0aGUgcmVqZWN0aW9uJ3MgYGNob2ljZXNgIGFuZCB0aGUgcGFyc2VyIGNhbiBubyBsb25nZXIgZGlzYWdyZWU6XG4vLyB0aGVyZSBpcyBvbmUgb2JqZWN0LCBhbmQgYWRkaW5nIGEgZmxhZyB0byBhIHZlcmIgaXMgb25lIGVkaXQuXG5leHBvcnQgY29uc3QgVkVSQl9TUEVDID0ge1xuICBvcGVuOiBbXCJ0aXRsZVwiLCBcImludGVudFwiLCBcInRpbWVvdXRcIiwgXCJyZXN0b3JlXCIsIFwibm8tb3BlblwiXSxcbiAgc2Vzc2lvbnM6IFtdLFxuICB0YWlsOiBbXCJzZXNzaW9uXCIsIFwic2luY2VcIl0sXG4gIHN0YXRlOiBbXCJzZXNzaW9uXCIsIFwiZnVsbFwiXSxcbiAgc2F5OiBbXCJzZXNzaW9uXCIsIFwic3RkaW5cIl0sXG4gIGFzazogW1wic2Vzc2lvblwiLCBcIm9wdGlvbnNcIl0sXG4gIHN0YXR1czogW1wic2Vzc2lvblwiXSxcbiAgc291cmNlOiBbXCJzZXNzaW9uXCJdLFxuICBkaXNjb3ZlcjogW1wic2Vzc2lvblwiXSxcbiAgZXh0cmFjdDogW1wic2Vzc2lvblwiLCBcImlkc1wiLCBcInJlbW92ZVwiLCBcImFscGhhXCIsIFwicGFkXCIsIFwibW9kZWxcIiwgXCJsYWJlbFwiXSxcbiAgZXhwb3J0OiBbXCJzZXNzaW9uXCIsIFwiaWRzXCJdLFxuICBcImVsZW1lbnQtYWRkXCI6IFtcInNlc3Npb25cIiwgXCJiYm94XCIsIFwibmFtZVwiLCBcInR5cGVcIl0sXG4gIFwiZWxlbWVudC1yZW1vdmVcIjogW1wic2Vzc2lvblwiXSxcbiAgY21kOiBbXCJzZXNzaW9uXCIsIFwic3RkaW5cIl0sXG4gIGNsb3NlOiBbXCJzZXNzaW9uXCJdLFxuICBpbmZvOiBbXCJzZXNzaW9uXCJdLFxuICBoZWxwOiBbXSxcbn0gYXMgY29uc3Qgc2F0aXNmaWVzIFJlY29yZDxzdHJpbmcsIHJlYWRvbmx5IChrZXlvZiB0eXBlb2YgQ0xJX09QVElPTlMpW10+O1xuXG50eXBlIFZlcmIgPSBrZXlvZiB0eXBlb2YgVkVSQl9TUEVDO1xuXG5jb25zdCBWRVJCUyA9IE9iamVjdC5rZXlzKFZFUkJfU1BFQykgYXMgVmVyYltdO1xuXG5jb25zdCBpc1ZlcmIgPSAodjogc3RyaW5nKTogdiBpcyBWZXJiID0+IE9iamVjdC5oYXNPd24oVkVSQl9TUEVDLCB2KTtcblxuLy8gVGhlIGZsYWdzIG9uZSB2ZXJiIGFjY2VwdHMsIGFzIHRoZSBjYWxsZXIgc3BlbGxzIHRoZW0uXG5jb25zdCBmbGFnc0ZvciA9ICh2ZXJiOiBWZXJiKTogc3RyaW5nW10gPT4gVkVSQl9TUEVDW3ZlcmJdLm1hcCgoaykgPT4gYC0tJHtrfWApLnNvcnQoKTtcblxuY2xhc3MgVXNhZ2VFcnJvciBleHRlbmRzIEVycm9yIHt9XG5cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUFyZ3MoXG4gIGFyZ3M6IHN0cmluZ1tdLFxuICB2ZXJiPzogVmVyYixcbik6IHtcbiAgcG9zOiBzdHJpbmdbXTtcbiAgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+O1xufSB7XG4gIC8vIFRXTyBTVEFHRVMsIEFORCBUSEUgT1JERVIgSVMgVEhFIFBPSU5ULlxuICAvL1xuICAvLyBTdGFnZSAxIHBhcnNlcyBhZ2FpbnN0IHRoZSBXSE9MRSByZWdpc3RyeSwgc28gYSB0b2tlbiBtYWdwaWUgaGFzIG5ldmVyXG4gIC8vIGhlYXJkIG9mIGlzIHJlZnVzZWQgYnkgYG5vZGU6dXRpbGAgd2l0aCBpdHMgb3duIG1lc3NhZ2UuIFN0YWdlIDIgdGhlbiBhc2tzXG4gIC8vIHRoZSBxdWVzdGlvbiB0aGUgcGFyc2VyIGNhbm5vdDogaXMgdGhpcyBmbGFnIGFjY2VwdGVkIEFUIFRISVMgVkVSQi5cbiAgLy9cbiAgLy8gRG9pbmcgaXQgdGhlIG90aGVyIHdheSDigJQgaGFuZGluZyBwYXJzZUFyZ3MgYSBwZXItdmVyYiBzdWJzZXQg4oCUIHdhcyB0aGUgZmlyc3RcbiAgLy8gc2hhcGUsIGFuZCBpdCBhbnN3ZXJlZCBgc2F5IC0tYmJveGAgd2l0aCBcIlVua25vd24gb3B0aW9uICctLWJib3gnXCIsIHdoaWNoIGlzXG4gIC8vIGZhbHNlLiBgLS1iYm94YCBpcyBhIHBlcmZlY3RseSBnb29kIGZsYWc7IGl0IGp1c3QgaXMgbm90IGBzYXlgJ3MuIEFuIGFnZW50XG4gIC8vIHRvbGQgYSByZWFsIGZsYWcgaXMgdW5rbm93biBnb2VzIGxvb2tpbmcgZm9yIGEgdHlwbyBpdCBkaWQgbm90IG1ha2UuXG4gIC8vXG4gIC8vIEl0IGFsc28gY29zdCB0aGUgZ3JpbW9pcmUncyBmbGFnLWludmFyaWFudCB3YXJkIGl0cyBmb290aW5nOiB0aGF0IGNoZWNrXG4gIC8vIHJlc29sdmVzIGBvcHRpb25zOiA8aWRlbnRpZmllcj5gIGJhY2sgdG8gYSBsaXRlcmFsIGRlY2xhcmF0aW9uLCBhbmQgYSBzdWJzZXRcbiAgLy8gY29tcHV0ZWQgYXQgdGhlIGNhbGwgc2l0ZSBpcyBub3Qgb25lLiBUaGUgd2FyZCBjb3VsZCBubyBsb25nZXIgcmVhZCBtYWdwaWUnc1xuICAvLyByZWdpc3RyeSBhdCBhbGwgYW5kIHJlcG9ydGVkIHRoZSBlbnRyeSBwb2ludCB1bnJlc29sdmVkIOKAlCB0aGUgaW5zdHJ1bWVudFxuICAvLyBzYXlpbmcgXCJJIGNhbm5vdCBzZWUgdGhpc1wiLCBleGFjdGx5IGFzIGRlc2lnbmVkLiBLZWVwaW5nIGBDTElfT1BUSU9OU2AgYXRcbiAgLy8gdGhlIGNhbGwgc2l0ZSBrZWVwcyB0aGUgcmVnaXN0cnkgbGVnaWJsZSB0byBpdC5cbiAgbGV0IHBhcnNlZDogeyB2YWx1ZXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+OyBwb3NpdGlvbmFsczogc3RyaW5nW10gfTtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBub2RlUGFyc2VBcmdzKHtcbiAgICAgIGFyZ3MsXG4gICAgICBvcHRpb25zOiBDTElfT1BUSU9OUyxcbiAgICAgIHN0cmljdDogdHJ1ZSxcbiAgICAgIGFsbG93UG9zaXRpb25hbHM6IHRydWUsXG4gICAgfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICB0aHJvdyBuZXcgVXNhZ2VFcnJvcihlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkpO1xuICB9XG5cbiAgaWYgKHZlcmIpIHtcbiAgICBjb25zdCBhbGxvd2VkID0gbmV3IFNldDxzdHJpbmc+KFZFUkJfU1BFQ1t2ZXJiXSk7XG4gICAgY29uc3Qgc3RyYXkgPSBPYmplY3Qua2V5cyhwYXJzZWQudmFsdWVzKS5maW5kKChrKSA9PiAhYWxsb3dlZC5oYXMoaykpO1xuICAgIGlmIChzdHJheSkge1xuICAgICAgdGhyb3cgbmV3IFVzYWdlRXJyb3IoXG4gICAgICAgIGAtLSR7c3RyYXl9IGlzIG5vdCBhY2NlcHRlZCBieSBcXGAke3ZlcmJ9XFxgIChpdCBpcyBhIHJlY29nbml6ZWQgbWFncGllIGZsYWcsIGp1c3Qgbm90IHRoaXMgdmVyYidzKWAsXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiB7XG4gICAgcG9zOiBwYXJzZWQucG9zaXRpb25hbHMsXG4gICAgZmxhZ3M6IHBhcnNlZC52YWx1ZXMgYXMgUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4sXG4gIH07XG59XG5cbi8vIFJlYWQgYWxsIG9mIHN0ZGluIGFzIHRleHQgKEJ1bi5zdGRpbikuIFVzZWQgYnkgYC0tc3RkaW5gIHNvIE5MIHRleHQgaXNuJ3QgYVxuLy8gc2hlbGwtcGFyc2VkIGFyZy5cbmFzeW5jIGZ1bmN0aW9uIHJlYWRTdGRpbigpOiBQcm9taXNlPHN0cmluZz4ge1xuICByZXR1cm4gKGF3YWl0IEJ1bi5zdGRpbi50ZXh0KCkpLnRyaW0oKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcG9zdENtZChzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsIG1zZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIHtcbiAgY29uc3QgcyA9IHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pO1xuICBjb25zdCB7IHN0YXR1cyB9ID0gYXdhaXQgYXBpKHMucG9ydCwgXCJQT1NUXCIsIFwiL2NtZFwiLCBtc2cpO1xuICBpZiAoc3RhdHVzICE9PSAyMDApIGRpZShgY21kIGZhaWxlZCAoSFRUUCAke3N0YXR1c30pIOKAlCBpcyB0aGUgc2Vzc2lvbiBzdGlsbCBhbGl2ZT9gLCBcImludGVybmFsXCIpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgc2VudDogbXNnLnR5cGUgfSk7XG59XG5cbi8vIOKUgOKUgCB2ZXJicyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuYXN5bmMgZnVuY3Rpb24gY21kT3BlbihmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgYXJncyA9IFtcInJ1blwiLCBTRVJWRVJfU0NSSVBUXTtcbiAgaWYgKGZsYWdzLnRpdGxlKSBhcmdzLnB1c2goXCItLXRpdGxlXCIsIFN0cmluZyhmbGFncy50aXRsZSkpO1xuICBpZiAoZmxhZ3MuaW50ZW50KSBhcmdzLnB1c2goXCItLWludGVudFwiLCBTdHJpbmcoZmxhZ3MuaW50ZW50KSk7XG4gIGlmIChmbGFncy50aW1lb3V0KSBhcmdzLnB1c2goXCItLXRpbWVvdXRcIiwgU3RyaW5nKGZsYWdzLnRpbWVvdXQpKTtcbiAgaWYgKGZsYWdzLnJlc3RvcmUpIGFyZ3MucHVzaChcIi0tcmVzdG9yZVwiLCBTdHJpbmcoZmxhZ3MucmVzdG9yZSkpO1xuICBpZiAoZmxhZ3NbXCJuby1vcGVuXCJdKSBhcmdzLnB1c2goXCItLW5vLW9wZW5cIik7XG5cbiAgY29uc3QgcHJldklkID0gcmVhZFNlc3Npb24oKT8uc2Vzc2lvbl9pZDtcbiAgLy8gRGV0YWNoZWQgbm9kZTpjaGlsZF9wcm9jZXNzIChub3QgQnVuLnNwYXduKSBzbyB0aGUgZGFlbW9uIFNVUlZJVkVTIHRoaXMgQ0xJXG4gIC8vIHByb2Nlc3MgZXhpdGluZyDigJQgdGhlIGhvdXNlIHBhdHRlcm4gZm9yIGEgc3RhbmRpbmcgZGFlbW9uLiBjd2QgcGlubmVkIHRvIHRoZVxuICAvLyBza2lsbCByb290IHNvIEJ1biBmaW5kcyBidW5maWcudG9tbCAocmVnaXN0ZXJzIGJ1bi1wbHVnaW4tdGFpbHdpbmQpLlxuICBjb25zdCBwcm9jID0gc3Bhd24ocHJvY2Vzcy5leGVjUGF0aCwgYXJncywge1xuICAgIGRldGFjaGVkOiB0cnVlLFxuICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJpZ25vcmVcIiwgXCJpZ25vcmVcIl0sXG4gICAgZW52OiBwcm9jZXNzLmVudixcbiAgICAvLyBDb250cmFjdCA1IOKAlCBzZWUgZGFlbW9uQ3dkKCkuIFRIRSBGQUlMVVJFIElTIFNJTEVOVDogYSB3cm9uZyBjd2Qgc2tpcHNcbiAgICAvLyB0aGUgVGFpbHdpbmQgcGx1Z2luIGFuZCB0aGUgYm9hcmQgcmVuZGVycyB1bnN0eWxlZCBhdCBIVFRQIDIwMC5cbiAgICBjd2Q6IGRhZW1vbkN3ZCgpLFxuICB9KTtcbiAgcHJvYy51bnJlZigpO1xuXG4gIGNvbnN0IGRlYWRsaW5lID0gRGF0ZS5ub3coKSArIDUwMDA7XG4gIHdoaWxlIChEYXRlLm5vdygpIDwgZGVhZGxpbmUpIHtcbiAgICBhd2FpdCBzbGVlcCg4MCk7XG4gICAgY29uc3QgcyA9IHJlYWRTZXNzaW9uKCk7XG4gICAgaWYgKHMgJiYgcy5zZXNzaW9uX2lkICE9PSBwcmV2SWQpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3MucG9ydH0vc3RhdGVgKTtcbiAgICAgICAgaWYgKHIub2spIHtcbiAgICAgICAgICBwcmludEpzb24ocyk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogbm90IHVwIHlldCAqL1xuICAgICAgfVxuICAgIH1cbiAgfVxuICBkaWUoXCJtYWdwaWUgc2VydmVyIGZhaWxlZCB0byBzdGFydCB3aXRoaW4gNXNcIiwgXCJpbnRlcm5hbFwiKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kU3RhdGUoc2Vzc2lvbj86IHN0cmluZywgZnVsbCA9IGZhbHNlKSB7XG4gIGNvbnN0IHMgPSByZXF1aXJlU2Vzc2lvbihzZXNzaW9uKTtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaShzLnBvcnQsIFwiR0VUXCIsIGAvc3RhdGUke2Z1bGwgPyBcIlwiIDogXCI/bGVhbj0xXCJ9YCk7XG4gIGlmIChzdGF0dXMgIT09IDIwMCkgZGllKGBzdGF0ZSBmYWlsZWQgKEhUVFAgJHtzdGF0dXN9KWAsIFwiaW50ZXJuYWxcIik7XG4gIHByaW50SnNvbihkYXRhKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kVGFpbChzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsIHNpbmNlQXJnOiBudW1iZXIpIHtcbiAgbGV0IHNpbmNlID0gc2luY2VBcmc7XG4gIGxldCBkZWxheSA9IDI1MDtcbiAgbGV0IHN0b3BwZWQgPSBmYWxzZTtcbiAgbGV0IGJvdW5kSWQgPSBzZXNzaW9uO1xuICBsZXQgZ3JvdW5kZWQgPSBmYWxzZTtcbiAgY29uc3Qgc3RvcCA9ICgpID0+IHtcbiAgICBzdG9wcGVkID0gdHJ1ZTtcbiAgICBwcm9jZXNzLmV4aXQoMCk7XG4gIH07XG4gIHByb2Nlc3Mub24oXCJTSUdJTlRcIiwgc3RvcCk7XG4gIHByb2Nlc3Mub24oXCJTSUdURVJNXCIsIHN0b3ApO1xuXG4gIHdoaWxlICghc3RvcHBlZCkge1xuICAgIGNvbnN0IHMgPSByZWFkU2Vzc2lvbihib3VuZElkKTtcbiAgICBpZiAoIXMpIHtcbiAgICAgIGlmIChncm91bmRlZCkgcHJvY2Vzcy5leGl0KDApOyAvLyBvdXIgcGlubmVkIHNlc3Npb24gd2VudCBhd2F5IOKGkiBkb25lXG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcIiMgbm8gc2Vzc2lvbiB5ZXQsIHJldHJ5aW5n4oCmXFxuXCIpO1xuICAgICAgYXdhaXQgc2xlZXAoZGVsYXkpO1xuICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIDUwMDApO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmICghYm91bmRJZCkgYm91bmRJZCA9IHMuc2Vzc2lvbl9pZDsgLy8gcGluIHRvIHRoZSBmaXJzdCBzZXNzaW9uIHdlIHJlc29sdmVkXG4gICAgaWYgKCFncm91bmRlZCkge1xuICAgICAgZ3JvdW5kZWQgPSB0cnVlO1xuICAgICAgLy8gZ3JvdW5kaW5nIGFuY2hvciDigJQgcGFyc2VhYmxlICsgdmlzaWJsZSBpbiBhIE1vbml0b3I7IG5hbWVzIHRoZSBiaW5kaW5nLlxuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgICAgIGAke0pTT04uc3RyaW5naWZ5KHsgdHlwZTogXCJncm91bmRpbmdcIiwgc2Vzc2lvbl9pZDogcy5zZXNzaW9uX2lkLCBwb3J0OiBzLnBvcnQgfSl9XFxuYCxcbiAgICAgICk7XG4gICAgfVxuICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgIHRyeSB7XG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3MucG9ydH0vZXZlbnRzP3NpbmNlPSR7c2luY2V9YCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBhd2FpdCBzbGVlcChkZWxheSk7XG4gICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgNTAwMCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKCFyZXMub2sgfHwgIXJlcy5ib2R5KSB7XG4gICAgICBhd2FpdCBzbGVlcChkZWxheSk7XG4gICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgNTAwMCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgZGVsYXkgPSAyNTA7XG4gICAgY29uc3QgcmVhZGVyID0gcmVzLmJvZHkuZ2V0UmVhZGVyKCk7XG4gICAgY29uc3QgZGVjID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgbGV0IGJ1ZiA9IFwiXCI7XG4gICAgd2hpbGUgKHRydWUpIHtcbiAgICAgIGxldCBjaHVuazogUmVhZGFibGVTdHJlYW1SZWFkUmVzdWx0PFVpbnQ4QXJyYXk+O1xuICAgICAgdHJ5IHtcbiAgICAgICAgY2h1bmsgPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgaWYgKGNodW5rLmRvbmUpIGJyZWFrO1xuICAgICAgYnVmICs9IGRlYy5kZWNvZGUoY2h1bmsudmFsdWUsIHsgc3RyZWFtOiB0cnVlIH0pO1xuICAgICAgZm9yIChsZXQgc2VwID0gYnVmLmluZGV4T2YoXCJcXG5cXG5cIik7IHNlcCA+PSAwOyBzZXAgPSBidWYuaW5kZXhPZihcIlxcblxcblwiKSkge1xuICAgICAgICBjb25zdCBibG9jayA9IGJ1Zi5zbGljZSgwLCBzZXApO1xuICAgICAgICBidWYgPSBidWYuc2xpY2Uoc2VwICsgMik7XG4gICAgICAgIGNvbnN0IGRhdGFMaW5lczogc3RyaW5nW10gPSBbXTtcbiAgICAgICAgZm9yIChjb25zdCBsaW5lIG9mIGJsb2NrLnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgICAgICAgaWYgKGxpbmUuc3RhcnRzV2l0aChcIjpcIikpIHtcbiAgICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFwiOiBtYWdwaWUta2VlcGFsaXZlXFxuXCIpO1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoXCJkYXRhOlwiKSkgZGF0YUxpbmVzLnB1c2gobGluZS5zbGljZSg1KS50cmltKCkpO1xuICAgICAgICB9XG4gICAgICAgIGlmICghZGF0YUxpbmVzLmxlbmd0aCkgY29udGludWU7XG4gICAgICAgIGNvbnN0IHBheWxvYWQgPSBkYXRhTGluZXMuam9pbihcIlxcblwiKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBldiA9IEpTT04ucGFyc2UocGF5bG9hZCkgYXMgeyBpZD86IG51bWJlcjsgdHlwZT86IHN0cmluZyB9O1xuICAgICAgICAgIGlmICh0eXBlb2YgZXYuaWQgPT09IFwibnVtYmVyXCIgJiYgZXYuaWQgPiBzaW5jZSkgc2luY2UgPSBldi5pZDtcbiAgICAgICAgICBpZiAoZXYudHlwZSA9PT0gXCJjbG9zZWRcIikge1xuICAgICAgICAgICAgLy8gUDBmIOKAlCBTSEFQRSBCOiB0aGUgZHJhaW4gY2FsbGJhY2sgcmlkZXMgVEhJUyB3cml0ZSwgc28gaXQgZmlyZXNcbiAgICAgICAgICAgIC8vIG9uIHRoaXMgd3JpdGUncyBjb21wbGV0aW9uLiBOT1QgYSB0cmFpbGluZyBgd3JpdGUoXCJcIiwgY2IpYCDigJQgYVxuICAgICAgICAgICAgLy8gZHJhaW4gY2FsbGJhY2sgY292ZXJzIG9ubHkgaXRzIG93biB3cml0ZSBhbmQgaXMgbm90IGEgYmFycmllclxuICAgICAgICAgICAgLy8gKG1lYXN1cmVkIGJ5dGUtZm9yLWJ5dGUgYXMgYnJva2VuIGFzIG5vIGZpeCksIGFuZCB0aGF0IGlzIGV4YWN0bHlcbiAgICAgICAgICAgIC8vIHRoZSBoZWxwZXIgdGhpcyB3cml0ZS10aGVuLWV4aXQgc2hhcGUgaW52aXRlcy5cbiAgICAgICAgICAgIC8vXG4gICAgICAgICAgICAvLyBQRVItU0lURSBQUkVDT05ESVRJT04sIHJlYWQgYXQgVEhJUyBzaXRlIHJhdGhlciB0aGFuIGNhcnJpZWQgb3ZlclxuICAgICAgICAgICAgLy8gZnJvbSBhIHNpYmxpbmc6IHRoZSBleGl0IHNpdHMgaW5zaWRlIGB3aGlsZSAoIXN0b3BwZWQpYCAtPlxuICAgICAgICAgICAgLy8gYHdoaWxlICh0cnVlKWAgLT4gdGhlIGZyYW1lIGxvb3AsIHNvIGBwcm9jZXNzLmV4aXRDb2RlYCArIGFcbiAgICAgICAgICAgIC8vIG5hdHVyYWwgcmV0dXJuIChzaGFwZSBEKSBkb2VzIE5PVCBsZWF2ZSB0aGUgdGFpbCDigJQgaXQgZmFsbHNcbiAgICAgICAgICAgIC8vIHRocm91Z2ggYW5kIHRoZSBsb29wcyBnbyByb3VuZCBhZ2Fpbi4gVGhlIGV4cGxpY2l0IGByZXR1cm5gIGlzXG4gICAgICAgICAgICAvLyB3aGF0IGV4aXRzIHRoZSBsb29wczsgdGhlIGNhbGxiYWNrIGlzIHdoYXQgZHJhaW5zLiBCb3RoLCBmb3JcbiAgICAgICAgICAgIC8vIGRpZmZlcmVudCByZWFzb25zLlxuICAgICAgICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7cGF5bG9hZH1cXG5gLCAoKSA9PiBwcm9jZXNzLmV4aXQoMCkpO1xuICAgICAgICAgICAgc3RvcHBlZCA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke3BheWxvYWR9XFxuYCk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIC8qIHNraXAgbWFsZm9ybWVkIGZyYW1lICovXG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgYXdhaXQgc2xlZXAoZGVsYXkpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGNtZEluZm8oc2Vzc2lvbj86IHN0cmluZykge1xuICBjb25zdCBzID0gcmVhZFNlc3Npb24oc2Vzc2lvbik7XG4gIGlmICghcykgZGllKFwibm8gcnVubmluZyBtYWdwaWUgc2Vzc2lvblwiLCBcIm5vdF9mb3VuZFwiKTtcbiAgcHJpbnRKc29uKHMpO1xufVxuXG5mdW5jdGlvbiBjbWRTZXNzaW9ucygpIHtcbiAgLy8gTWlycm9yIHBlcnNpc3Quc2VydmVyJ3Mgc25hcHNob3QgZGlyIHJlc29sdXRpb24gKGF2b2lkIGltcG9ydGluZyBub2RlOmZzIHBhdGhcbiAgLy8gbG9naWMgdHdpY2UpOiAkTUFHUElFX0hPTUUvc25hcHNob3RzIG9yIH4vLm1hZ3BpZS9zbmFwc2hvdHMuXG4gIGNvbnN0IGhvbWUgPSBwcm9jZXNzLmVudi5NQUdQSUVfSE9NRSA/PyBqb2luKHByb2Nlc3MuZW52LkhPTUUgPz8gXCJcIiwgXCIubWFncGllXCIpO1xuICBjb25zdCBkaXIgPSBqb2luKGhvbWUsIFwic25hcHNob3RzXCIpO1xuICBsZXQgZmlsZXM6IHN0cmluZ1tdO1xuICB0cnkge1xuICAgIGZpbGVzID0gcmVhZGRpclN5bmMoZGlyKS5maWx0ZXIoKGYpID0+IGYuZW5kc1dpdGgoXCIuanNvblwiKSk7XG4gIH0gY2F0Y2gge1xuICAgIHByaW50SnNvbih7IHNlc3Npb25zOiBbXSB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgdHlwZSBSb3cgPSB7IGlkOiBzdHJpbmc7IHRpdGxlOiBzdHJpbmc7IGVsZW1lbnRzOiBudW1iZXI7IG10aW1lOiBudW1iZXIgfTtcbiAgY29uc3Qgcm93czogUm93W10gPSBbXTtcbiAgZm9yIChjb25zdCBmIG9mIGZpbGVzKSB7XG4gICAgY29uc3QgcGF0aCA9IGpvaW4oZGlyLCBmKTtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc3QgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpO1xuICAgICAgcm93cy5wdXNoKHtcbiAgICAgICAgaWQ6IGYucmVwbGFjZSgvXFwuanNvbiQvLCBcIlwiKSxcbiAgICAgICAgdGl0bGU6IHN0LnRpdGxlLFxuICAgICAgICBlbGVtZW50czogQXJyYXkuaXNBcnJheShzdC5lbGVtZW50cykgPyBzdC5lbGVtZW50cy5sZW5ndGggOiAwLFxuICAgICAgICBtdGltZTogc3RhdFN5bmMocGF0aCkubXRpbWVNcyxcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogc2tpcCB1bnJlYWRhYmxlIHNuYXBzaG90ICovXG4gICAgfVxuICB9XG4gIHJvd3Muc29ydCgoYSwgYikgPT4gYi5tdGltZSAtIGEubXRpbWUpO1xuICAvLyBPTkUgSlNPTiBkb2N1bWVudCwgbGlrZSBldmVyeSBvdGhlciBkYXRhIHZlcmIuIFRoaXMgcHJpbnRlZCBhIHByb3NlIHRhYmxlXG4gIC8vIHVudGlsIHRoZSBtYWNoaW5lLW1vZGUgZGVjbGFyYXRpb24gd2VudCBpbiwgYXQgd2hpY2ggcG9pbnQgdGhlIHRvb2wgd2FzXG4gIC8vIGNsYWltaW5nIGBkZWZhdWx0T3V0cHV0OiBcImpzb25cImAgd2hpbGUgYW5zd2VyaW5nIHRoaXMgdmVyYiBpbiBwcm9zZSDigJQgYVxuICAvLyBkZWNsYXJhdGlvbiBpcyBvbmx5IHdvcnRoIHdoYXQgaXRzIGxlYXN0IGhvbmVzdCBwYXRoIG1ha2VzIGl0LlxuICBwcmludEpzb24oeyBzZXNzaW9uczogcm93cyB9KTtcbn1cblxuLy8gYHNvdXJjZSA8aW1hZ2VQYXRoPmAg4oCUIGNvbXB1dGUgc2hhMjU2WzoxNl0gKyBwaXhlbCBzaXplIChCdW4uSW1hZ2UpIGFuZCBwb3N0XG4vLyBzb3VyY2Uuc2V0LiBUaGUgYWdlbnQgcnVucyBkaXNjb3ZlciBzZXBhcmF0ZWx5OyB0aGlzIGp1c3QgcmVnaXN0ZXJzIHRoZSBib2FyZC5cbmFzeW5jIGZ1bmN0aW9uIGNtZFNvdXJjZShzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsIGltYWdlUGF0aDogc3RyaW5nKSB7XG4gIGNvbnN0IGZpbGUgPSBCdW4uZmlsZShpbWFnZVBhdGgpO1xuICBpZiAoIShhd2FpdCBmaWxlLmV4aXN0cygpKSkgZGllKGBpbWFnZSBub3QgZm91bmQ6ICR7aW1hZ2VQYXRofWAsIFwibm90X2ZvdW5kXCIpO1xuICBjb25zdCBieXRlcyA9IG5ldyBVaW50OEFycmF5KGF3YWl0IGZpbGUuYXJyYXlCdWZmZXIoKSk7XG4gIGNvbnN0IHNoYSA9IG5ldyBCdW4uQ3J5cHRvSGFzaGVyKFwic2hhMjU2XCIpLnVwZGF0ZShieXRlcykuZGlnZXN0KFwiaGV4XCIpLnNsaWNlKDAsIDE2KTtcbiAgY29uc3QgbWV0YSA9IGF3YWl0IG5ldyBCdW4uSW1hZ2UoYnl0ZXMpLm1ldGFkYXRhKCk7XG4gIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgIHR5cGU6IFwic291cmNlLnNldFwiLFxuICAgIHBhdGg6IGltYWdlUGF0aCxcbiAgICBzaXplOiBbbWV0YS53aWR0aCA/PyAwLCBtZXRhLmhlaWdodCA/PyAwXSxcbiAgICBzaGEsXG4gIH0pO1xufVxuXG4vLyBgZWxlbWVudC1hZGQgLS1iYm94IFwieDEseTEseDIseTJcIiBbLS1uYW1lIC4uXSBbLS10eXBlIC4uXWAg4oCUIGFnZW50IGJveGVzIGFcbi8vIHJlZ2lvbiBpbmNyZW1lbnRhbGx5IChzb3VyY2UgcGl4ZWxzKS4gTWlycm9ycyB0aGUgdXNlcidzIFwibWFyayBhIG1pc3NlZCByZWdpb25cIi5cbmFzeW5jIGZ1bmN0aW9uIGNtZEVsZW1lbnRBZGQoc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkLCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgcmF3ID0gdHlwZW9mIGZsYWdzLmJib3ggPT09IFwic3RyaW5nXCIgPyBmbGFncy5iYm94IDogXCJcIjtcbiAgY29uc3QgcGFydHMgPSByYXcuc3BsaXQoXCIsXCIpLm1hcCgobikgPT4gcGFyc2VJbnQobi50cmltKCksIDEwKSk7XG4gIGlmIChwYXJ0cy5sZW5ndGggIT09IDQgfHwgcGFydHMuc29tZSgobikgPT4gTnVtYmVyLmlzTmFOKG4pKSkge1xuICAgIGRpZSgndXNhZ2U6IGVsZW1lbnQtYWRkIC0tYmJveCBcIngxLHkxLHgyLHkyXCIgWy0tbmFtZSA8bmFtZT5dIFstLXR5cGUgPHR5cGU+XScpO1xuICB9XG4gIGNvbnN0IGVsZW1lbnQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyBiYm94OiBwYXJ0cyB9O1xuICBpZiAodHlwZW9mIGZsYWdzLm5hbWUgPT09IFwic3RyaW5nXCIpIGVsZW1lbnQubmFtZSA9IGZsYWdzLm5hbWU7XG4gIGlmICh0eXBlb2YgZmxhZ3MudHlwZSA9PT0gXCJzdHJpbmdcIikgZWxlbWVudC50eXBlID0gZmxhZ3MudHlwZTtcbiAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwiZWxlbWVudC5hZGRcIiwgZWxlbWVudCB9KTtcbn1cblxuLy8gYGRpc2NvdmVyYCDigJQgcmVhZCAvc3RhdGUgZm9yIHNvdXJjZS5wYXRoLCBydW4gZGlzY292ZXIudHMgb24gaXQsIGJ1aWxkIHRoZVxuLy8gRWxlbWVudFtdIChzdGF0dXMgXCJwcm9wb3NlZFwiLCBiYm94IGZyb20gdGhlIG1hbmlmZXN0J3MgYmJveF9waXhlbCksIGFuZCBQT1NUXG4vLyBlbGVtZW50cy5zZXQuIFRoZSB3aG9sZSBkaXNjb3ZlcuKGkmJyZWFrZG93biBsb29wIGluIG9uZSBzaG90IChmb3IgdGhlIGFnZW50IG9yIGFcbi8vIHRlc3RlcikuIFJlcXVpcmVzIE9QRU5ST1VURVJfQVBJX0tFWSBpbiB0aGUgZW52aXJvbm1lbnQuXG5hc3luYyBmdW5jdGlvbiBjbWREaXNjb3ZlcihzZXNzaW9uPzogc3RyaW5nKSB7XG4gIGNvbnN0IHMgPSByZXF1aXJlU2Vzc2lvbihzZXNzaW9uKTtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaShzLnBvcnQsIFwiR0VUXCIsIFwiL3N0YXRlXCIpO1xuICBpZiAoc3RhdHVzICE9PSAyMDApIGRpZShgc3RhdGUgZmFpbGVkIChIVFRQICR7c3RhdHVzfSlgLCBcImludGVybmFsXCIpO1xuICBjb25zdCBzcmMgPSAoZGF0YSBhcyB7IHN0YXRlPzogeyBzb3VyY2U/OiB7IHBhdGg/OiBzdHJpbmcgfSB9IH0pLnN0YXRlPy5zb3VyY2U7XG4gIGNvbnN0IHBhdGggPSBzcmM/LnBhdGg7XG4gIGlmICghcGF0aCkgZGllKFwibm8gc291cmNlIHNldCDigJQgZHJvcCBhIGNvbXBvc2l0ZSAob3IgcnVuOiBzb3VyY2UgPGltYWdlUGF0aD4pIGZpcnN0XCIsIFwiY29uZmxpY3RcIik7XG4gIGxldCBtYW5pZmVzdDogQXdhaXRlZDxSZXR1cm5UeXBlPHR5cGVvZiBkaXNjb3Zlcj4+O1xuICB0cnkge1xuICAgIG1hbmlmZXN0ID0gYXdhaXQgZGlzY292ZXIocGF0aCk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBpZiAoZSBpbnN0YW5jZW9mIERpc2NvdmVyRXJyb3IpIGRpZShgZGlzY292ZXIgZmFpbGVkOiAke2UubWVzc2FnZX1gLCBcImludGVybmFsXCIpO1xuICAgIHRocm93IGU7XG4gIH1cbiAgY29uc3QgZWxlbWVudHM6IEVsZW1lbnRbXSA9IG1hbmlmZXN0LmVsZW1lbnRzLm1hcCgoZSkgPT4gKHtcbiAgICBpZDogbmV3SWQoXCJlXCIpLFxuICAgIG5hbWU6IGUubmFtZSxcbiAgICB0eXBlOiBlLnR5cGUsXG4gICAgYmJveDogZS5iYm94X3BpeGVsLFxuICAgIHN0YXR1czogXCJwcm9wb3NlZFwiLFxuICB9KSk7XG4gIGNvbnN0IGNvc3QgPSBtYW5pZmVzdC5jb3N0X3VzZCA/IGAg4oCUICQke21hbmlmZXN0LmNvc3RfdXNkLnRvRml4ZWQoNCl9YCA6IFwiXCI7XG4gIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBtYWdwaWU6IGRpc2NvdmVyZWQgJHtlbGVtZW50cy5sZW5ndGh9IGVsZW1lbnQocykgb24gJHtwYXRofSR7Y29zdH1cXG5gKTtcbiAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwiZWxlbWVudHMuc2V0XCIsIGVsZW1lbnRzIH0pO1xufVxuXG4vLyBNaXJyb3IgcmVtb3ZlLnB5J3Mgc2FmZV9maWxlbmFtZSBzbyB0aGUgY3V0b3V0IGZpbGVuYW1lIGlzIHN0YWJsZSArIHRyYXZlcnNhbC1cbi8vIHNhZmUgKHRoZSBzdXJmYWNlIHNlcnZlcyBpdCB2aWEgL2Fzc2V0cy88YmFzZW5hbWU+KS5cbmZ1bmN0aW9uIHNhbml0aXplKG5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGNsZWFuZWQgPSBBcnJheS5mcm9tKG5hbWUgfHwgXCJcIilcbiAgICAubWFwKChjKSA9PiAoL1tBLVphLXowLTlcXC1fLl0vLnRlc3QoYykgPyBjIDogXCJfXCIpKVxuICAgIC5qb2luKFwiXCIpXG4gICAgLnJlcGxhY2UoL15cXC4rLywgXCJcIik7IC8vIG5vIGhpZGRlbiBkb3RmaWxlc1xuICByZXR1cm4gY2xlYW5lZCB8fCBcImVsZW1lbnRcIjtcbn1cblxuLy8gVGhlIG9uLWRpc2sgZmlsZW5hbWUgZm9yIGEgdmVyc2lvbjogZWFjaCBNT0RFTCBnZXRzIGl0cyBvd24gZmlsZSBzbyB2ZXJzaW9uc1xuLy8gZG9uJ3Qgb3ZlcndyaXRlIGVhY2ggb3RoZXIgYW5kIGRvbid0IGNvbGxpZGUgaW4gdGhlIGJyb3dzZXIgY2FjaGUgKHR3byB2ZXJzaW9uc1xuLy8gYXQgdGhlIHNhbWUgVVJMIHdvdWxkIHNob3cgYSBzdGFsZSBpbWFnZSkuIFRoZSByYXcgY3JvcCBrZWVwcyB0aGUgYmFyZVxuLy8gYDxuYW1lPi5wbmdgOyBldmVyeSByZW1vdmFsIG1vZGVsIGlzIHN1ZmZpeGVkIGA8bmFtZT4uPG1vZGVsPi5wbmdgLlxuZXhwb3J0IGZ1bmN0aW9uIGN1dG91dEZpbGVuYW1lKG5hbWU6IHN0cmluZywgYmFja2VuZDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke3Nhbml0aXplKG5hbWUpfSR7YmFja2VuZCA9PT0gXCJjcm9wXCIgPyBcIlwiIDogYC4ke2JhY2tlbmR9YH0ucG5nYDtcbn1cblxuLy8gYGV4dHJhY3QgWy0taWRzIGEsYl0gWy0tcmVtb3ZlXSBbLS1hbHBoYSBhdXRvfGFsbHxub25lXSBbLS1wYWQgTl1gIOKAlCBjdXQgYVxuLy8gc2xpY2UgZm9yIGV2ZXJ5IG5vbi1kcm9wcGVkIGVsZW1lbnQgKG9yIGp1c3QgYC0taWRzYCwgb24gcmUtY3V0KS4gREVGQVVMVCBpc1xuLy8gQ1JPUC1PTkxZIChhIHJhdyBQaWxsb3cgc2xpY2UsIG5vIGJhY2tncm91bmQgcmVtb3ZhbCDihpIgYmFja2VuZCBsYWJlbCBcImNyb3BcIikuXG4vLyBgLS1yZW1vdmVgIHN3aXRjaGVzIG9uIHJlbWJnIGJhY2tncm91bmQgcmVtb3ZhbCAoLS1hbHBoYSBhdXRvIOKGkiBiYWNrZW5kXG4vLyBcInJlbWJnXCIpIGZvciB0aGUgbmV4dCBwaGFzZTsgYW4gZXhwbGljaXQgYC0tYWxwaGFgIG92ZXJyaWRlcyB0aGUgcG9saWN5LlxuLy8gUmVhZHMgL3N0YXRlIGZvciBzb3VyY2UucGF0aCArIGVsZW1lbnRzLCBjdXRzIGVhY2ggdmlhIHJlbWJnQmFja2VuZCAo4oaSXG4vLyByZW1vdmUucHkpLCBhbmQgcG9zdHMgdGhlIHJlc3VsdCBiYWNrIHdpdGggZWxlbWVudC5hZGRWZXJzaW9uLiBTZXRzIHRoZSBidXN5XG4vLyBzcGlubmVyIGFyb3VuZCB0aGUgbG9vcDsgcGVyLWVsZW1lbnQgcHJvZ3Jlc3Mg4oaSIHN0ZGVyciwgc3VtbWFyeSDihpIgc3Rkb3V0LlxuYXN5bmMgZnVuY3Rpb24gY21kRXh0cmFjdChzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsIGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPikge1xuICBjb25zdCBzID0gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbik7XG4gIGlmICghcy5maWxlc19kaXIpIGRpZShcInNlc3Npb24gaGFzIG5vIGZpbGVzX2RpciDigJQgY2Fubm90IG1hdGVyaWFsaXplIGN1dG91dHNcIiwgXCJjb25mbGljdFwiKTtcblxuICAvLyBQb2xpY3k6IGNyb3Atb25seSBieSBkZWZhdWx0OyAtLXJlbW92ZSBmbGlwcyB0byByZW1iZyAoYXV0byk7IC0tYWxwaGEgd2lucy5cbiAgbGV0IGFscGhhOiBBbHBoYVBvbGljeSA9IGZsYWdzLnJlbW92ZSA9PT0gdHJ1ZSA/IFwiYXV0b1wiIDogXCJub25lXCI7XG4gIGlmICh0eXBlb2YgZmxhZ3MuYWxwaGEgPT09IFwic3RyaW5nXCIpIHtcbiAgICBpZiAoIVtcImF1dG9cIiwgXCJhbGxcIiwgXCJub25lXCJdLmluY2x1ZGVzKGZsYWdzLmFscGhhKSkge1xuICAgICAgZGllKGAtLWFscGhhIG11c3QgYmUgYXV0b3xhbGx8bm9uZSAoZ290ICR7ZmxhZ3MuYWxwaGF9KWApO1xuICAgIH1cbiAgICBhbHBoYSA9IGZsYWdzLmFscGhhIGFzIEFscGhhUG9saWN5O1xuICB9XG4gIC8vIFRoZSB2ZXJzaW9uIGxhYmVsID0gdGhlIHJlbW92YWwgTU9ERUw6IFwiY3JvcFwiIChubyByZW1vdmFsKSwgXCJyZW1iZ1wiIChyZW1iZydzXG4gIC8vIGRlZmF1bHQgdTJuZXQpLCBvciBhIHNwZWNpZmljIHJlbWJnIG1vZGVsIG5hbWUgb24gYSByZXRyeSAoLS1tb2RlbCwgZS5nLlxuICAvLyBpc25ldC1nZW5lcmFsLXVzZSkuIEVhY2ggbGFiZWwg4oaSIGl0cyBvd24gZmlsZSAoY3V0b3V0RmlsZW5hbWUpIHNvIHZlcnNpb25zXG4gIC8vIGNvZXhpc3QgKyBkb24ndCBjYWNoZS1jb2xsaWRlOyBhZGRWZXJzaW9uIHVwc2VydHMgYnkgdGhpcyBsYWJlbC5cbiAgY29uc3QgcmVxTW9kZWwgPSB0eXBlb2YgZmxhZ3MubW9kZWwgPT09IFwic3RyaW5nXCIgPyBmbGFncy5tb2RlbCA6IHVuZGVmaW5lZDtcbiAgLy8gUm91dGUgYnkgaWQgU0hBUEUsIG5ldmVyIGEgaGFyZGNvZGVkIG1vZGVsIGxpc3Q6IGEgbWVkaWEtZm9yZ2UgaWQgaXMgYVxuICAvLyBwcm92aWRlciBwYXRoIChoYXMgXCIvXCIpOyBhIGJhcmUgbmFtZSBpcyBhIHJlbWJnIG1vZGVsLiBUaGUgYWdlbnQgZGlzY292ZXJzXG4gIC8vIG1lZGlhLWZvcmdlIGJnLXJlbW92ZSBpZHMgdmlhIGBtZWRpYS1mb3JnZSBtb2RlbHMgbGlzdGAgYW5kIHBhc3NlcyBvbmUgaGVyZS5cbiAgY29uc3QgdXNlTWVkaWFGb3JnZSA9IHJlcU1vZGVsID8gaXNNZWRpYUZvcmdlTW9kZWwocmVxTW9kZWwpIDogZmFsc2U7XG4gIGNvbnN0IHJlbWJnTW9kZWwgPSByZXFNb2RlbCAmJiAhdXNlTWVkaWFGb3JnZSA/IHJlcU1vZGVsIDogdW5kZWZpbmVkO1xuICAvLyBUaGUgdmVyc2lvbiBsYWJlbCAoaXRzIHN0cmlwIHJvdyArIGZpbGVuYW1lKS4gRnJpZW5kbHk6IGV4cGxpY2l0IC0tbGFiZWwgd2lucztcbiAgLy8gZWxzZSBmb3IgYSBtZWRpYS1mb3JnZSBwYXRoIGlkIHVzZSB0aGUgc2VnbWVudCBhZnRlciB0aGUgdmVuZG9yOyBlbHNlIHRoZVxuICAvLyBtb2RlbCBuYW1lLiBjcm9wLW9ubHkgaGFzIG5vIG1vZGVsLlxuICBjb25zdCBleHBsaWNpdExhYmVsID0gdHlwZW9mIGZsYWdzLmxhYmVsID09PSBcInN0cmluZ1wiID8gZmxhZ3MubGFiZWwgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IGxhYmVsID1cbiAgICBhbHBoYSA9PT0gXCJub25lXCJcbiAgICAgID8gXCJjcm9wXCJcbiAgICAgIDogKGV4cGxpY2l0TGFiZWwgPz9cbiAgICAgICAgKHVzZU1lZGlhRm9yZ2UgPyAoKHJlcU1vZGVsIGFzIHN0cmluZykuc3BsaXQoXCIvXCIpWzFdID8/IFwiY2xvdWRcIikgOiAocmVxTW9kZWwgPz8gXCJyZW1iZ1wiKSkpO1xuICAvLyBEZWZhdWx0IHBhZCA9IDA6IHRoZSBzbGljZSBtdXN0IG1hdGNoIHRoZSBib3ggdGhlIHVzZXIgZHJldyAoV1lTSVdZRykuIFRoZSBib3hcbiAgLy8gSVMgdGhlIHBhZGRpbmcgY29udHJvbCDigJQgZHJhZyBhIGhhbmRsZSBvdXQgZm9yIGJyZWF0aGluZyByb29tLiAocmVtb3ZlLnB5J3Mgb3duXG4gIC8vIGRlZmF1bHQgaXMgOCwgc28gd2UgTVVTVCBwYXNzIGFuIGV4cGxpY2l0IDAsIG5vdCB1bmRlZmluZWQuKSAtLXBhZCBvdmVycmlkZXMuXG4gIGNvbnN0IHBhZCA9IHR5cGVvZiBmbGFncy5wYWQgPT09IFwic3RyaW5nXCIgPyBwYXJzZUludChmbGFncy5wYWQsIDEwKSA6IDA7XG4gIGlmIChOdW1iZXIuaXNOYU4ocGFkKSkgZGllKFwiLS1wYWQgbXVzdCBiZSBhIG51bWJlclwiKTtcbiAgY29uc3QgaWRGaWx0ZXIgPVxuICAgIHR5cGVvZiBmbGFncy5pZHMgPT09IFwic3RyaW5nXCJcbiAgICAgID8gbmV3IFNldChcbiAgICAgICAgICBmbGFncy5pZHNcbiAgICAgICAgICAgIC5zcGxpdChcIixcIilcbiAgICAgICAgICAgIC5tYXAoKHgpID0+IHgudHJpbSgpKVxuICAgICAgICAgICAgLmZpbHRlcihCb29sZWFuKSxcbiAgICAgICAgKVxuICAgICAgOiB1bmRlZmluZWQ7XG5cbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaShzLnBvcnQsIFwiR0VUXCIsIFwiL3N0YXRlXCIpO1xuICBpZiAoc3RhdHVzICE9PSAyMDApIGRpZShgc3RhdGUgZmFpbGVkIChIVFRQICR7c3RhdHVzfSlgLCBcImludGVybmFsXCIpO1xuICBjb25zdCBzdCA9IChkYXRhIGFzIHsgc3RhdGU/OiB7IHNvdXJjZT86IHsgcGF0aD86IHN0cmluZyB9OyBlbGVtZW50cz86IEVsZW1lbnRbXSB9IH0pLnN0YXRlO1xuICBjb25zdCBzb3VyY2VQYXRoID0gc3Q/LnNvdXJjZT8ucGF0aDtcbiAgaWYgKCFzb3VyY2VQYXRoKVxuICAgIGRpZShcIm5vIHNvdXJjZSBzZXQg4oCUIGRyb3AgYSBjb21wb3NpdGUgKG9yIHJ1bjogc291cmNlIDxpbWFnZVBhdGg+KSBmaXJzdFwiLCBcImNvbmZsaWN0XCIpO1xuICBsZXQgZWxlbWVudHMgPSAoc3Q/LmVsZW1lbnRzID8/IFtdKS5maWx0ZXIoKGUpID0+IGUuc3RhdHVzICE9PSBcImRyb3BwZWRcIik7XG4gIGlmIChpZEZpbHRlcikgZWxlbWVudHMgPSBlbGVtZW50cy5maWx0ZXIoKGUpID0+IGlkRmlsdGVyLmhhcyhlLmlkKSk7XG4gIC8vIFdoZW4gUkVNT1ZJTkcsIG5ldmVyIHRvdWNoIGFscGhhLWZvcmJpZGRlbiB0eXBlcyAocGFsZXR0ZSAvIHNjcmVlbnNob3QgL1xuICAvLyB0eXBvZ3JhcGh5KSDigJQgdGhleSBzdGF5IHdob2xlIGJ5IHBvbGljeS4gU2tpcCB0aGVtIHNvIHdlIGRvbid0IHdyaXRlIGFcbiAgLy8gbWlzbGFiZWxlZCwgcmVkdW5kYW50IFwicmVtb3ZhbFwiIHZlcnNpb24gdGhhdCdzIHJlYWxseSBqdXN0IHRoZSBjcm9wLlxuICBsZXQga2VwdFdob2xlID0gMDtcbiAgaWYgKGFscGhhICE9PSBcIm5vbmVcIikge1xuICAgIGNvbnN0IGJlZm9yZSA9IGVsZW1lbnRzLmxlbmd0aDtcbiAgICBlbGVtZW50cyA9IGVsZW1lbnRzLmZpbHRlcigoZSkgPT4gc2hvdWxkUmVtb3ZlKGUudHlwZSwgYWxwaGEpKTtcbiAgICBrZXB0V2hvbGUgPSBiZWZvcmUgLSBlbGVtZW50cy5sZW5ndGg7XG4gIH1cbiAgaWYgKCFlbGVtZW50cy5sZW5ndGgpIHtcbiAgICBkaWUoXG4gICAgICBrZXB0V2hvbGUgPiAwXG4gICAgICAgID8gYG5vdGhpbmcgdG8gcmVtb3ZlIOKAlCAke2tlcHRXaG9sZX0gc2VsZWN0ZWQgZWxlbWVudCR7a2VwdFdob2xlID09PSAxID8gXCIgaXMgYVwiIDogXCJzIGFyZVwifSBrZXB0LXdob2xlIHR5cGUke2tlcHRXaG9sZSA9PT0gMSA/IFwiXCIgOiBcInNcIn0gKHBhbGV0dGUvc2NyZWVuc2hvdC90eXBvZ3JhcGh5KWBcbiAgICAgICAgOiBpZEZpbHRlclxuICAgICAgICAgID8gXCJubyBtYXRjaGluZyBleHRyYWN0YWJsZSBlbGVtZW50cyBmb3IgLS1pZHNcIlxuICAgICAgICAgIDogXCJubyBleHRyYWN0YWJsZSBlbGVtZW50cyAoYWxsIGRyb3BwZWQgb3Igbm9uZSBkaXNjb3ZlcmVkKVwiLFxuICAgICk7XG4gIH1cblxuICBhd2FpdCBhcGkocy5wb3J0LCBcIlBPU1RcIiwgXCIvY21kXCIsIHsgdHlwZTogXCJzdGF0dXNcIiwgYnVzeTogdHJ1ZSwgdGV4dDogXCJleHRyYWN0aW5n4oCmXCIgfSk7XG4gIGxldCBkb25lID0gMDtcbiAgbGV0IGZhaWxlZCA9IDA7XG4gIHRyeSB7XG4gICAgZm9yIChjb25zdCBlbCBvZiBlbGVtZW50cykge1xuICAgICAgY29uc3Qgb3V0UGF0aCA9IGpvaW4ocy5maWxlc19kaXIsIGN1dG91dEZpbGVuYW1lKGVsLm5hbWUsIGxhYmVsKSk7XG4gICAgICB0cnkge1xuICAgICAgICAvLyBDbG91ZCAobWVkaWEtZm9yZ2UpIHJ1bnMgb24gdGhlIGVsZW1lbnQncyBleGlzdGluZyBjcm9wIGltYWdlIChzaW5nbGUtXG4gICAgICAgIC8vIGltYWdlIHRyYW5zZm9ybSk7IHJlbWJnIGNyb3BzIHRoZSBiYm94IGZyb20gdGhlIHNvdXJjZSBpdHNlbGYuXG4gICAgICAgIGNvbnN0IGN1dG91dCA9IHVzZU1lZGlhRm9yZ2VcbiAgICAgICAgICA/IGF3YWl0IG1lZGlhRm9yZ2VCYWNrZW5kLmN1dChcbiAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIHNvdXJjZVBhdGg6IGpvaW4ocy5maWxlc19kaXIsIGN1dG91dEZpbGVuYW1lKGVsLm5hbWUsIFwiY3JvcFwiKSksXG4gICAgICAgICAgICAgICAgYmJveDogZWwuYmJveCxcbiAgICAgICAgICAgICAgICB0eXBlOiBlbC50eXBlLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICBvdXRQYXRoLFxuICAgICAgICAgICAgICB7IG1vZGVsOiByZXFNb2RlbCB9LFxuICAgICAgICAgICAgKVxuICAgICAgICAgIDogYXdhaXQgcmVtYmdCYWNrZW5kLmN1dCh7IHNvdXJjZVBhdGgsIGJib3g6IGVsLmJib3gsIHR5cGU6IGVsLnR5cGUgfSwgb3V0UGF0aCwge1xuICAgICAgICAgICAgICBhbHBoYSxcbiAgICAgICAgICAgICAgcGFkLFxuICAgICAgICAgICAgICBtb2RlbDogcmVtYmdNb2RlbCxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICBhd2FpdCBhcGkocy5wb3J0LCBcIlBPU1RcIiwgXCIvY21kXCIsIHtcbiAgICAgICAgICB0eXBlOiBcImVsZW1lbnQuYWRkVmVyc2lvblwiLFxuICAgICAgICAgIGlkOiBlbC5pZCxcbiAgICAgICAgICAvLyBhZGRWZXJzaW9uIHVwc2VydHMgYnkgbW9kZWwgKGJ1bXBzIHJldiDihpIgY2FjaGUtYnVzdCkgYW5kIGNsZWFycyB0aGVcbiAgICAgICAgICAvLyBmbGFnOyBjcm9wID0gcmF3LCByZW1iZyBtb2RlbCA9IGxvY2FsLCBtZWRpYS1mb3JnZSA9IGNsb3VkLlxuICAgICAgICAgIHZlcnNpb246IHtcbiAgICAgICAgICAgIGlkOiBuZXdJZChcInZcIiksXG4gICAgICAgICAgICBtb2RlbDogbGFiZWwsIC8vIFwiY3JvcFwiIHwgXCJyZW1iZ1wiIHwgPHJlbWJnIG1vZGVsPiB8IDxtZWRpYS1mb3JnZSBsYWJlbD5cbiAgICAgICAgICAgIGtpbmQ6IGxhYmVsID09PSBcImNyb3BcIiA/IFwicmF3XCIgOiB1c2VNZWRpYUZvcmdlID8gXCJjbG91ZFwiIDogXCJsb2NhbFwiLFxuICAgICAgICAgICAgcGF0aDogY3V0b3V0LnBhdGgsXG4gICAgICAgICAgICByZXY6IDAsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBjaG9vc2U6IHRydWUsXG4gICAgICAgIH0pO1xuICAgICAgICBkb25lKys7XG4gICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBtYWdwaWU6IGN1dCAke2VsLm5hbWV9ICgke2VsLnR5cGV9LCAke2xhYmVsfSkg4oaSICR7Y3V0b3V0LnBhdGh9XFxuYCk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGZhaWxlZCsrO1xuICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICBgbWFncGllOiBjdXQgRkFJTEVEIGZvciAke2VsLm5hbWV9OiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1cXG5gLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cbiAgfSBmaW5hbGx5IHtcbiAgICBhd2FpdCBhcGkocy5wb3J0LCBcIlBPU1RcIiwgXCIvY21kXCIsIHsgdHlwZTogXCJzdGF0dXNcIiwgYnVzeTogZmFsc2UgfSk7XG4gIH1cbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGN1dDogZG9uZSwgZmFpbGVkLCB0b3RhbDogZWxlbWVudHMubGVuZ3RoLCBrZXB0V2hvbGUsIG1vZGVsOiBsYWJlbCB9KTtcbn1cblxuZnVuY3Rpb24gZXNjYXBlSHRtbChzOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gcy5yZXBsYWNlKFxuICAgIC9bJjw+XCJdL2csXG4gICAgKGMpID0+ICh7IFwiJlwiOiBcIiZhbXA7XCIsIFwiPFwiOiBcIiZsdDtcIiwgXCI+XCI6IFwiJmd0O1wiLCAnXCInOiBcIiZxdW90O1wiIH0pW2NdIGFzIHN0cmluZyxcbiAgKTtcbn1cblxudHlwZSBNYW5pZmVzdEFzc2V0ID0ge1xuICBuYW1lOiBzdHJpbmc7XG4gIHR5cGU6IHN0cmluZztcbiAgbW9kZWw6IHN0cmluZztcbiAga2luZDogc3RyaW5nIHwgbnVsbDtcbiAgYmJveDogbnVtYmVyW107XG4gIGZpbGU6IHN0cmluZztcbiAgY3JvcDogc3RyaW5nIHwgbnVsbDtcbn07XG5cbi8vIEEgc2VsZi1jb250YWluZWQgY29udGFjdCBzaGVldCAobWFncGllIGNyZWFtIGlkZW50aXR5KSDigJQgb3BlbiBpbiBhIGJyb3dzZXIsIG5vXG4vLyBkZXBzLiBCYWNrZHJvcCB0b2dnbGUgKGNoZWNrZXIvd2hpdGUvZ3JheS9ibGFjaykgdG8ganVkZ2UgdHJhbnNwYXJlbmN5LCBhbmRcbi8vIHR5cGUgZmlsdGVycyBidWlsdCBmcm9tIHRoZSB0YXhvbm9teSB3ZSB0YWdnZWQgZHVyaW5nIHRoZSBydW4uIGBhLmZpbGVgIGlzIHRoZVxuLy8gaW4temlwIHBhdGggKGFzc2V0cy88bmFtZT4ucG5nKS5cbmZ1bmN0aW9uIGJ1aWxkR2FsbGVyeUh0bWwodGl0bGU6IHN0cmluZywgYXNzZXRzOiBNYW5pZmVzdEFzc2V0W10pOiBzdHJpbmcge1xuICBjb25zdCB0eXBlcyA9IFsuLi5uZXcgU2V0KGFzc2V0cy5tYXAoKGEpID0+IGEudHlwZSkpXS5zb3J0KCk7XG4gIGNvbnN0IHR5cGVDaGlwcyA9IFtcImFsbFwiLCAuLi50eXBlc11cbiAgICAubWFwKCh0KSA9PiB7XG4gICAgICBjb25zdCBuID0gdCA9PT0gXCJhbGxcIiA/IGFzc2V0cy5sZW5ndGggOiBhc3NldHMuZmlsdGVyKChhKSA9PiBhLnR5cGUgPT09IHQpLmxlbmd0aDtcbiAgICAgIHJldHVybiBgPGJ1dHRvbiBjbGFzcz1cImNoaXAke3QgPT09IFwiYWxsXCIgPyBcIiBhY3RpdmVcIiA6IFwiXCJ9XCIgZGF0YS1maWx0ZXI9XCIke2VzY2FwZUh0bWwodCl9XCI+JHtlc2NhcGVIdG1sKHQpfSA8c3BhbiBjbGFzcz1cIm5cIj4ke259PC9zcGFuPjwvYnV0dG9uPmA7XG4gICAgfSlcbiAgICAuam9pbihcIlwiKTtcbiAgY29uc3QgY2FyZHMgPSBhc3NldHNcbiAgICAubWFwKFxuICAgICAgKGEpID0+IGAgICAgICA8ZmlndXJlIGNsYXNzPVwiY2FyZFwiIGRhdGEtdHlwZT1cIiR7ZXNjYXBlSHRtbChhLnR5cGUpfVwiPlxuICAgICAgICA8ZGl2IGNsYXNzPVwidGh1bWJcIj48aW1nIHNyYz1cIiR7ZXNjYXBlSHRtbChhLmZpbGUpfVwiIGFsdD1cIiR7ZXNjYXBlSHRtbChhLm5hbWUpfVwiPjwvZGl2PlxuICAgICAgICA8ZmlnY2FwdGlvbj5cbiAgICAgICAgICA8c3BhbiBjbGFzcz1cIm5hbWVcIj4ke2VzY2FwZUh0bWwoYS5uYW1lKX08L3NwYW4+XG4gICAgICAgICAgPHNwYW4gY2xhc3M9XCJtZXRhXCI+JHtlc2NhcGVIdG1sKGEudHlwZSl9IMK3ICR7ZXNjYXBlSHRtbChhLm1vZGVsKX0ke2Eua2luZCA/IGAgKCR7ZXNjYXBlSHRtbChhLmtpbmQpfSlgIDogXCJcIn08L3NwYW4+XG4gICAgICAgIDwvZmlnY2FwdGlvbj5cbiAgICAgIDwvZmlndXJlPmAsXG4gICAgKVxuICAgIC5qb2luKFwiXFxuXCIpO1xuICByZXR1cm4gYDwhZG9jdHlwZSBodG1sPlxuPGh0bWwgbGFuZz1cImVuXCI+PGhlYWQ+PG1ldGEgY2hhcnNldD1cInV0Zi04XCI+XG48dGl0bGU+JHtlc2NhcGVIdG1sKHRpdGxlKX0g4oCUIG1hZ3BpZSBhc3NldHM8L3RpdGxlPlxuPHN0eWxlPlxuICA6cm9vdCB7IC0tY3JlYW06I2Y2ZjFlNzsgLS1pbms6IzE0MTgxYjsgLS1saW5lOiNlMmQ5YzY7IC0taW5kaWdvOiM1YjViZjA7IH1cbiAgYm9keSB7IGZvbnQtZmFtaWx5Oi1hcHBsZS1zeXN0ZW0sc3lzdGVtLXVpLHNhbnMtc2VyaWY7IGJhY2tncm91bmQ6dmFyKC0tY3JlYW0pOyBjb2xvcjp2YXIoLS1pbmspOyBtYXJnaW46MDsgcGFkZGluZzoyOHB4OyB9XG4gIGgxIHsgZm9udC1zaXplOjIwcHg7IGZvbnQtd2VpZ2h0OjcwMDsgbWFyZ2luOjA7IH0gLmNvdW50IHsgY29sb3I6IzlhOGY3ODsgZm9udC13ZWlnaHQ6NDAwOyB9XG4gIC50b29sYmFyIHsgZGlzcGxheTpmbGV4OyBnYXA6MThweDsgYWxpZ24taXRlbXM6Y2VudGVyOyBmbGV4LXdyYXA6d3JhcDsgbWFyZ2luOjE2cHggMCA0cHg7IH1cbiAgLmdyb3VwIHsgZGlzcGxheTpmbGV4OyBnYXA6NnB4OyBhbGlnbi1pdGVtczpjZW50ZXI7IH1cbiAgLmxhYmVsIHsgZm9udC1zaXplOjExcHg7IGNvbG9yOiM5YThmNzg7IHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsgbGV0dGVyLXNwYWNpbmc6LjA0ZW07IH1cbiAgLyogYmFja2Ryb3AgPSBjb2xvciBzd2F0Y2hlcyAobm90IHdvcmRzKTsgdHJhbnNwYXJlbnQgPSBhIG1pbmkgY2hlY2tlciBzcXVhcmUgKi9cbiAgLnN3IHsgd2lkdGg6MjJweDsgaGVpZ2h0OjIycHg7IHBhZGRpbmc6MDsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTsgYm9yZGVyLXJhZGl1czo1cHg7IGN1cnNvcjpwb2ludGVyOyBib3gtc2l6aW5nOmJvcmRlci1ib3g7IH1cbiAgLnN3LmFjdGl2ZSB7IG91dGxpbmU6MnB4IHNvbGlkIHZhcigtLWluZGlnbyk7IG91dGxpbmUtb2Zmc2V0OjFweDsgfVxuICAuc3cuY2hlY2tlciB7IGJhY2tncm91bmQtY29sb3I6I2ZmZjtcbiAgICBiYWNrZ3JvdW5kLWltYWdlOmxpbmVhci1ncmFkaWVudCg0NWRlZywjYzljOWM5IDI1JSx0cmFuc3BhcmVudCAyNSUpLGxpbmVhci1ncmFkaWVudCgtNDVkZWcsI2M5YzljOSAyNSUsdHJhbnNwYXJlbnQgMjUlKSxsaW5lYXItZ3JhZGllbnQoNDVkZWcsdHJhbnNwYXJlbnQgNzUlLCNjOWM5YzkgNzUlKSxsaW5lYXItZ3JhZGllbnQoLTQ1ZGVnLHRyYW5zcGFyZW50IDc1JSwjYzljOWM5IDc1JSk7XG4gICAgYmFja2dyb3VuZC1zaXplOjhweCA4cHg7IGJhY2tncm91bmQtcG9zaXRpb246MCAwLDAgNHB4LDRweCAtNHB4LC00cHggMDsgfVxuICAvKiBzaXplID0gYSBzbWFsbCBTL00vTCBzZWdtZW50ZWQgY29udHJvbCAqL1xuICAuc2VnIHsgZm9udDppbmhlcml0OyBmb250LXNpemU6MTJweDsgcGFkZGluZzo0cHggOXB4OyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpOyBiYWNrZ3JvdW5kOiNmZmZkZjg7IGNvbG9yOnZhcigtLWluayk7IGN1cnNvcjpwb2ludGVyOyB9XG4gIC5zZWc6Zmlyc3QtY2hpbGQgeyBib3JkZXItcmFkaXVzOjZweCAwIDAgNnB4OyB9IC5zZWc6bGFzdC1jaGlsZCB7IGJvcmRlci1yYWRpdXM6MCA2cHggNnB4IDA7IH0gLnNlZysuc2VnIHsgYm9yZGVyLWxlZnQ6bm9uZTsgfVxuICAuc2VnLmFjdGl2ZSB7IGJhY2tncm91bmQ6dmFyKC0taW5kaWdvKTsgY29sb3I6I2ZmZjsgYm9yZGVyLWNvbG9yOnZhcigtLWluZGlnbyk7IH1cbiAgLmNoaXAgeyBmb250OmluaGVyaXQ7IGZvbnQtc2l6ZToxMnB4OyBwYWRkaW5nOjRweCAxMHB4OyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpOyBib3JkZXItcmFkaXVzOjk5OXB4OyBiYWNrZ3JvdW5kOiNmZmZkZjg7IGNvbG9yOnZhcigtLWluayk7IGN1cnNvcjpwb2ludGVyOyB9XG4gIC5jaGlwLmFjdGl2ZSB7IGJhY2tncm91bmQ6dmFyKC0taW5kaWdvKTsgY29sb3I6I2ZmZjsgYm9yZGVyLWNvbG9yOnZhcigtLWluZGlnbyk7IH1cbiAgLmNoaXAgLm4geyBvcGFjaXR5Oi42OyBtYXJnaW4tbGVmdDoycHg7IH1cbiAgLmdyaWQgeyBkaXNwbGF5OmdyaWQ7IGdyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoYXV0by1maWxsLG1pbm1heCgxNzBweCwxZnIpKTsgZ2FwOjEwcHg7IG1hcmdpbi10b3A6MTZweDsgfVxuICBib2R5W2RhdGEtc2l6ZT1cInNtXCJdIC5ncmlkIHsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdChhdXRvLWZpbGwsbWlubWF4KDEzMnB4LDFmcikpOyB9XG4gIGJvZHlbZGF0YS1zaXplPVwibGdcIl0gLmdyaWQgeyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KGF1dG8tZmlsbCxtaW5tYXgoMjY0cHgsMWZyKSk7IGdhcDoxNHB4OyB9XG4gIC5jYXJkIHsgYmFja2dyb3VuZDojZmZmZGY4OyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpOyBib3JkZXItcmFkaXVzOjEwcHg7IG92ZXJmbG93OmhpZGRlbjsgbWluLXdpZHRoOjA7IH1cbiAgLnRodW1iIHsgaGVpZ2h0OjE2MHB4OyBkaXNwbGF5OmZsZXg7IGFsaWduLWl0ZW1zOmNlbnRlcjsganVzdGlmeS1jb250ZW50OmNlbnRlcjsgYmFja2dyb3VuZC1jb2xvcjojZmZmO1xuICAgIGJhY2tncm91bmQtaW1hZ2U6bGluZWFyLWdyYWRpZW50KDQ1ZGVnLCNlN2UwZDIgMjUlLHRyYW5zcGFyZW50IDI1JSksbGluZWFyLWdyYWRpZW50KC00NWRlZywjZTdlMGQyIDI1JSx0cmFuc3BhcmVudCAyNSUpLGxpbmVhci1ncmFkaWVudCg0NWRlZyx0cmFuc3BhcmVudCA3NSUsI2U3ZTBkMiA3NSUpLGxpbmVhci1ncmFkaWVudCgtNDVkZWcsdHJhbnNwYXJlbnQgNzUlLCNlN2UwZDIgNzUlKTtcbiAgICBiYWNrZ3JvdW5kLXNpemU6MTZweCAxNnB4OyBiYWNrZ3JvdW5kLXBvc2l0aW9uOjAgMCwwIDhweCw4cHggLThweCwtOHB4IDA7IH1cbiAgYm9keVtkYXRhLXNpemU9XCJzbVwiXSAudGh1bWIgeyBoZWlnaHQ6MTEycHg7IH0gYm9keVtkYXRhLXNpemU9XCJsZ1wiXSAudGh1bWIgeyBoZWlnaHQ6MjQwcHg7IH1cbiAgYm9keVtkYXRhLWJnPVwid2hpdGVcIl0gLnRodW1iIHsgYmFja2dyb3VuZDojZmZmIWltcG9ydGFudDsgYmFja2dyb3VuZC1pbWFnZTpub25lIWltcG9ydGFudDsgfVxuICBib2R5W2RhdGEtYmc9XCJncmF5XCJdIC50aHVtYiB7IGJhY2tncm91bmQ6IzhhOGE4YSFpbXBvcnRhbnQ7IGJhY2tncm91bmQtaW1hZ2U6bm9uZSFpbXBvcnRhbnQ7IH1cbiAgYm9keVtkYXRhLWJnPVwiYmxhY2tcIl0gLnRodW1iIHsgYmFja2dyb3VuZDojMTExIWltcG9ydGFudDsgYmFja2dyb3VuZC1pbWFnZTpub25lIWltcG9ydGFudDsgfVxuICAudGh1bWIgaW1nIHsgbWF4LXdpZHRoOjg4JTsgbWF4LWhlaWdodDo4OCU7IG9iamVjdC1maXQ6Y29udGFpbjsgfVxuICBmaWdjYXB0aW9uIHsgcGFkZGluZzo3cHggOXB4OyBkaXNwbGF5OmZsZXg7IGZsZXgtZGlyZWN0aW9uOmNvbHVtbjsgZ2FwOjFweDsgbWluLXdpZHRoOjA7IH1cbiAgLm5hbWUsIC5tZXRhIHsgd2hpdGUtc3BhY2U6bm93cmFwOyBvdmVyZmxvdzpoaWRkZW47IHRleHQtb3ZlcmZsb3c6ZWxsaXBzaXM7IH1cbiAgLm5hbWUgeyBmb250LXNpemU6MTIuNXB4OyBmb250LXdlaWdodDo2MDA7IH0gLm1ldGEgeyBmb250LXNpemU6MTFweDsgY29sb3I6IzZmNmM2NjsgfVxuPC9zdHlsZT48L2hlYWQ+PGJvZHkgZGF0YS1iZz1cImNoZWNrZXJcIiBkYXRhLXNpemU9XCJtZFwiPlxuICA8aDE+8J+QpiAke2VzY2FwZUh0bWwodGl0bGUpfSA8c3BhbiBjbGFzcz1cImNvdW50XCI+4oCUICR7YXNzZXRzLmxlbmd0aH0gYXNzZXQke2Fzc2V0cy5sZW5ndGggPT09IDEgPyBcIlwiIDogXCJzXCJ9PC9zcGFuPjwvaDE+XG4gIDxkaXYgY2xhc3M9XCJ0b29sYmFyXCI+XG4gICAgPGRpdiBjbGFzcz1cImdyb3VwXCI+PHNwYW4gY2xhc3M9XCJsYWJlbFwiPkJhY2tkcm9wPC9zcGFuPlxuICAgICAgPGJ1dHRvbiBjbGFzcz1cInN3IGNoZWNrZXIgYWN0aXZlXCIgZGF0YS1iZy1idG49XCJjaGVja2VyXCIgdGl0bGU9XCJUcmFuc3BhcmVudFwiPjwvYnV0dG9uPlxuICAgICAgPGJ1dHRvbiBjbGFzcz1cInN3XCIgZGF0YS1iZy1idG49XCJ3aGl0ZVwiIHN0eWxlPVwiYmFja2dyb3VuZDojZmZmZmZmXCIgdGl0bGU9XCJXaGl0ZVwiPjwvYnV0dG9uPlxuICAgICAgPGJ1dHRvbiBjbGFzcz1cInN3XCIgZGF0YS1iZy1idG49XCJncmF5XCIgc3R5bGU9XCJiYWNrZ3JvdW5kOiM4YThhOGFcIiB0aXRsZT1cIkdyYXlcIj48L2J1dHRvbj5cbiAgICAgIDxidXR0b24gY2xhc3M9XCJzd1wiIGRhdGEtYmctYnRuPVwiYmxhY2tcIiBzdHlsZT1cImJhY2tncm91bmQ6IzExMTExMVwiIHRpdGxlPVwiQmxhY2tcIj48L2J1dHRvbj5cbiAgICA8L2Rpdj5cbiAgICA8ZGl2IGNsYXNzPVwiZ3JvdXBcIj48c3BhbiBjbGFzcz1cImxhYmVsXCI+U2l6ZTwvc3Bhbj5cbiAgICAgIDxidXR0b24gY2xhc3M9XCJzZWdcIiBkYXRhLXNpemUtYnRuPVwic21cIiB0aXRsZT1cIlNtYWxsXCI+UzwvYnV0dG9uPlxuICAgICAgPGJ1dHRvbiBjbGFzcz1cInNlZyBhY3RpdmVcIiBkYXRhLXNpemUtYnRuPVwibWRcIiB0aXRsZT1cIk1lZGl1bVwiPk08L2J1dHRvbj5cbiAgICAgIDxidXR0b24gY2xhc3M9XCJzZWdcIiBkYXRhLXNpemUtYnRuPVwibGdcIiB0aXRsZT1cIkxhcmdlXCI+TDwvYnV0dG9uPlxuICAgIDwvZGl2PlxuICAgIDxkaXYgY2xhc3M9XCJncm91cFwiPjxzcGFuIGNsYXNzPVwibGFiZWxcIj5UeXBlPC9zcGFuPiR7dHlwZUNoaXBzfTwvZGl2PlxuICA8L2Rpdj5cbiAgPGRpdiBjbGFzcz1cImdyaWRcIj5cbiR7Y2FyZHN9XG4gIDwvZGl2PlxuICA8c2NyaXB0PlxuICAgIHZhciBib2R5PWRvY3VtZW50LmJvZHk7XG4gICAgZnVuY3Rpb24gd2lyZShzZWwsIGFwcGx5KXsgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbChzZWwpLmZvckVhY2goZnVuY3Rpb24oYil7IGIuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBmdW5jdGlvbigpe1xuICAgICAgYXBwbHkoYik7XG4gICAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKHNlbCkuZm9yRWFjaChmdW5jdGlvbih4KXsgeC5jbGFzc0xpc3QudG9nZ2xlKCdhY3RpdmUnLCB4PT09Yik7IH0pO1xuICAgIH0pOyB9KTsgfVxuICAgIHdpcmUoJ1tkYXRhLWJnLWJ0bl0nLCBmdW5jdGlvbihiKXsgYm9keS5kYXRhc2V0LmJnPWIuZGF0YXNldC5iZ0J0bjsgfSk7XG4gICAgd2lyZSgnW2RhdGEtc2l6ZS1idG5dJywgZnVuY3Rpb24oYil7IGJvZHkuZGF0YXNldC5zaXplPWIuZGF0YXNldC5zaXplQnRuOyB9KTtcbiAgICB2YXIgY2FyZHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY2FyZCcpKTtcbiAgICB3aXJlKCdbZGF0YS1maWx0ZXJdJywgZnVuY3Rpb24oYil7IHZhciB0PWIuZGF0YXNldC5maWx0ZXI7XG4gICAgICBjYXJkcy5mb3JFYWNoKGZ1bmN0aW9uKGMpeyBjLnN0eWxlLmRpc3BsYXk9KHQ9PT0nYWxsJ3x8Yy5kYXRhc2V0LnR5cGU9PT10KT8nJzonbm9uZSc7IH0pOyB9KTtcbiAgPC9zY3JpcHQ+XG48L2JvZHk+PC9odG1sPlxuYDtcbn1cblxuLy8gYGV4cG9ydCBbLS1pZHMgYSxiXWAg4oCUIGJ1aWxkIHRoZSBkb3dubG9hZGFibGUgYXNzZXQgYnVuZGxlIGZyb20gZWFjaCBlbGVtZW50J3Ncbi8vIENIT1NFTiB2ZXJzaW9uOiBzdGFnZSBjbGVhbi1uYW1lZCBQTkdzICgrIHRoZSByYXcgY3JvcCB3aGVuIHRoZSBjaG9zZW4gaXMgYVxuLy8gcmVtb3ZhbCkgKyBtYW5pZmVzdC5qc29uICsgZ2FsbGVyeS5odG1sLCB6aXAgaW50byB0aGUgc2Vzc2lvbiBmaWxlcyBkaXIsIGFuZFxuLy8gcG9zdCBidW5kbGUuc2V0IHNvIHRoZSBzdXJmYWNlIG9mZmVycyBpdCB2aWEgL2Fzc2V0cy88bmFtZT4uIFJlc29sdmVzIHZlcnNpb25cbi8vIGZpbGVzIGJ5IEJBU0VOQU1FIGluIGZpbGVzX2RpciAocm9idXN0IHRvIHN0YWxlIGFic29sdXRlIHBhdGhzIGFmdGVyIGEgcmVzdG9yZSkuXG5hc3luYyBmdW5jdGlvbiBjbWRFeHBvcnQoc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkLCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgcyA9IHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pO1xuICBpZiAoIXMuZmlsZXNfZGlyKSBkaWUoXCJzZXNzaW9uIGhhcyBubyBmaWxlc19kaXIg4oCUIGNhbm5vdCBidWlsZCBhIGJ1bmRsZVwiLCBcImNvbmZsaWN0XCIpO1xuICBjb25zdCBpZEZpbHRlciA9XG4gICAgdHlwZW9mIGZsYWdzLmlkcyA9PT0gXCJzdHJpbmdcIlxuICAgICAgPyBuZXcgU2V0KFxuICAgICAgICAgIGZsYWdzLmlkc1xuICAgICAgICAgICAgLnNwbGl0KFwiLFwiKVxuICAgICAgICAgICAgLm1hcCgoeCkgPT4geC50cmltKCkpXG4gICAgICAgICAgICAuZmlsdGVyKEJvb2xlYW4pLFxuICAgICAgICApXG4gICAgICA6IHVuZGVmaW5lZDtcblxuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpKHMucG9ydCwgXCJHRVRcIiwgXCIvc3RhdGVcIik7XG4gIGlmIChzdGF0dXMgIT09IDIwMCkgZGllKGBzdGF0ZSBmYWlsZWQgKEhUVFAgJHtzdGF0dXN9KWAsIFwiaW50ZXJuYWxcIik7XG4gIGNvbnN0IHN0ID0gKGRhdGEgYXMgeyBzdGF0ZT86IHsgdGl0bGU/OiBzdHJpbmc7IGVsZW1lbnRzPzogRWxlbWVudFtdIH0gfSkuc3RhdGU7XG4gIGxldCBlbGVtZW50cyA9IChzdD8uZWxlbWVudHMgPz8gW10pLmZpbHRlcigoZSkgPT4gZS5zdGF0dXMgIT09IFwiZHJvcHBlZFwiKTtcbiAgaWYgKGlkRmlsdGVyKSBlbGVtZW50cyA9IGVsZW1lbnRzLmZpbHRlcigoZSkgPT4gaWRGaWx0ZXIuaGFzKGUuaWQpKTtcbiAgaWYgKCFlbGVtZW50cy5sZW5ndGgpXG4gICAgZGllKGlkRmlsdGVyID8gXCJubyBtYXRjaGluZyBlbGVtZW50cyBmb3IgLS1pZHNcIiA6IFwibm8gYXNzZXRzIHRvIGV4cG9ydFwiLCBcImNvbmZsaWN0XCIpO1xuICBjb25zdCB0aXRsZSA9IHN0Py50aXRsZSA/PyBcIm1hZ3BpZVwiO1xuXG4gIGNvbnN0IHN0YWdlRGlyID0gam9pbihzLmZpbGVzX2RpciwgXCJidW5kbGUtc3RhZ2VcIik7XG4gIGNvbnN0IHppcE5hbWUgPSBcIm1hZ3BpZS1idW5kbGUuemlwXCI7XG4gIGxldCByZXN1bHQ6IHsgY291bnQ6IG51bWJlciB9IHwgbnVsbCA9IG51bGw7XG4gIGxldCBmYWlsdXJlOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgLy8gVGhlIGBleHBvcnRgIGltcGVyYXRpdmUgc2V0IHN0YXR1cy5idXN5IG9uIHJlY2VpcHQ7IGNsZWFyIGl0IChhbmQgY2xlYW4gdGhlXG4gIC8vIHN0YWdlIGRpcikgb24gRVZFUlkgZXhpdCBwYXRoIOKAlCBvdGhlcndpc2UgdGhlIEV4cG9ydCBvdmVybGF5IHN0aWNrcy5cbiAgdHJ5IHtcbiAgICBybVN5bmMoc3RhZ2VEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICAvLyBGb2xkZXJpemU6IGZpbmFsIGNob3NlbiBhc3NldHMgdW5kZXIgYXNzZXRzLywgcmF3IGNyb3BzIHVuZGVyIGNyb3BzLyDigJQgc28gYVxuICAgIC8vIHdob2xlIGZvbGRlciBjYW4gYmUgZ3JhYmJlZCB3aXRob3V0IHBhcnNpbmcgbWl4ZWQgZmlsZXMuIGNyb3BzLyBpcyBjcmVhdGVkXG4gICAgLy8gbGF6aWx5IChvbmx5IGlmIHNvbWUgaXRlbSBoYXMgYSBzZXBhcmF0ZSByYXcgY3JvcCkuXG4gICAgY29uc3QgYXNzZXRzRGlyID0gam9pbihzdGFnZURpciwgXCJhc3NldHNcIik7XG4gICAgY29uc3QgY3JvcHNEaXIgPSBqb2luKHN0YWdlRGlyLCBcImNyb3BzXCIpO1xuICAgIG1rZGlyU3luYyhhc3NldHNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gICAgY29uc3QgbWFuaWZlc3Q6IE1hbmlmZXN0QXNzZXRbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgZWwgb2YgZWxlbWVudHMpIHtcbiAgICAgIGNvbnN0IGNob3NlbiA9IGNob3NlblZlcnNpb24oZWwpO1xuICAgICAgaWYgKCFjaG9zZW4pIGNvbnRpbnVlO1xuICAgICAgY29uc3QgY2hvc2VuRmlsZSA9IGpvaW4ocy5maWxlc19kaXIsIGJhc2VuYW1lKGNob3Nlbi5wYXRoKSk7XG4gICAgICBpZiAoIWV4aXN0c1N5bmMoY2hvc2VuRmlsZSkpIHtcbiAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYG1hZ3BpZSBleHBvcnQ6IG1pc3NpbmcgZmlsZSBmb3IgJHtlbC5uYW1lfSAoJHtjaG9zZW4ubW9kZWx9KVxcbmApO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGZpbGVCYXNlID0gYCR7c2FuaXRpemUoZWwubmFtZSl9LnBuZ2A7XG4gICAgICBjb3B5RmlsZVN5bmMoY2hvc2VuRmlsZSwgam9pbihhc3NldHNEaXIsIGZpbGVCYXNlKSk7XG4gICAgICAvLyB0aGUgcmF3IGNyb3AgdG9vLCBidXQgb25seSB3aGVuIHRoZSBjaG9zZW4gaXMgYSByZW1vdmFsIChlbHNlIGl0J3MgdGhlXG4gICAgICAvLyBzYW1lIGltYWdlIGFzIHRoZSBhc3NldCkuIFNhbWUgYmFzZSBuYW1lLCBpbiBjcm9wcy8uXG4gICAgICBsZXQgY3JvcFBhdGg6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgICAgaWYgKGNob3Nlbi5tb2RlbCAhPT0gXCJjcm9wXCIpIHtcbiAgICAgICAgY29uc3QgY3JvcEZpbGUgPSBqb2luKHMuZmlsZXNfZGlyLCBjdXRvdXRGaWxlbmFtZShlbC5uYW1lLCBcImNyb3BcIikpO1xuICAgICAgICBpZiAoZXhpc3RzU3luYyhjcm9wRmlsZSkpIHtcbiAgICAgICAgICBta2RpclN5bmMoY3JvcHNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgICAgIGNvcHlGaWxlU3luYyhjcm9wRmlsZSwgam9pbihjcm9wc0RpciwgZmlsZUJhc2UpKTtcbiAgICAgICAgICBjcm9wUGF0aCA9IGBjcm9wcy8ke2ZpbGVCYXNlfWA7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIG1hbmlmZXN0LnB1c2goe1xuICAgICAgICBuYW1lOiBlbC5uYW1lLFxuICAgICAgICB0eXBlOiBlbC50eXBlLFxuICAgICAgICBtb2RlbDogY2hvc2VuLm1vZGVsLFxuICAgICAgICBraW5kOiBjaG9zZW4ua2luZCA/PyBudWxsLFxuICAgICAgICBiYm94OiBlbC5iYm94LFxuICAgICAgICBmaWxlOiBgYXNzZXRzLyR7ZmlsZUJhc2V9YCxcbiAgICAgICAgY3JvcDogY3JvcFBhdGgsXG4gICAgICB9KTtcbiAgICB9XG4gICAgaWYgKCFtYW5pZmVzdC5sZW5ndGgpIHRocm93IG5ldyBFcnJvcihcIm5vIGNob3NlbiBhc3NldHMgZm91bmQgdG8gZXhwb3J0IChmaWxlcyBtaXNzaW5nPylcIik7XG5cbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihzdGFnZURpciwgXCJtYW5pZmVzdC5qc29uXCIpLFxuICAgICAgSlNPTi5zdHJpbmdpZnkoeyB0aXRsZSwgY291bnQ6IG1hbmlmZXN0Lmxlbmd0aCwgYXNzZXRzOiBtYW5pZmVzdCB9LCBudWxsLCAyKSxcbiAgICApO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihzdGFnZURpciwgXCJnYWxsZXJ5Lmh0bWxcIiksIGJ1aWxkR2FsbGVyeUh0bWwodGl0bGUsIG1hbmlmZXN0KSk7XG5cbiAgICAvLyB6aXAgaW50byBmaWxlc19kaXIgKG91dHNpZGUgdGhlIHN0YWdlIHNvIHRoZSBhcmNoaXZlIGlzbid0IHNlbGYtaW5jbHVkZWQpLlxuICAgIGNvbnN0IHppcFBhdGggPSBqb2luKHMuZmlsZXNfZGlyLCB6aXBOYW1lKTtcbiAgICBybVN5bmMoemlwUGF0aCwgeyBmb3JjZTogdHJ1ZSB9KTtcbiAgICBjb25zdCBwcm9jID0gQnVuLnNwYXduKFtcInppcFwiLCBcIi1yXCIsIFwiLXFcIiwgemlwUGF0aCwgXCIuXCJdLCB7XG4gICAgICBjd2Q6IHN0YWdlRGlyLFxuICAgICAgc3Rkb3V0OiBcInBpcGVcIixcbiAgICAgIHN0ZGVycjogXCJwaXBlXCIsXG4gICAgfSk7XG4gICAgY29uc3QgW3plcnIsIHpjb2RlXSA9IGF3YWl0IFByb21pc2UuYWxsKFtuZXcgUmVzcG9uc2UocHJvYy5zdGRlcnIpLnRleHQoKSwgcHJvYy5leGl0ZWRdKTtcbiAgICBpZiAoemNvZGUgIT09IDApIHRocm93IG5ldyBFcnJvcihgemlwIGZhaWxlZCAoZXhpdCAke3pjb2RlfSk6ICR7emVyci50cmltKCl9YCk7XG5cbiAgICBhd2FpdCBhcGkocy5wb3J0LCBcIlBPU1RcIiwgXCIvY21kXCIsIHtcbiAgICAgIHR5cGU6IFwiYnVuZGxlLnNldFwiLFxuICAgICAgbmFtZTogemlwTmFtZSxcbiAgICAgIGNvdW50OiBtYW5pZmVzdC5sZW5ndGgsXG4gICAgfSk7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYG1hZ3BpZTogYnVuZGxlZCAke21hbmlmZXN0Lmxlbmd0aH0gYXNzZXQocykg4oaSICR7emlwUGF0aH1cXG5gKTtcbiAgICByZXN1bHQgPSB7IGNvdW50OiBtYW5pZmVzdC5sZW5ndGggfTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGZhaWx1cmUgPSBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSk7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKHN0YWdlRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgYXdhaXQgYXBpKHMucG9ydCwgXCJQT1NUXCIsIFwiL2NtZFwiLCB7IHR5cGU6IFwic3RhdHVzXCIsIGJ1c3k6IGZhbHNlIH0pO1xuICB9XG5cbiAgaWYgKGZhaWx1cmUgfHwgIXJlc3VsdCkgZGllKGBleHBvcnQgZmFpbGVkOiAke2ZhaWx1cmUgPz8gXCJ1bmtub3duXCJ9YCwgXCJpbnRlcm5hbFwiKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGJ1bmRsZTogemlwTmFtZSwgY291bnQ6IHJlc3VsdC5jb3VudCB9KTtcbn1cblxuY29uc3QgSEVMUCA9IGBtYWdwaWUg4oCUIGEgc3RhbmRpbmcgcmV2aWV3IHN1cmZhY2UgZm9yIGV4dHJhY3RpbmcgYXNzZXRzIGZyb20gYSBjb21wb3NpdGUgaW1hZ2UuXG5cbiAgb3BlbiAgIFstLXRpdGxlIC4uXSBbLS1pbnRlbnQgLi5dIFstLW5vLW9wZW5dIFstLXRpbWVvdXQgU10gWy0tcmVzdG9yZSA8aWR8cGF0aD5dXG4gIHNlc3Npb25zICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxpc3Qgc2F2ZWQgKHJlc3VtYWJsZSkgc2Vzc2lvbnNcbiAgdGFpbCAgIFstLXNpbmNlIE5dICAgICAgICAgICAgICAgICAgU1NFIHVzZXIgZXZlbnRzIOKGkiBKU09OTCAod3JhcCB3aXRoIE1vbml0b3IpXG4gIHN0YXRlICBbLS1mdWxsXSAgICAgICAgICAgICAgICAgICAgIGxlYW4gc3RhdGUgc25hcHNob3QgKGFkZCAtLWZ1bGwgZm9yIHJhdylcbiAgc2F5ICAgIFt0ZXh0Li4uXSBbLS1zdGRpbl0gICAgICAgICAgcG9zdCBhZ2VudCBkaWFsb2d1ZSAodGV4dCBhcmdzIE9SIHBpcGVkIHN0ZGluKVxuICBhc2sgICAgPHRleHQuLi4+IFstLW9wdGlvbnMgXCJhfGJ8Y1wiXSAgIGFzayB0aGUgdXNlciBhIHF1ZXN0aW9uIChpbi10aHJlYWQpXG4gIHN0YXR1cyBvbiBbdGV4dC4uLl0gfCBzdGF0dXMgb2ZmICAgIHNob3cvaGlkZSB0aGUgXCJtYWdwaWUgd29ya2luZ1wiIHNwaW5uZXJcbiAgc291cmNlIDxpbWFnZVBhdGg+ICAgICAgICAgICAgICAgICAgcmVnaXN0ZXIgdGhlIGNvbXBvc2l0ZSB1bmRlciByZXZpZXcgKGNvbXB1dGVzIHNoYSArIHNpemUpXG4gIGRpc2NvdmVyICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJ1biBkaXNjb3ZlciBvbiB0aGUgY3VycmVudCBzb3VyY2Ug4oaSIHBvc3QgdGhlIGJyZWFrZG93biAobmVlZHMgT1BFTlJPVVRFUl9BUElfS0VZKVxuICBleHRyYWN0IFstLWlkcyBhLGJdIFstLXJlbW92ZV0gWy0tYWxwaGEgYXV0b3xhbGx8bm9uZV0gWy0tcGFkIE5dIFstLW1vZGVsIDxtPl0gWy0tbGFiZWwgPG5hbWU+XVxuICAgICAgICAgIGN1dCBzbGljZXMgKGNyb3Atb25seTsgLS1yZW1vdmUgYWRkcyByZW1iZykuIC0tbW9kZWwgPSBhIHJlbWJnIG1vZGVsIG5hbWUgKGlzbmV0LWdlbmVyYWwtdXNlLFxuICAgICAgICAgIGJpcmVmbmV0LWdlbmVyYWwsIOKApikgT1IgYSBtZWRpYS1mb3JnZSBiZy1yZW1vdmUgbW9kZWwgaWQgKGEgcHJvdmlkZXIgcGF0aCBsaWtlXG4gICAgICAgICAgZmFsLWFpL2JyaWEvYmFja2dyb3VuZC9yZW1vdmUg4oCUIERJU0NPVkVSIHZpYSBcXGBtZWRpYS1mb3JnZSBtb2RlbHMgbGlzdFxcYCwgbmV2ZXIgaGFyZGNvZGUpO1xuICAgICAgICAgIC0tbGFiZWwgc2V0cyB0aGUgdmVyc2lvbidzIGZyaWVuZGx5IHN0cmlwIGxhYmVsIChkZWZhdWx0cyBzZW5zaWJseSlcbiAgZXhwb3J0IFstLWlkcyBhLGJdICAgICAgICAgICAgICAgICAgYnVpbGQgbWFncGllLWJ1bmRsZS56aXAg4oCUIGFzc2V0cy8gKGNob3NlbiBmaW5hbHMpICsgY3JvcHMvIChyYXcgY3JvcHMpICsgbWFuaWZlc3QuanNvbiArIGdhbGxlcnkuaHRtbCAoYmFja2Ryb3AgdG9nZ2xlICsgdHlwZSBmaWx0ZXJzKVxuICBlbGVtZW50LWFkZCAtLWJib3ggXCJ4MSx5MSx4Mix5MlwiIFstLW5hbWUgLi5dIFstLXR5cGUgLi5dICAgYm94IGEgcmVnaW9uIChzb3VyY2UgcHgpXG4gIGVsZW1lbnQtcmVtb3ZlIDxpZD4gICAgICAgICAgICAgICAgIHJldHJhY3QgYSBib3hlZCByZWdpb25cbiAgY21kICAgIFstLXN0ZGluXSAgICAgICAgICAgICAgICAgICAgUE9TVCBhIHJhdyBBZ2VudENvbW1hbmQgSlNPTiBib2R5IGZyb20gc3RkaW5cbiAgY2xvc2UgfCBpbmZvIHwgaGVscFxuICAtLXZlcnNpb24gICAgICAgICAgICAgICAgICAgICAgICAgICBwcmludCBtYWdwaWUncyB2ZXJzaW9uIGFzIEpTT05cblxuICBBZGQgLS1zZXNzaW9uIDxpZD4gdG8gdGFyZ2V0IGEgc3BlY2lmaWMgc2Vzc2lvbiAoZGVmYXVsdDogbW9zdCByZWNlbnQpLiBJdCBpc1xuICBhY2NlcHRlZCBieSBldmVyeSB2ZXJiIHRoYXQgYWN0cyBvbiBhIHNlc3Npb24g4oCUIG5vdCBieSBvcGVuLCBzZXNzaW9ucyBvciBoZWxwLFxuICB3aGljaCBkbyBub3QgaGF2ZSBvbmUgdG8gdGFyZ2V0LlxuXG4gIEZsYWdzIGFyZSBzY29wZWQgdG8gdGhlaXIgdmVyYjogZXh0cmFjdCdzIC0tcGFkIGlzIG5vdCBhY2NlcHRlZCBieSBzYXkuIEFcbiAgcmVqZWN0aW9uIGxpc3RzIHdoYXQgdGhlIHZlcmIgaXQgbmFtZXMgZG9lcyBhY2NlcHQuXG5cbiAgT3V0cHV0OiBtYWdwaWUgcHJpbnRzIEpTT04gYnkgZGVmYXVsdCBvbiBzdGRvdXQuIEV2ZXJ5IHZlcmIgd3JpdGVzIE9ORSBKU09OXG4gIGRvY3VtZW50IHRoZXJlIOKAlCBleGNlcHQgXFxgdGFpbFxcYCwgd2hpY2ggaXMgYSBzdHJlYW0gYW5kIHdyaXRlcyBvbmUgcGVyIGxpbmVcbiAgKEpTT05MKS4gUHJvc2UsIGxpdmVuZXNzIGFuZCBkaWFnbm9zdGljcyBnbyB0byBzdGRlcnIuIFxcYC0tZnVsbFxcYFxuICB3aWRlbnMgdGhlIHN0YXRlIHBheWxvYWQ7IGl0IGRvZXMgbm90IHN3aXRjaCBmb3JtYXRzLmA7XG5cbmFzeW5jIGZ1bmN0aW9uIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBbdmVyYiwgLi4ucmVzdF0gPSBhcmd2O1xuICBDVVJSRU5UX0NPTU1BTkQgPSB2ZXJiID8/IG51bGw7XG5cbiAgLy8gUk9PVCBUT0tFTlMgRklSU1QsIGJlZm9yZSBhbnkgZmxhZyBwYXJzaW5nLiBUaGVzZSBhcmUgbm90IHZlcmJzIGFuZCB0aGV5XG4gIC8vIGNhcnJ5IG5vIGZsYWdzLCBzbyByZXNvbHZpbmcgdGhlbSBoZXJlIGtlZXBzIHRoZW0gb3V0IG9mIGV2ZXJ5IHZlcmIncyBzZXQuXG4gIGlmICh2ZXJiID09PSBcIi0taGVscFwiIHx8IHZlcmIgPT09IFwiLWhcIikge1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0hFTFB9XFxuYCk7XG4gICAgcmV0dXJuIDA7XG4gIH1cbiAgaWYgKHZlcmIgPT09IFwiLS12ZXJzaW9uXCIgfHwgdmVyYiA9PT0gXCItVlwiKSB7XG4gICAgcHJpbnRKc29uKHsgbmFtZTogXCJtYWdwaWVcIiwgdmVyc2lvbjogUExVR0lOX1ZFUlNJT04gfSk7XG4gICAgcmV0dXJuIDA7XG4gIH1cbiAgaWYgKHZlcmIgPT09IHVuZGVmaW5lZCkge1xuICAgIC8vIEEgYmFyZSBpbnZvY2F0aW9uIGlzIGEgdXNhZ2UgZXJyb3IsIG5vdCBhIGhlbHAgcGF0aCDigJQgbWFncGllIGlzIGRyaXZlbiBieVxuICAgIC8vIGFuIGFnZW50LCBhbmQgYW4gZW1wdHkgYXJndiBpcyBhbiBhZ2VudCB0aGF0IGZhaWxlZCB0byBuYW1lIHdoYXQgaXRcbiAgICAvLyB3YW50ZWQuIHN0ZG91dCBzdGF5cyBlbXB0eTsgaXQgY2FycmllcyBkYXRhIGFuZCB0aGlzIGhhcyBub25lLlxuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgZXJyb3JFbnZlbG9wZShcInVzYWdlXCIsIFwibm8gdmVyYiBnaXZlblwiLCB7IGhpbnQ6IFwicnVuOiBjbGkudHMgaGVscFwiLCBjaG9pY2VzOiBWRVJCUyB9KSxcbiAgICApO1xuICAgIHJldHVybiAyO1xuICB9XG4gIC8vIFRIRSBWRVJCIElTIFJFSkVDVEVEIEJFRk9SRSBJVFMgRkxBR1MgQVJFIFJFQUQuIEl0IGhhcyB0byBiZTogd2hpY2ggZmxhZ3NcbiAgLy8gYXJlIGxlZ2FsIGlzIGEgcXVlc3Rpb24gYWJvdXQgdGhlIHZlcmIsIHNvIHRoZXJlIGlzIG5vIHNldCB0byBjaGVjayBhZ2FpbnN0XG4gIC8vIHVudGlsIHdlIGtub3cgaXQgaXMgYSByZWFsIG9uZS5cbiAgaWYgKCFpc1ZlcmIodmVyYikpIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgIGVycm9yRW52ZWxvcGUoXCJ1c2FnZVwiLCBgdW5rbm93biB2ZXJiIFwiJHt2ZXJifVwiYCwge1xuICAgICAgICBoaW50OiBcInJ1bjogY2xpLnRzIGhlbHBcIixcbiAgICAgICAgY2hvaWNlczogVkVSQlMsXG4gICAgICB9KSxcbiAgICApO1xuICAgIHJldHVybiAyO1xuICB9XG5cbiAgbGV0IHBvczogc3RyaW5nW107XG4gIGxldCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj47XG4gIHRyeSB7XG4gICAgKHsgcG9zLCBmbGFncyB9ID0gcGFyc2VBcmdzKHJlc3QsIHZlcmIpKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGlmICghKGUgaW5zdGFuY2VvZiBVc2FnZUVycm9yKSkgdGhyb3cgZTtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgIGVycm9yRW52ZWxvcGUoXCJ1c2FnZVwiLCBlLm1lc3NhZ2UsIHtcbiAgICAgICAgaGludDogYGZsYWdzIGFyZSBzY29wZWQgdG8gdGhlIHZlcmIg4oCUIGNob2ljZXMgbGlzdHMgd2hhdCBcXGAke3ZlcmJ9XFxgIGFjY2VwdHM7IGZvciBmcmVlIHRleHQgY29udGFpbmluZyBkYXNoZXMgdXNlIC0tc3RkaW4sIG9yIHB1dCBpdCBhZnRlciBhIGJhcmUgLS1gLFxuICAgICAgICBjaG9pY2VzOiBmbGFnc0Zvcih2ZXJiKSxcbiAgICAgIH0pLFxuICAgICk7XG4gICAgcmV0dXJuIDI7XG4gIH1cbiAgY29uc3Qgc2Vzc2lvbiA9IHR5cGVvZiBmbGFncy5zZXNzaW9uID09PSBcInN0cmluZ1wiID8gZmxhZ3Muc2Vzc2lvbiA6IHVuZGVmaW5lZDtcblxuICBzd2l0Y2ggKHZlcmIpIHtcbiAgICBjYXNlIFwib3BlblwiOlxuICAgICAgYXdhaXQgY21kT3BlbihmbGFncyk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwidGFpbFwiOlxuICAgICAgYXdhaXQgY21kVGFpbChzZXNzaW9uLCB0eXBlb2YgZmxhZ3Muc2luY2UgPT09IFwic3RyaW5nXCIgPyBwYXJzZUludChmbGFncy5zaW5jZSwgMTApIDogLTEpO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcInN0YXRlXCI6XG4gICAgICBhd2FpdCBjbWRTdGF0ZShzZXNzaW9uLCBmbGFncy5mdWxsID09PSB0cnVlKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJzYXlcIjoge1xuICAgICAgY29uc3QgdGV4dCA9IGZsYWdzLnN0ZGluID09PSB0cnVlID8gYXdhaXQgcmVhZFN0ZGluKCkgOiBwb3Muam9pbihcIiBcIik7XG4gICAgICBpZiAoIXRleHQpIGRpZShcInVzYWdlOiBzYXkgPHRleHQuLi4+IHwgc2F5IC0tc3RkaW5cIik7XG4gICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJzYXlcIiwgdGV4dCB9KTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBjYXNlIFwiYXNrXCI6IHtcbiAgICAgIGlmICghcG9zLmxlbmd0aCkgZGllKCd1c2FnZTogYXNrIDx0ZXh0Li4uPiBbLS1vcHRpb25zIFwiYXxifGNcIl0nKTtcbiAgICAgIGNvbnN0IG1zZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IHR5cGU6IFwiYXNrXCIsIHRleHQ6IHBvcy5qb2luKFwiIFwiKSB9O1xuICAgICAgaWYgKHR5cGVvZiBmbGFncy5vcHRpb25zID09PSBcInN0cmluZ1wiKSB7XG4gICAgICAgIG1zZy5vcHRpb25zID0gZmxhZ3Mub3B0aW9uc1xuICAgICAgICAgIC5zcGxpdChcInxcIilcbiAgICAgICAgICAubWFwKChzKSA9PiBzLnRyaW0oKSlcbiAgICAgICAgICAuZmlsdGVyKEJvb2xlYW4pO1xuICAgICAgfVxuICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCBtc2cpO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGNhc2UgXCJzdGF0dXNcIjpcbiAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICB0eXBlOiBcInN0YXR1c1wiLFxuICAgICAgICBidXN5OiBwb3NbMF0gPT09IFwib25cIixcbiAgICAgICAgdGV4dDogcG9zLnNsaWNlKDEpLmpvaW4oXCIgXCIpLFxuICAgICAgfSk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwic291cmNlXCI6XG4gICAgICBpZiAoIXBvcy5sZW5ndGgpIGRpZShcInVzYWdlOiBzb3VyY2UgPGltYWdlUGF0aD5cIik7XG4gICAgICBhd2FpdCBjbWRTb3VyY2Uoc2Vzc2lvbiwgcG9zWzBdKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJkaXNjb3ZlclwiOlxuICAgICAgYXdhaXQgY21kRGlzY292ZXIoc2Vzc2lvbik7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiZXh0cmFjdFwiOlxuICAgICAgYXdhaXQgY21kRXh0cmFjdChzZXNzaW9uLCBmbGFncyk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiZXhwb3J0XCI6XG4gICAgICBhd2FpdCBjbWRFeHBvcnQoc2Vzc2lvbiwgZmxhZ3MpO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcImVsZW1lbnQtYWRkXCI6XG4gICAgICBhd2FpdCBjbWRFbGVtZW50QWRkKHNlc3Npb24sIGZsYWdzKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJlbGVtZW50LXJlbW92ZVwiOlxuICAgICAgaWYgKCFwb3MubGVuZ3RoKSBkaWUoXCJ1c2FnZTogZWxlbWVudC1yZW1vdmUgPGlkPlwiKTtcbiAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcImVsZW1lbnQucmVtb3ZlXCIsIGlkOiBwb3NbMF0gfSk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiY21kXCI6IHtcbiAgICAgIC8vIFBPU1QgYSByYXcgQWdlbnRDb21tYW5kIEpTT04gYm9keSAoZnJvbSBzdGRpbikg4oCUIHRoZSBlc2NhcGUgaGF0Y2ggZm9yXG4gICAgICAvLyBjb21tYW5kcyBjYXJyeWluZyBOTCB0ZXh0IG9yIHJpY2ggcGF5bG9hZHMgKGUuZy4gZWxlbWVudHMuc2V0KS5cbiAgICAgIGNvbnN0IHJhdyA9IGZsYWdzLnN0ZGluID09PSB0cnVlID8gYXdhaXQgcmVhZFN0ZGluKCkgOiBwb3Muam9pbihcIiBcIik7XG4gICAgICBpZiAoIXJhdykgZGllKFwidXNhZ2U6IGNtZCAtLXN0ZGluICAocGlwZSBhIEpTT04gQWdlbnRDb21tYW5kIGJvZHkpXCIpO1xuICAgICAgbGV0IGJvZHk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgdHJ5IHtcbiAgICAgICAgYm9keSA9IEpTT04ucGFyc2UocmF3KTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICBkaWUoXCJjbWQ6IGJvZHkgaXMgbm90IHZhbGlkIEpTT05cIik7XG4gICAgICB9XG4gICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIGJvZHkpO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGNhc2UgXCJjbG9zZVwiOlxuICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwiY2xvc2VcIiB9KTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJpbmZvXCI6XG4gICAgICBjbWRJbmZvKHNlc3Npb24pO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcInNlc3Npb25zXCI6XG4gICAgICBjbWRTZXNzaW9ucygpO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcImhlbHBcIjpcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0hFTFB9XFxuYCk7XG4gICAgICBicmVhaztcbiAgICBkZWZhdWx0OlxuICAgICAgLy8gVU5SRUFDSEFCTEUgQlkgQ09OU1RSVUNUSU9OIOKAlCBgdmVyYmAgaXMgbmFycm93ZWQgdG8gVmVyYiBhYm92ZSwgYW5kIGFcbiAgICAgIC8vIHRlc3QgYmluZHMgVkVSQl9TUEVDJ3Mga2V5cyB0byB0aGlzIHN3aXRjaCdzIGNhc2UgbGFiZWxzLiBLZXB0IGFueXdheTpcbiAgICAgIC8vIGlmIHRoYXQgYmluZGluZyBldmVyIGJyZWFrcywgdGhlIGFsdGVybmF0aXZlIGlzIGZhbGxpbmcgdGhyb3VnaCB0b1xuICAgICAgLy8gYHJldHVybiAwYCB3aXRoIGVtcHR5IHN0ZG91dCwgd2hpY2ggcmVwb3J0cyBzdWNjZXNzIGZvciB3b3JrIG5ldmVyIGRvbmUuXG4gICAgICAvLyBUaGF0IGlzIHRoZSBmYWlsdXJlIHRoaXMgYnJhbmNoIGV4aXN0cyB0byByZW1vdmUsIGFuZCBpdCB3b3VsZCBiZSBzaWxlbnQuXG4gICAgICBkaWUoYG5vIGhhbmRsZXIgZm9yIHZlcmIgXCIke3ZlcmJ9XCJgLCBcImludGVybmFsXCIpO1xuICB9XG5cbiAgcmV0dXJuIDA7XG59XG5cbmlmIChpbXBvcnQubWV0YS5tYWluKSB7XG4gIC8vIGBwcm9jZXNzLmV4aXRDb2RlYCArIGEgbmF0dXJhbCByZXR1cm4sIE5FVkVSIGBwcm9jZXNzLmV4aXQoY29kZSlgOiBCdW4nc1xuICAvLyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGEgcGlwZSAoc3luY2hyb25vdXMgb24gYSBUVFkgb3IgZmlsZSksIHNvIGFuXG4gIC8vIGV4cGxpY2l0IGV4aXQgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlCBtZWFzdXJlZCBhdCBleGFjdGx5XG4gIC8vIDY1LDUzNiBieXRlcy4gVGhlIHBheWxvYWQgaXMgY29tcGxldGUgYW5kIG9ubHkgdGhlIHdyaXRlIGlzIGxvc3QsIHNvIHRoZVxuICAvLyBjYWxsZXIgZ2V0cyB3ZWxsLWZvcm1lZC1sb29raW5nIEpTT04gdGhhdCBzdG9wcyBtaWQtc3RyaW5nLiBSZXByb2R1Y2VkLFxuICAvLyBmaXhlZCBhbmQgZ2F0ZWQgaW4gYm91bnR5IGZpcnN0IChQMCwgIzc3LyM3OCk7IHNhbWUgc2hhcGUsIHNhbWUgcmVhc29uLlxuICAvLyBEbyBub3QgdGlkeSB0aGlzIGJhY2sgaW50byBhbiBleHBsaWNpdCBleGl0LlxuICBwcm9jZXNzLmV4aXRDb2RlID0gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuXG5leHBvcnQgeyBtYWluIH07XG5cbi8qKlxuICogVGhlIFNISVBQRUQgRU5UUlkgUE9JTlQsIGNhbGxlZCBieSBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL21hZ3BpZS9zY3JpcHRzL2NsaS50c2BcbiAqIGFmdGVyIHRoZSBidW5kbGUgaXMgaW1wb3J0ZWQuXG4gKlxuICog4puUIElUIFRBS0VTIE5PIEFSR1VNRU5UUywgQU5EIFRIQVQgSVMgVEhFIFBPSU5ULiBhcmd2IGJlbG9uZ3MgdG8gd2hpY2hldmVyIGZpbGVcbiAqIFBBUlNFUyBpdCwgYW5kIHRoYXQgaXMgdGhpcyBvbmUuIEFuIGVhcmxpZXIgbGF1bmNoZXIgcmVhZFxuICogYHByb2Nlc3MuYXJndi5zbGljZSgyKWAgaXRzZWxmIGFuZCBwYXNzZWQgaXQgaW4g4oCUIHdoaWNoIG1hZGUgdGhlIGxhdW5jaGVyIG1hdGNoXG4gKiBgZ3JpbW9pcmUvbGliL2VudHJ5LXBvaW50cy50c2AncyBQQVJTRVNfQVJHUyBwcmVkaWNhdGUgKGBwcm9jZXNzLmFyZ3ZgKSwgc28gdGhlXG4gKiByb3N0ZXIgY291bnRlZCBhIDMtbGluZSBmb3J3YXJkZXIgYXMgYW4gYXJnLXBhcnNpbmcgZW50cnkgcG9pbnQgYW5kIHRoZW5cbiAqIHJlcG9ydGVkIHRoZSBzcGVsbCdzIGRvY3VtZW50ZWQgZmxhZ3MgYXMgVU5SRVNPTFZFRCBhZ2FpbnN0IGEgZmlsZSB0aGF0XG4gKiByZWNvZ25pc2VzIG5vbmUuIEtlZXBpbmcgYXJndiBvbiB0aGlzIHNpZGUgbWFrZXMgdGhlIGVudW1lcmF0b3IncyBhbnN3ZXIgdHJ1ZVxuICogaW5zdGVhZCBvZiBtYWtpbmcgaXRzIHJlZ2V4IGxvb3Nlci5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bigpOiBQcm9taXNlPG51bWJlcj4ge1xuICByZXR1cm4gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuIiwKICAgICIvLyBzY3JpcHRzL2JhY2tlbmQudHNcbi8vIFJlbW92YWwtYmFja2VuZCByZWdpc3RyeS4gVGhlIHJlYnVpbHQgbWFncGllIGNvbXBhcmVzIGJhY2tncm91bmQtcmVtb3ZhbFxuLy8gcmVzdWx0cyBmcm9tIG11bHRpcGxlIGJhY2tlbmRzIHBlciBlbGVtZW50OyB0aGUgdXNlciBwaWNrcyB0aGUgd2lubmVyLiBUaGlzXG4vLyBmaWxlIGRlZmluZXMgdGhlIGNvbnRyYWN0LCB0aGUgKGxpdmUpIHJlbWJnIGltcGwsIGEgbWVkaWEtZm9yZ2Ugc3R1YiBmb3IgdGhlXG4vLyBuZXh0IHN1Yi1waGFzZSwgYW5kIGEgcmVnaXN0cnkuXG4vL1xuLy8gSU1BR0UgT1BTIE5PVEU6IGNyb3BwaW5nIHRoZSBlbGVtZW50J3MgYmJveCBvdXQgb2YgdGhlIHNvdXJjZSBpcyBOT1QgZG9uZSB3aXRoXG4vLyBCdW4uSW1hZ2UgKGl0IGhhcyByZXNpemUvZW5jb2RlL21ldGFkYXRhIGJ1dCBOTyBjcm9wL2V4dHJhY3QpLiByZW1iZ0JhY2tlbmRcbi8vIHNoZWxscyBvdXQgdG8gc2NyaXB0cy9yZW1vdmUucHkgKFBpbGxvdyBjcm9wICsgcmVtYmcpIOKAlCB0aGUgY2FsbGVyIG93bnMgdGhlXG4vLyBvdXRwdXQgcGF0aCAodGhlIHNlc3Npb24gZmlsZXMgZGlyKS5cblxuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbi8vIOKUgOKUgCBhbHBoYSBwb2xpY3kg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vLyBUaGUgdHlwZS1kcml2ZW4gYWxwaGEgcG9saWN5IGxpdmVzIGluIHNoYXJlZC9hbHBoYS50cyAoYnJvd3Nlci1zYWZlLCBzb1xuLy8gdGhlIHN1cmZhY2Ugc2hhcmVzIG9uZSBzb3VyY2Ugb2YgdHJ1dGgg4oCUIFJlbW92ZUdhbGxlcnkudHN4IHJlYWRzIGl0IHRvbyxcbi8vIHdoaWNoIGlzIHdoYXQgbWFrZXMgaXQgdHdvLXNpZGVkIHJhdGhlciB0aGFuIGRhZW1vbi1vbmx5KS4gUmUtZXhwb3J0ZWQgaGVyZVxuLy8gZm9yIHRoZSBhZ2VudC1zaWRlIGNvbnN1bWVycyAoY2xpLnRzLCBiYWNrZW5kIHRlc3RzKSB0aGF0IGltcG9ydCBpdCBmcm9tXG4vLyB0aGlzIG1vZHVsZS5cbmltcG9ydCB0eXBlIHsgQWxwaGFQb2xpY3kgfSBmcm9tIFwiLi4vc2hhcmVkL2FscGhhXCI7XG5pbXBvcnQgdHlwZSB7IEJib3ggfSBmcm9tIFwiLi4vc2hhcmVkL3R5cGVzXCI7XG5cbmV4cG9ydCB7XG4gIEFMUEhBX0FVVE9fVFlQRVMsXG4gIEFMUEhBX0ZPUkJJRERFTl9UWVBFUyxcbiAgdHlwZSBBbHBoYVBvbGljeSxcbiAgc2hvdWxkUmVtb3ZlLFxufSBmcm9tIFwiLi4vc2hhcmVkL2FscGhhXCI7XG5cbi8vIEEgcmVnaW9uIG9mIHRoZSBzb3VyY2UgdG8gY3V0IGEgdHJhbnNwYXJlbnQgYXNzZXQgZnJvbS5cbmV4cG9ydCB0eXBlIENyb3AgPSB7XG4gIC8vIG9uLWRpc2sgcGF0aCB0byB0aGUgc291cmNlIGNvbXBvc2l0ZSAob3IgYSBwcmUtY3JvcHBlZCByZWdpb24g4oCUIHNlZSBjcm9wIG5vdGUpXG4gIHNvdXJjZVBhdGg6IHN0cmluZztcbiAgLy8gdGhlIGVsZW1lbnQncyBwaXhlbCBiYm94IFt4MSwgeTEsIHgyLCB5Ml0gd2l0aGluIHRoZSBzb3VyY2VcbiAgYmJveDogQmJveDtcbiAgLy8gZWxlbWVudCB0eXBlIGRyaXZlcyB3aGV0aGVyIHJlbW92YWwgZXZlbiBtYWtlcyBzZW5zZSAocGFsZXR0ZXMvc2NyZWVuc2hvdHNcbiAgLy8gZ2V0IGRlc3Ryb3llZCBieSByZW1iZyDigJQgc2VlIG1hZ3BpZSdzIEFscGhhIFBvbGljeSlcbiAgdHlwZTogc3RyaW5nO1xufTtcblxuLy8gVGhlIHJlc3VsdCBvZiBhIHJlbW92YWwgcGFzcyDigJQgYSBjdXRvdXQgUE5HICh3aXRoIGFscGhhKSB0aGUgc3VyZmFjZSBkaXNwbGF5cy5cbmV4cG9ydCB0eXBlIEN1dG91dCA9IHtcbiAgaWQ6IHN0cmluZztcbiAgYmFja2VuZDogc3RyaW5nOyAvLyB3aGljaCBSZW1vdmFsQmFja2VuZCBwcm9kdWNlZCBpdFxuICBwYXRoOiBzdHJpbmc7IC8vIG9uLWRpc2sgUE5HIHRoZSBhZ2VudCByZWFkcyAvIHRoZSBzdXJmYWNlIHNlcnZlc1xuICAvLyBUT0RPKG1vY2spOiB3aWR0aC9oZWlnaHQsIGEgcHJldmlldyBzcmMsIHRpbWluZy9jb3N0LCBhIHF1YWxpdHkgc2lnbmFsXG59O1xuXG4vLyBPcHRpb25hbCBrbm9icyB0aHJlYWRlZCB0aHJvdWdoIHRvIHJlbW92ZS5weSAodGhlIGV4dHJhY3QgbG9vcCBob25vcnMgLS1hbHBoYVxuLy8gLyAtLXBhZCAvIC0tbW9kZWwgZnJvbSB0aGUgQ0xJIHZlcmIpLiBBbGwgaGF2ZSBzZW5zaWJsZSBkZWZhdWx0cyBpbnNpZGVcbi8vIHJlbW92ZS5weS4gYG1vZGVsYCBuYW1lcyBhIHNwZWNpZmljIHJlbWJnIG1vZGVsIGZvciB0aGUgbW9kZWwtYWdub3N0aWMgcmV0cnlcbi8vIChvbWl0IOKGkiByZW1iZydzIGRlZmF1bHQgdTJuZXQpLlxuZXhwb3J0IHR5cGUgQ3V0T3B0aW9ucyA9IHsgYWxwaGE/OiBBbHBoYVBvbGljeTsgcGFkPzogbnVtYmVyOyBtb2RlbD86IHN0cmluZyB9O1xuXG5leHBvcnQgaW50ZXJmYWNlIFJlbW92YWxCYWNrZW5kIHtcbiAgbmFtZTogc3RyaW5nO1xuICAvLyBDdXQgdGhlIGJib3ggcmVnaW9uIG91dCBvZiB0aGUgc291cmNlIGludG8gYG91dFBhdGhgIGFuZCByZXR1cm4gdGhlIGN1dG91dC5cbiAgLy8gVGhlIGNhbGxlciBvd25zIGBvdXRQYXRoYCAodGhlIHNlc3Npb24gZmlsZXMgZGlyKS4gYG9wdHNgIGNhcnJpZXMgdGhlXG4gIC8vIGFscGhhLXBvbGljeSAvIHBhZGRpbmcgdGhlIENMSSBleHRyYWN0IHZlcmIgcGFzc2VzIHRocm91Z2guXG4gIGN1dChjcm9wOiBDcm9wLCBvdXRQYXRoOiBzdHJpbmcsIG9wdHM/OiBDdXRPcHRpb25zKTogUHJvbWlzZTxDdXRvdXQ+O1xufVxuXG4vLyBSZXNvbHZlIHNjcmlwdHMvcmVtb3ZlLnB5IHJlbGF0aXZlIHRvIHRoaXMgbW9kdWxlIChub3QgY3dkKS5cbmNvbnN0IFJFTU9WRV9QWSA9IGpvaW4oaW1wb3J0Lm1ldGEuZGlyLCBcInJlbW92ZS5weVwiKTtcblxuZnVuY3Rpb24gc2hvcnRJZChwcmVmaXg6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGJ1ZiA9IG5ldyBVaW50OEFycmF5KDQpO1xuICBjcnlwdG8uZ2V0UmFuZG9tVmFsdWVzKGJ1Zik7XG4gIGNvbnN0IGhleCA9IEFycmF5LmZyb20oYnVmLCAoYikgPT4gYi50b1N0cmluZygxNikucGFkU3RhcnQoMiwgXCIwXCIpKS5qb2luKFwiXCIpO1xuICByZXR1cm4gYCR7cHJlZml4fS0ke2hleH1gO1xufVxuXG4vLyByZW1iZyBiYWNrZW5kIOKAlCBzaGVsbHMgb3V0IHRvIHNjcmlwdHMvcmVtb3ZlLnB5IChQaWxsb3cgY3JvcCArIHJlbWJnKS4gVGhlXG4vLyBjYWxsZXIgcGFzc2VzIHRoZSBvdXRwdXQgbG9jYXRpb247IHdlIHBhcnNlIHJlbW92ZS5weSdzIG9uZSBKU09OIGxpbmUgYW5kXG4vLyByZXR1cm4gdGhlIGN1dG91dC5cbmV4cG9ydCBjb25zdCByZW1iZ0JhY2tlbmQ6IFJlbW92YWxCYWNrZW5kID0ge1xuICBuYW1lOiBcInJlbWJnXCIsXG4gIGFzeW5jIGN1dChjcm9wOiBDcm9wLCBvdXRQYXRoOiBzdHJpbmcsIG9wdHM6IEN1dE9wdGlvbnMgPSB7fSk6IFByb21pc2U8Q3V0b3V0PiB7XG4gICAgY29uc3QgW3gxLCB5MSwgeDIsIHkyXSA9IGNyb3AuYmJveDtcbiAgICBjb25zdCBhcmdzID0gW1xuICAgICAgXCJweXRob24zXCIsXG4gICAgICBSRU1PVkVfUFksXG4gICAgICBcIi0tc291cmNlXCIsXG4gICAgICBjcm9wLnNvdXJjZVBhdGgsXG4gICAgICBcIi0tYmJveFwiLFxuICAgICAgYCR7eDF9LCR7eTF9LCR7eDJ9LCR7eTJ9YCxcbiAgICAgIFwiLS10eXBlXCIsXG4gICAgICBjcm9wLnR5cGUsXG4gICAgICBcIi0tb3V0XCIsXG4gICAgICBvdXRQYXRoLFxuICAgIF07XG4gICAgaWYgKG9wdHMuYWxwaGEpIGFyZ3MucHVzaChcIi0tYWxwaGFcIiwgb3B0cy5hbHBoYSk7XG4gICAgaWYgKHR5cGVvZiBvcHRzLnBhZCA9PT0gXCJudW1iZXJcIikgYXJncy5wdXNoKFwiLS1wYWRcIiwgU3RyaW5nKG9wdHMucGFkKSk7XG4gICAgaWYgKG9wdHMubW9kZWwpIGFyZ3MucHVzaChcIi0tbW9kZWxcIiwgb3B0cy5tb2RlbCk7XG5cbiAgICBjb25zdCBwcm9jID0gQnVuLnNwYXduKGFyZ3MsIHsgc3Rkb3V0OiBcInBpcGVcIiwgc3RkZXJyOiBcInBpcGVcIiB9KTtcbiAgICBjb25zdCBbc3Rkb3V0LCBzdGRlcnIsIGV4aXRDb2RlXSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICAgIG5ldyBSZXNwb25zZShwcm9jLnN0ZG91dCkudGV4dCgpLFxuICAgICAgbmV3IFJlc3BvbnNlKHByb2Muc3RkZXJyKS50ZXh0KCksXG4gICAgICBwcm9jLmV4aXRlZCxcbiAgICBdKTtcbiAgICBpZiAoZXhpdENvZGUgIT09IDApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYHJlbWJnIHJlbW92ZS5weSBmYWlsZWQgKGV4aXQgJHtleGl0Q29kZX0pOiAke3N0ZGVyci50cmltKCkgfHwgc3Rkb3V0LnRyaW0oKX1gLFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgbGluZSA9IHN0ZG91dC50cmltKCkuc3BsaXQoXCJcXG5cIikuZmlsdGVyKEJvb2xlYW4pLnBvcCgpID8/IFwiXCI7XG4gICAgbGV0IHBhcnNlZDogeyBvdXQ/OiBzdHJpbmc7IHJlbW92ZWQ/OiBib29sZWFuIH07XG4gICAgdHJ5IHtcbiAgICAgIHBhcnNlZCA9IEpTT04ucGFyc2UobGluZSkgYXMgeyBvdXQ/OiBzdHJpbmc7IHJlbW92ZWQ/OiBib29sZWFuIH07XG4gICAgfSBjYXRjaCB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYHJlbWJnIHJlbW92ZS5weSBwcm9kdWNlZCBubyBwYXJzZWFibGUgSlNPTiBsaW5lOiAke3N0ZG91dC50cmltKCl9YCk7XG4gICAgfVxuICAgIHJldHVybiB7IGlkOiBzaG9ydElkKFwiY3V0XCIpLCBiYWNrZW5kOiBcInJlbWJnXCIsIHBhdGg6IHBhcnNlZC5vdXQgPz8gb3V0UGF0aCB9O1xuICB9LFxufTtcblxuLy8gbWVkaWEtZm9yZ2UgYmFja2VuZCDigJQgY2xvdWQgYmFja2dyb3VuZCByZW1vdmFsIHZpYSB0aGUgbWVkaWEtZm9yZ2UgQ0xJICh0aGVcbi8vIHNhbWUgb3V0LW9mLWJhbmQgdG9vbCBpbWFnbyB1c2VzKS4gYG1lZGlhLWZvcmdlIGdlbmVyYXRlIGJnLXJlbW92ZWAgaXMgYVxuLy8gc2luZ2xlLWltYWdlIHRyYW5zZm9ybSAocHJvbXB0LWxlc3MpOiBpdCB0YWtlcyBPTkUgaW1hZ2UgYW5kIHJldHVybnMgYVxuLy8gdHJhbnNwYXJlbnQgUE5HLiBTbyBgY3JvcC5zb3VyY2VQYXRoYCBoZXJlIGlzIHRoZSBlbGVtZW50J3MgQUxSRUFEWS1DUk9QUEVEXG4vLyBpbWFnZSAodGhlIHN1cmZhY2UncyBjcm9wIHZlcnNpb24pLCBOT1QgdGhlIGZ1bGwgYm9hcmQg4oCUIHRoZSBjYWxsZXIgcGFzc2VzIGl0LlxuLy8gYG9wdHMubW9kZWxgIGlzIHRoZSBtZWRpYS1mb3JnZSBtb2RlbCBpZCAoZS5nLiBmYWwtYWkvYnJpYS9iYWNrZ3JvdW5kL3JlbW92ZSkuXG4vLyBXZSBwYXJzZSB0aGUgam9iJ3MgcHJlc2lnbmVkIG91dHB1dCBVUkwgYW5kIHN0cmVhbSBpdCB0byBvdXRQYXRoLlxuZXhwb3J0IGNvbnN0IG1lZGlhRm9yZ2VCYWNrZW5kOiBSZW1vdmFsQmFja2VuZCA9IHtcbiAgbmFtZTogXCJtZWRpYS1mb3JnZVwiLFxuICBhc3luYyBjdXQoY3JvcDogQ3JvcCwgb3V0UGF0aDogc3RyaW5nLCBvcHRzOiBDdXRPcHRpb25zID0ge30pOiBQcm9taXNlPEN1dG91dD4ge1xuICAgIGNvbnN0IG1vZGVsID0gb3B0cy5tb2RlbDtcbiAgICBpZiAoIW1vZGVsKSB0aHJvdyBuZXcgRXJyb3IoXCJtZWRpYUZvcmdlQmFja2VuZC5jdXQgcmVxdWlyZXMgb3B0cy5tb2RlbCAoYSBiZy1yZW1vdmUgbW9kZWwgaWQpXCIpO1xuICAgIGNvbnN0IGFyZ3MgPSBbXG4gICAgICBcIm1lZGlhLWZvcmdlXCIsXG4gICAgICBcImdlbmVyYXRlXCIsXG4gICAgICBcImJnLXJlbW92ZVwiLFxuICAgICAgYC0tbW9kZWw9JHttb2RlbH1gLFxuICAgICAgYC0tcmVmPSR7Y3JvcC5zb3VyY2VQYXRofWAsXG4gICAgICBcIi0tZm9ybWF0XCIsXG4gICAgICBcImpzb25cIixcbiAgICBdO1xuICAgIGNvbnN0IHByb2MgPSBCdW4uc3Bhd24oYXJncywgeyBzdGRvdXQ6IFwicGlwZVwiLCBzdGRlcnI6IFwicGlwZVwiIH0pO1xuICAgIGNvbnN0IFtzdGRvdXQsIHN0ZGVyciwgZXhpdENvZGVdID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgICAgbmV3IFJlc3BvbnNlKHByb2Muc3Rkb3V0KS50ZXh0KCksXG4gICAgICBuZXcgUmVzcG9uc2UocHJvYy5zdGRlcnIpLnRleHQoKSxcbiAgICAgIHByb2MuZXhpdGVkLFxuICAgIF0pO1xuICAgIGlmIChleGl0Q29kZSAhPT0gMCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgbWVkaWEtZm9yZ2UgYmctcmVtb3ZlIGZhaWxlZCAoZXhpdCAke2V4aXRDb2RlfSk6ICR7c3RkZXJyLnRyaW0oKSB8fCBzdGRvdXQudHJpbSgpfWAsXG4gICAgICApO1xuICAgIH1cbiAgICBsZXQgcGFyc2VkOiB7IG9rPzogYm9vbGVhbjsgZGF0YT86IHsgb3V0cHV0cz86IEFycmF5PHsgcHJlc2lnbmVkVXJsPzogc3RyaW5nIH0+IH0gfTtcbiAgICB0cnkge1xuICAgICAgcGFyc2VkID0gSlNPTi5wYXJzZShzdGRvdXQudHJpbSgpLnNwbGl0KFwiXFxuXCIpLmZpbHRlcihCb29sZWFuKS5wb3AoKSA/PyBcIlwiKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgbWVkaWEtZm9yZ2UgcHJvZHVjZWQgbm8gcGFyc2VhYmxlIEpTT04gbGluZTogJHtzdGRvdXQudHJpbSgpfWApO1xuICAgIH1cbiAgICBjb25zdCB1cmwgPSBwYXJzZWQ/LmRhdGE/Lm91dHB1dHM/LlswXT8ucHJlc2lnbmVkVXJsO1xuICAgIGlmICghdXJsKSB0aHJvdyBuZXcgRXJyb3IoYG1lZGlhLWZvcmdlIHJldHVybmVkIG5vIG91dHB1dCB1cmw6ICR7c3Rkb3V0LnRyaW0oKX1gKTtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaCh1cmwpO1xuICAgIGlmICghcmVzLm9rKSB0aHJvdyBuZXcgRXJyb3IoYG1lZGlhLWZvcmdlIG91dHB1dCBkb3dubG9hZCBmYWlsZWQgKEhUVFAgJHtyZXMuc3RhdHVzfSlgKTtcbiAgICBhd2FpdCBCdW4ud3JpdGUob3V0UGF0aCwgcmVzKTtcbiAgICByZXR1cm4geyBpZDogc2hvcnRJZChcImN1dFwiKSwgYmFja2VuZDogXCJtZWRpYS1mb3JnZVwiLCBwYXRoOiBvdXRQYXRoIH07XG4gIH0sXG59O1xuXG4vLyBJcyB0aGlzIGEgbWVkaWEtZm9yZ2UgbW9kZWwgaWQgKGEgcHJvdmlkZXIgcGF0aCBsaWtlIFwiZmFsLWFpL2JyaWEvYmFja2dyb3VuZC9cbi8vIHJlbW92ZVwiKSB2cyBhIGJhcmUgcmVtYmcgbW9kZWwgbmFtZSAoZS5nLiBcImlzbmV0LWdlbmVyYWwtdXNlXCIpPyBXZSByb3V0ZSBieVxuLy8gU0hBUEUsIG5ldmVyIGEgaGFyZGNvZGVkIG1vZGVsIGxpc3Qg4oCUIG1lZGlhLWZvcmdlJ3MgY2F0YWxvZyBkcmlmdHMsIHNvIHRoZSBhZ2VudFxuLy8gRElTQ09WRVJTIGJnLXJlbW92ZSBtb2RlbCBpZHMgdmlhIGBtZWRpYS1mb3JnZSBtb2RlbHMgbGlzdGAgKG9wZXJhdGlvbnNcbi8vIFtcImJnLXJlbW92ZVwiXSkgYW5kIHBhc3NlcyB0aGUgaWQgdGhyb3VnaC4gVGhlIG1hZ3BpZSBDTEkgYWJzdHJhY3RzIHRoZVxuLy8gb3JjaGVzdHJhdGlvbiwgbm90IHRoZSBtb2RlbCBpZGVudGl0eS5cbmV4cG9ydCBmdW5jdGlvbiBpc01lZGlhRm9yZ2VNb2RlbChtb2RlbDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBtb2RlbC5pbmNsdWRlcyhcIi9cIik7XG59XG5cbi8vIFRoZSByZWdpc3RyeSB0aGUgZGFlbW9uL3N1cmZhY2UgcGlja3MgYmFja2VuZHMgZnJvbS5cbmV4cG9ydCBjb25zdCBSRU1PVkFMX0JBQ0tFTkRTOiBSZWNvcmQ8c3RyaW5nLCBSZW1vdmFsQmFja2VuZD4gPSB7XG4gIFtyZW1iZ0JhY2tlbmQubmFtZV06IHJlbWJnQmFja2VuZCxcbiAgW21lZGlhRm9yZ2VCYWNrZW5kLm5hbWVdOiBtZWRpYUZvcmdlQmFja2VuZCxcbn07XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRCYWNrZW5kKG5hbWU6IHN0cmluZyk6IFJlbW92YWxCYWNrZW5kIHwgdW5kZWZpbmVkIHtcbiAgcmV0dXJuIFJFTU9WQUxfQkFDS0VORFNbbmFtZV07XG59XG4iLAogICAgIi8vIHNoYXJlZC9hbHBoYS50c1xuLy8gVGhlIHR5cGUtZHJpdmVuIGFscGhhIHBvbGljeSDigJQgd2hpY2ggRUxFTUVOVCBUWVBFUyBnZXQgYmFja2dyb3VuZCByZW1vdmFsLlxuLy8gQnJvd3Nlci1zYWZlIChubyBub2RlOiosIG5vIEJ1bik6IHRoZSBzdXJmYWNlIHJlYWRzIGl0IHRvIHNob3cgXCJSZW1vdmUgYmdcIiB2cyBhXG4vLyBcImtlcHQgd2hvbGVcIiBub3RlOyBzY3JpcHRzL2JhY2tlbmQudHMgKyByZW1vdmUucHkgbWlycm9yIHRoZSBzYW1lIHJ1bGUuIFRoaXMgaXNcbi8vIGFib3V0IGVsZW1lbnQgVFlQRVMgKHdoaWNoIGxpdmUgaW4gdGhlIFVJKSwgTk9UIG1vZGVscyAod2hpY2ggbmV2ZXIgZG8pLlxuaW1wb3J0IHR5cGUgeyBFbGVtZW50VHlwZSB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbmV4cG9ydCB0eXBlIEFscGhhUG9saWN5ID0gXCJhdXRvXCIgfCBcImFsbFwiIHwgXCJub25lXCI7XG5cbi8vIHJlbWJnIHJlbGlhYmx5IHByb2R1Y2VzIHVzYWJsZSBhbHBoYSBmb3IgdGhlc2UgKHVuZGVyIGBhdXRvYCkuXG5leHBvcnQgY29uc3QgQUxQSEFfQVVUT19UWVBFUzogUmVhZG9ubHlTZXQ8RWxlbWVudFR5cGU+ID0gbmV3IFNldChbXG4gIFwiaWxsdXN0cmF0aW9uXCIsXG4gIFwic3RpY2tlclwiLFxuICBcImljb25cIixcbiAgXCJ3b3JkbWFya1wiLFxuXSk7XG5cbi8vIHJlbWJnIGRlc3Ryb3lzIHRoZXNlIChmbGF0LWNvbG9yIGNvbnRlbnQpIOKAlCBuZXZlciBhbHBoYSB0aGVtLCBldmVuIHVuZGVyIGBhbGxgLlxuZXhwb3J0IGNvbnN0IEFMUEhBX0ZPUkJJRERFTl9UWVBFUzogUmVhZG9ubHlTZXQ8RWxlbWVudFR5cGU+ID0gbmV3IFNldChbXG4gIFwicGFsZXR0ZVwiLFxuICBcInNjcmVlbnNob3RcIixcbiAgXCJ0eXBvZ3JhcGh5XCIsXG5dKTtcblxuLy8gU2hvdWxkIGFuIGVsZW1lbnQgb2YgYHR5cGVgIGdldCBiYWNrZ3JvdW5kIHJlbW92YWwgdW5kZXIgYHBvbGljeWA/IE1pcnJvcnNcbi8vIHJlbW92ZS5weSdzIHNob3VsZF9yZW1vdmUgZXhhY3RseS5cbmV4cG9ydCBmdW5jdGlvbiBzaG91bGRSZW1vdmUodHlwZTogc3RyaW5nLCBwb2xpY3k6IEFscGhhUG9saWN5KTogYm9vbGVhbiB7XG4gIGlmIChwb2xpY3kgPT09IFwibm9uZVwiKSByZXR1cm4gZmFsc2U7XG4gIGlmIChwb2xpY3kgPT09IFwiYWxsXCIpIHJldHVybiAhQUxQSEFfRk9SQklEREVOX1RZUEVTLmhhcyh0eXBlIGFzIEVsZW1lbnRUeXBlKTtcbiAgcmV0dXJuIEFMUEhBX0FVVE9fVFlQRVMuaGFzKHR5cGUgYXMgRWxlbWVudFR5cGUpOyAvLyBhdXRvIChkZWZhdWx0KVxufVxuXG4vLyBTdXJmYWNlIGhlbHBlcjogaXMgdGhpcyBlbGVtZW50IHR5cGUgYSBjYW5kaWRhdGUgZm9yIHJlbW92YWwgdW5kZXIgdGhlIGRlZmF1bHRcbi8vIGBhdXRvYCBwb2xpY3k/IERyaXZlcyB0aGUgXCJSZW1vdmUgYmdcIiBhY3Rpb24gdnMgdGhlIFwia2VwdCB3aG9sZVwiIGV4cGxhaW5lci5cbmV4cG9ydCBmdW5jdGlvbiBpc0FscGhhRWxpZ2libGUodHlwZTogRWxlbWVudFR5cGUpOiBib29sZWFuIHtcbiAgcmV0dXJuIEFMUEhBX0FVVE9fVFlQRVMuaGFzKHR5cGUpO1xufVxuXG4vLyBJcyB0aGlzIHR5cGUgZXhwbGljaXRseSBrZXB0IHdob2xlIChmbGF0IGNvbG9yIHJlbWJnIHdvdWxkIGRlc3Ryb3kpP1xuZXhwb3J0IGZ1bmN0aW9uIGlzS2VwdFdob2xlKHR5cGU6IEVsZW1lbnRUeXBlKTogYm9vbGVhbiB7XG4gIHJldHVybiBBTFBIQV9GT1JCSURERU5fVFlQRVMuaGFzKHR5cGUpO1xufVxuIiwKICAgICIjIS91c3IvYmluL2VudiBidW5cbi8vIG1hZ3BpZSDigJQgZGlzY292ZXIgcGhhc2UuIFRoZSBjYW5vbmljYWwgZWxlbWVudC1kaXNjb3ZlcnkgaW1wbGVtZW50YXRpb24uXG4vL1xuLy8gQ2FsbHMgR2VtaW5pIDMuNSBGbGFzaCB2aWEgT3BlblJvdXRlciBvbiBhIG1vb2Rib2FyZCAvIGJyYW5kaW5nIGJvYXJkIGltYWdlLFxuLy8gYXNrcyB0aGUgbW9kZWwgdG8gaWRlbnRpZnkgZXZlcnkgZGlzdGluY3QgZXh0cmFjdGFibGUgdmlzdWFsIGVsZW1lbnQsIGFuZFxuLy8gcmV0dXJucyBhIG1hbmlmZXN0IChuYW1lICsgdHlwZSArIHNvdXJjZS1waXhlbCBiYm94IHBlciBlbGVtZW50LCArIGNvc3QvdG9rZW5zKS5cbi8vIEEgcGxhaW4gZnVuY3Rpb24gbW9kdWxlIHRoZSBkYWVtb24vY2xpIGNhbGw7IGEgc21hbGwgQ0xJIGVudHJ5IGxpdmVzIGF0IHRoZVxuLy8gYm90dG9tLiAoUG9ydGVkIGZyb20gYW4gZWFybGllciBQeXRob24gb3JpZ2luYWwsIHNpbmNlIHJlbW92ZWQuKVxuXG5pbXBvcnQgeyBkaXJuYW1lLCBleHRuYW1lLCBqb2luLCByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHR5cGUgeyBCYm94LCBFbGVtZW50VHlwZSB9IGZyb20gXCIuLi9zaGFyZWQvdHlwZXNcIjtcblxuZXhwb3J0IGNvbnN0IE9QRU5ST1VURVJfVVJMID0gXCJodHRwczovL29wZW5yb3V0ZXIuYWkvYXBpL3YxL2NoYXQvY29tcGxldGlvbnNcIjtcbmV4cG9ydCBjb25zdCBERUZBVUxUX01PREVMID0gXCJnb29nbGUvZ2VtaW5pLTMuNS1mbGFzaFwiO1xuXG4vLyBDb3BpZWQgdmVyYmF0aW0gZnJvbSB0aGUgUHl0aG9uIG9yaWdpbmFsJ3MgUFJPTVBUICh0aGUgZGlzY292ZXJ5IGluc3RydWN0aW9uKS5cbmV4cG9ydCBjb25zdCBQUk9NUFQgPSBgSWRlbnRpZnkgZXZlcnkgZGlzdGluY3QgZXh0cmFjdGFibGUgdmlzdWFsIGVsZW1lbnQgaW4gdGhpcyBpbWFnZS4gXCJEaXN0aW5jdCBleHRyYWN0YWJsZVwiIG1lYW5zOiBhIHNpbmdsZSB2aXN1YWxseS1jb2hlcmVudCBhc3NldCBhIGRlc2lnbmVyIHdvdWxkIHdhbnQgdG8gcHVsbCBvdXQgYXMgaXRzIG93biBmaWxlIOKAlCBhIGxvZ28sIGFuIGljb24sIGEgc3RpY2tlciwgYSBjb2xvciBzd2F0Y2ggcm93LCBhIHBpZWNlIG9mIGNvdmVyIGFydCwgYSBVSSBzY3JlZW5zaG90LiBEbyBOT1QgaW5jbHVkZSBiYWNrZ3JvdW5kLCB0ZXh0dXJlLCBvciBzdXJyb3VuZGluZyBjYW52YXMuXG5cbkZvciBlYWNoIGVsZW1lbnQsIHJldHVybiBhIGJvdW5kaW5nIGJveCB1c2luZyBHb29nbGUncyBub3JtYWxpemVkIGNvb3JkaW5hdGUgc3lzdGVtIChpbWFnZSBpcyBbMCwgMTAwMF0gb24gYm90aCBheGVzLCAwLDAgdG9wLWxlZnQpIGluIHRoZSBkb2N1bWVudGVkIG9yZGVyOiBbeV9taW4sIHhfbWluLCB5X21heCwgeF9tYXhdLlxuXG5SZXR1cm4gT05MWSBhIEpTT04gYXJyYXksIG5vIHByb3NlLCBpbiB0aGlzIGV4YWN0IHNoYXBlOlxuW1xuICB7XCJuYW1lXCI6IFwiPHNob3J0X3NuYWtlX2Nhc2VfbmFtZT5cIiwgXCJ0eXBlXCI6IFwiPG9uZSBvZjogd29yZG1hcmssIHRhZ2xpbmUsIGljb24sIGlsbHVzdHJhdGlvbiwgc3RpY2tlciwgcGFsZXR0ZSwgdHlwb2dyYXBoeSwgc2NyZWVuc2hvdCwgb3RoZXI+XCIsIFwiYm94XzJkXCI6IFt5X21pbiwgeF9taW4sIHlfbWF4LCB4X21heF19XG5dXG5cbk5hbWluZyBydWxlczpcbi0gVXNlIGRpc3RpbmN0aXZlIHNuYWtlX2Nhc2UgbmFtZXM7IGlmIHRoZXJlIGFyZSBtdWx0aXBsZSBvZiB0aGUgc2FtZSBraW5kLCBkaWZmZXJlbnRpYXRlIGRlc2NyaXB0aXZlbHkgKGljb25fbWFtbW90aCwgaWNvbl9nZWFyLCBzdGlja2VyX2NvZmZlZSwgc3RpY2tlcl9za2F0ZWJvYXJkKS5cbi0gVGhlIFxcYHR5cGVcXGAgZmllbGQgaXMgY3JpdGljYWwg4oCUIHRoZSBleHRyYWN0IHN0ZXAgdXNlcyBpdCB0byBkZWNpZGUgd2hldGhlciB0byBydW4gYmFja2dyb3VuZCByZW1vdmFsLlxuYDtcblxuLy8gT3BlblJvdXRlciB2aXNpb24gZW5kcG9pbnRzIHJlamVjdCB2ZXJ5IGxhcmdlIHBheWxvYWRzIHdpdGggYSBub24tYWN0aW9uYWJsZVxuLy8gNHh4OyBiYWlsIHdpdGggYSBjbGVhcmVyIGVycm9yIGZpcnN0IChtYXRjaGVzIHRoZSBQeXRob24gb3JpZ2luYWwpLlxuZXhwb3J0IGNvbnN0IE1BWF9JTUFHRV9CWVRFUyA9IDMwICogMTAyNCAqIDEwMjQ7XG5leHBvcnQgY29uc3QgV0FSTl9JTUFHRV9CWVRFUyA9IDE1ICogMTAyNCAqIDEwMjQ7XG5cbmNvbnN0IE1JTUVfQllfRVhUOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICBcIi5qcGdcIjogXCJpbWFnZS9qcGVnXCIsXG4gIFwiLmpwZWdcIjogXCJpbWFnZS9qcGVnXCIsXG4gIFwiLnBuZ1wiOiBcImltYWdlL3BuZ1wiLFxuICBcIi53ZWJwXCI6IFwiaW1hZ2Uvd2VicFwiLFxuICBcIi5naWZcIjogXCJpbWFnZS9naWZcIixcbn07XG5cbi8vIOKUgOKUgCBtYW5pZmVzdCBzY2hlbWEgKG1pcnJvcnMgdGhlIFB5dGhvbiBtYW5pZmVzdCkg4pSA4pSAXG5leHBvcnQgdHlwZSBNYW5pZmVzdEVsZW1lbnQgPSB7XG4gIG5hbWU6IHN0cmluZztcbiAgdHlwZTogRWxlbWVudFR5cGU7XG4gIGJveF8yZDogbnVtYmVyW107IC8vIEdlbWluaSdzIG5vcm1hbGl6ZWQgW3lfbWluLCB4X21pbiwgeV9tYXgsIHhfbWF4XSwgMC4uMTAwMFxuICBiYm94X3BpeGVsOiBCYm94OyAvLyBbeDEsIHkxLCB4MiwgeTJdIGluIHNvdXJjZSBwaXhlbHMgKHVzZWQgYnkgZXh0cmFjdClcbn07XG5leHBvcnQgdHlwZSBNYW5pZmVzdCA9IHtcbiAgc291cmNlOiBzdHJpbmc7XG4gIHNvdXJjZV9zaXplOiBbbnVtYmVyLCBudW1iZXJdO1xuICBzb3VyY2Vfc2hhMjU2XzE2OiBzdHJpbmc7XG4gIG1vZGVsOiBzdHJpbmc7XG4gIGNvc3RfdXNkOiBudW1iZXI7XG4gIHRva2VuczogeyBwcm9tcHQ6IG51bWJlcjsgY29tcGxldGlvbjogbnVtYmVyOyByZWFzb25pbmc6IG51bWJlciB9O1xuICBlbGVtZW50czogTWFuaWZlc3RFbGVtZW50W107XG59O1xuXG4vLyBSYWlzZWQgZm9yIGFjdGlvbmFibGUgdXNlci1mYWNpbmcgZmFpbHVyZXMgKGJhZCBpbWFnZSBzaXplLCBtaXNzaW5nIGtleSwgSFRUUFxuLy8gZXJyb3IpLiBUaGUgQ0xJIGVudHJ5IG1hcHMgaXQgdG8gYSBjbGVhbiBzdGRlcnIgbGluZSArIGV4aXQgY29kZS5cbmV4cG9ydCBjbGFzcyBEaXNjb3ZlckVycm9yIGV4dGVuZHMgRXJyb3Ige31cblxuLy8g4pSA4pSAIHB1cmUgaGVscGVycyAodW5pdC10ZXN0ZWQ7IG5vIG5ldHdvcmsvZGlzaykg4pSA4pSAXG5cbi8vIFN0cmlwIG9wdGlvbmFsIGBgYGpzb24gZmVuY2VzIGFuZCBwYXJzZSB0aGUgSlNPTiBhcnJheS4gTWlycm9yc1xuLy8gdGhlIFB5dGhvbiBvcmlnaW5hbCdzIHBhcnNlX2Jib3hlcy5cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUJib3hlcyhjb250ZW50OiBzdHJpbmcpOiB1bmtub3duW10ge1xuICBsZXQgcyA9IGNvbnRlbnQudHJpbSgpO1xuICBjb25zdCBmZW5jZSA9IC9gYGAoPzpqc29uKT9cXHMqKFtcXHNcXFNdKj8pXFxzKmBgYC8uZXhlYyhzKTtcbiAgaWYgKGZlbmNlKSBzID0gZmVuY2VbMV07XG4gIHJldHVybiBKU09OLnBhcnNlKHMpO1xufVxuXG4vLyBDb252ZXJ0IEdlbWluaSdzIFt5X21pbiwgeF9taW4sIHlfbWF4LCB4X21heF0gKDAuLjEwMDApIHRvIHNvdXJjZSBwaXhlbHNcbi8vIFt4MSwgeTEsIHgyLCB5Ml0sIGNsYW1wZWQgdG8gaW1hZ2UgYm91bmRzLiBSZXBsaWNhdGVzIHRoZSBQeXRob24gb3JpZ2luYWwnc1xuLy8gbm9ybWFsaXplZF90b19waXhlbCBmb3JtdWxhIGV4YWN0bHkuXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXplZFRvUGl4ZWwoYm94OiBudW1iZXJbXSwgd2lkdGg6IG51bWJlciwgaGVpZ2h0OiBudW1iZXIpOiBCYm94IHtcbiAgY29uc3QgW3kxLCB4MSwgeTIsIHgyXSA9IGJveDtcbiAgY29uc3QgcHgxID0gTWF0aC5tYXgoMCwgTWF0aC5yb3VuZCgoeDEgLyAxMDAwKSAqIHdpZHRoKSk7XG4gIGNvbnN0IHB5MSA9IE1hdGgubWF4KDAsIE1hdGgucm91bmQoKHkxIC8gMTAwMCkgKiBoZWlnaHQpKTtcbiAgY29uc3QgcHgyID0gTWF0aC5taW4od2lkdGgsIE1hdGgucm91bmQoKHgyIC8gMTAwMCkgKiB3aWR0aCkpO1xuICBjb25zdCBweTIgPSBNYXRoLm1pbihoZWlnaHQsIE1hdGgucm91bmQoKHkyIC8gMTAwMCkgKiBoZWlnaHQpKTtcbiAgcmV0dXJuIFtweDEsIHB5MSwgcHgyLCBweTJdO1xufVxuXG4vLyBCdWlsZCB0aGUgbWFuaWZlc3QgYGVsZW1lbnRzW11gIGZyb20gdGhlIG1vZGVsJ3MgcGFyc2VkIGFycmF5ICsgaW1hZ2Ugc2l6ZS5cbi8vIFNraXBzIGVudHJpZXMgbWlzc2luZyBhIG5hbWUgb3IgYm94IChtYXRjaGVzIHRoZSBQeXRob24gb3JpZ2luYWwncyBmaWx0ZXIpLlxuZXhwb3J0IGZ1bmN0aW9uIGVsZW1lbnRzRnJvbVJhdyhyYXc6IHVua25vd25bXSwgd2lkdGg6IG51bWJlciwgaGVpZ2h0OiBudW1iZXIpOiBNYW5pZmVzdEVsZW1lbnRbXSB7XG4gIGNvbnN0IGVsZW1lbnRzOiBNYW5pZmVzdEVsZW1lbnRbXSA9IFtdO1xuICBmb3IgKGNvbnN0IGVudHJ5IG9mIHJhdykge1xuICAgIGlmICghZW50cnkgfHwgdHlwZW9mIGVudHJ5ICE9PSBcIm9iamVjdFwiKSBjb250aW51ZTtcbiAgICBjb25zdCBlID0gZW50cnkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgY29uc3QgbmFtZSA9IGUubmFtZTtcbiAgICBjb25zdCBraW5kID0gKHR5cGVvZiBlLnR5cGUgPT09IFwic3RyaW5nXCIgPyBlLnR5cGUgOiBcIm90aGVyXCIpIGFzIEVsZW1lbnRUeXBlO1xuICAgIGNvbnN0IGJveCA9IGUuYm94XzJkO1xuICAgIGlmICghbmFtZSB8fCB0eXBlb2YgbmFtZSAhPT0gXCJzdHJpbmdcIiB8fCAhQXJyYXkuaXNBcnJheShib3gpKSBjb250aW51ZTtcbiAgICBlbGVtZW50cy5wdXNoKHtcbiAgICAgIG5hbWUsXG4gICAgICB0eXBlOiBraW5kLFxuICAgICAgYm94XzJkOiBib3ggYXMgbnVtYmVyW10sXG4gICAgICBiYm94X3BpeGVsOiBub3JtYWxpemVkVG9QaXhlbChib3ggYXMgbnVtYmVyW10sIHdpZHRoLCBoZWlnaHQpLFxuICAgIH0pO1xuICB9XG4gIHJldHVybiBlbGVtZW50cztcbn1cblxuLy8g4pSA4pSAIGltYWdlIHJlYWQgKyBlbmNvZGUg4pSA4pSAXG5cbmV4cG9ydCBmdW5jdGlvbiBtaW1lRm9yUGF0aChwYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gTUlNRV9CWV9FWFRbZXh0bmFtZShwYXRoKS50b0xvd2VyQ2FzZSgpXSA/PyBcImltYWdlL3BuZ1wiO1xufVxuXG4vLyBSZWFkIGFuIGltYWdlIGZpbGUg4oaSIGEgYmFzZTY0IGRhdGEgVVJMLCBlbmZvcmNpbmcgdGhlIHNpemUgZ3VhcmQuIFRocm93c1xuLy8gRGlzY292ZXJFcnJvciBhYm92ZSBNQVhfSU1BR0VfQllURVM7IHdhcm5zIChzdGRlcnIpIGFib3ZlIFdBUk5fSU1BR0VfQllURVMuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZW5jb2RlSW1hZ2VEYXRhVXJsKHBhdGg6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IGZpbGUgPSBCdW4uZmlsZShwYXRoKTtcbiAgY29uc3Qgc2l6ZSA9IGZpbGUuc2l6ZTtcbiAgaWYgKHNpemUgPiBNQVhfSU1BR0VfQllURVMpIHtcbiAgICBjb25zdCBtYiA9IChzaXplIC8gMV8wNDhfNTc2KS50b0ZpeGVkKDEpO1xuICAgIGNvbnN0IGxpbWl0ID0gTWF0aC5mbG9vcihNQVhfSU1BR0VfQllURVMgLyAxXzA0OF81NzYpO1xuICAgIHRocm93IG5ldyBEaXNjb3ZlckVycm9yKFxuICAgICAgYCR7cGF0aH0gaXMgJHttYn0gTUIsIGFib3ZlIHRoZSAke2xpbWl0fSBNQiBsaW1pdC4gUmVzaXplIGJlZm9yZSByZXRyeWluZyBgICtcbiAgICAgICAgYChlLmcuIEltYWdlTWFnaWNrOiBcXGBtYWdpY2sgaW4ucG5nIC1yZXNpemUgMjAwMHgyMDAwXFxcXD4gb3V0LnBuZ1xcYCkuYCxcbiAgICApO1xuICB9XG4gIGlmIChzaXplID4gV0FSTl9JTUFHRV9CWVRFUykge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgYFdBUk46ICR7cGF0aH0gaXMgJHsoc2l6ZSAvIDFfMDQ4XzU3NikudG9GaXhlZCgxKX0gTUI7IGxhcmdlIHJlcXVlc3RzIHNvbWV0aW1lcyBoaXQgT3BlblJvdXRlcidzIHBheWxvYWQgbGltaXRzLlxcbmAsXG4gICAgKTtcbiAgfVxuICBjb25zdCBieXRlcyA9IG5ldyBVaW50OEFycmF5KGF3YWl0IGZpbGUuYXJyYXlCdWZmZXIoKSk7XG4gIGNvbnN0IGI2NCA9IEJ1ZmZlci5mcm9tKGJ5dGVzKS50b1N0cmluZyhcImJhc2U2NFwiKTtcbiAgcmV0dXJuIGBkYXRhOiR7bWltZUZvclBhdGgocGF0aCl9O2Jhc2U2NCwke2I2NH1gO1xufVxuXG4vLyBJbWFnZSBwaXhlbCBzaXplIHZpYSBCdW4uSW1hZ2UgbWV0YWRhdGEgKHJlcGxhY2VzIHRoZSBQeXRob24gb3JpZ2luYWwncyBQaWxsb3cgcmVhZCkuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaW1hZ2VTaXplKHBhdGg6IHN0cmluZyk6IFByb21pc2U8W251bWJlciwgbnVtYmVyXT4ge1xuICBjb25zdCBieXRlcyA9IG5ldyBVaW50OEFycmF5KGF3YWl0IEJ1bi5maWxlKHBhdGgpLmFycmF5QnVmZmVyKCkpO1xuICBjb25zdCBtZXRhID0gYXdhaXQgbmV3IEJ1bi5JbWFnZShieXRlcykubWV0YWRhdGEoKTtcbiAgcmV0dXJuIFttZXRhLndpZHRoID8/IDAsIG1ldGEuaGVpZ2h0ID8/IDBdO1xufVxuXG4vLyBGaXJzdCAxNiBjaGFycyBvZiB0aGUgZmlsZSdzIHNoYTI1NiAobWF0Y2hlcyB0aGUgUHl0aG9uIG9yaWdpbmFsKS5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzb3VyY2VTaGEyNTZfMTYocGF0aDogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgY29uc3QgYnl0ZXMgPSBuZXcgVWludDhBcnJheShhd2FpdCBCdW4uZmlsZShwYXRoKS5hcnJheUJ1ZmZlcigpKTtcbiAgcmV0dXJuIG5ldyBCdW4uQ3J5cHRvSGFzaGVyKFwic2hhMjU2XCIpLnVwZGF0ZShieXRlcykuZGlnZXN0KFwiaGV4XCIpLnNsaWNlKDAsIDE2KTtcbn1cblxuLy8g4pSA4pSAIE9wZW5Sb3V0ZXIgY2FsbCDilIDilIBcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNhbGxPcGVuUm91dGVyKFxuICBhcGlLZXk6IHN0cmluZyxcbiAgbW9kZWw6IHN0cmluZyxcbiAgaW1hZ2VEYXRhVXJsOiBzdHJpbmcsXG4gIHByb21wdDogc3RyaW5nLFxuKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj4ge1xuICBjb25zdCBib2R5ID0ge1xuICAgIG1vZGVsLFxuICAgIG1lc3NhZ2VzOiBbXG4gICAgICB7XG4gICAgICAgIHJvbGU6IFwidXNlclwiLFxuICAgICAgICBjb250ZW50OiBbXG4gICAgICAgICAgeyB0eXBlOiBcInRleHRcIiwgdGV4dDogcHJvbXB0IH0sXG4gICAgICAgICAgeyB0eXBlOiBcImltYWdlX3VybFwiLCBpbWFnZV91cmw6IHsgdXJsOiBpbWFnZURhdGFVcmwgfSB9LFxuICAgICAgICBdLFxuICAgICAgfSxcbiAgICBdLFxuICAgIHRlbXBlcmF0dXJlOiAwLFxuICB9O1xuICBjb25zdCBjdHJsID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gY3RybC5hYm9ydCgpLCAxODBfMDAwKTtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChPUEVOUk9VVEVSX1VSTCwge1xuICAgICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgQXV0aG9yaXphdGlvbjogYEJlYXJlciAke2FwaUtleX1gLFxuICAgICAgICBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIixcbiAgICAgICAgXCJIVFRQLVJlZmVyZXJcIjogXCJodHRwczovL2dpdGh1Yi5jb20vaWNoYWJvZGNvbGUvc3BlbGxib29rXCIsXG4gICAgICAgIFwiWC1UaXRsZVwiOiBcIm1hZ3BpZVwiLFxuICAgICAgfSxcbiAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KGJvZHkpLFxuICAgICAgc2lnbmFsOiBjdHJsLnNpZ25hbCxcbiAgICB9KTtcbiAgICBpZiAoIXJlcy5vaykge1xuICAgICAgY29uc3QgdGV4dCA9IGF3YWl0IHJlcy50ZXh0KCkuY2F0Y2goKCkgPT4gXCJcIik7XG4gICAgICB0aHJvdyBuZXcgRGlzY292ZXJFcnJvcihgT3BlblJvdXRlciBIVFRQICR7cmVzLnN0YXR1c306ICR7dGV4dH1gKTtcbiAgICB9XG4gICAgcmV0dXJuIChhd2FpdCByZXMuanNvbigpKSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICB9XG59XG5cbi8vIOKUgOKUgCBvcmNoZXN0cmF0aW9uIOKUgOKUgFxuXG5leHBvcnQgdHlwZSBEaXNjb3Zlck9wdGlvbnMgPSB7IG1vZGVsPzogc3RyaW5nOyBhcGlLZXk/OiBzdHJpbmcgfTtcblxuLy8gRnVsbCBkaXNjb3ZlcjogcmVhZCBpbWFnZSwgY2FsbCB0aGUgbW9kZWwsIHBhcnNlLCBidWlsZCB0aGUgbWFuaWZlc3QuIFRocm93c1xuLy8gRGlzY292ZXJFcnJvciBvbiBhY3Rpb25hYmxlIGZhaWx1cmVzIChtaXNzaW5nIGtleSwgb3ZlcnNpemVkIGltYWdlLCBIVFRQIC9cbi8vIHBhcnNlIGVycm9ycykuIFRoZSBPUEVOUk9VVEVSX0FQSV9LRVkgbXVzdCBiZSBpbiB0aGUgZW52aXJvbm1lbnQg4oCUIHdlIG5ldmVyXG4vLyBpbnN0YWxsIGEga2V5LlxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGRpc2NvdmVyKGltYWdlUGF0aDogc3RyaW5nLCBvcHRzOiBEaXNjb3Zlck9wdGlvbnMgPSB7fSk6IFByb21pc2U8TWFuaWZlc3Q+IHtcbiAgY29uc3QgbW9kZWwgPSBvcHRzLm1vZGVsID8/IERFRkFVTFRfTU9ERUw7XG4gIGNvbnN0IGFwaUtleSA9IG9wdHMuYXBpS2V5ID8/IHByb2Nlc3MuZW52Lk9QRU5ST1VURVJfQVBJX0tFWTtcbiAgaWYgKCFhcGlLZXkpIHtcbiAgICB0aHJvdyBuZXcgRGlzY292ZXJFcnJvcihcIk9QRU5ST1VURVJfQVBJX0tFWSBlbnYgdmFyIG5vdCBzZXRcIik7XG4gIH1cbiAgaWYgKCEoYXdhaXQgQnVuLmZpbGUoaW1hZ2VQYXRoKS5leGlzdHMoKSkpIHtcbiAgICB0aHJvdyBuZXcgRGlzY292ZXJFcnJvcihgaW1hZ2Ugbm90IGZvdW5kOiAke2ltYWdlUGF0aH1gKTtcbiAgfVxuXG4gIGNvbnN0IFtzaXplLCBkYXRhVXJsLCBzaGFdID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgIGltYWdlU2l6ZShpbWFnZVBhdGgpLFxuICAgIGVuY29kZUltYWdlRGF0YVVybChpbWFnZVBhdGgpLFxuICAgIHNvdXJjZVNoYTI1Nl8xNihpbWFnZVBhdGgpLFxuICBdKTtcbiAgY29uc3QgW3dpZHRoLCBoZWlnaHRdID0gc2l6ZTtcblxuICBjb25zdCByZXNwID0gYXdhaXQgY2FsbE9wZW5Sb3V0ZXIoYXBpS2V5LCBtb2RlbCwgZGF0YVVybCwgUFJPTVBUKTtcblxuICBjb25zdCBjaG9pY2VzID0gcmVzcC5jaG9pY2VzIGFzIEFycmF5PHsgbWVzc2FnZT86IHsgY29udGVudD86IHVua25vd24gfSB9PiB8IHVuZGVmaW5lZDtcbiAgY29uc3QgY29udGVudCA9IGNob2ljZXM/LlswXT8ubWVzc2FnZT8uY29udGVudDtcbiAgaWYgKHR5cGVvZiBjb250ZW50ICE9PSBcInN0cmluZ1wiKSB7XG4gICAgdGhyb3cgbmV3IERpc2NvdmVyRXJyb3IoXG4gICAgICBgdW5leHBlY3RlZCByZXNwb25zZSBzaGFwZSBmcm9tIE9wZW5Sb3V0ZXIgKG5vIGNob2ljZXNbMF0ubWVzc2FnZS5jb250ZW50KTpcXG4ke0pTT04uc3RyaW5naWZ5KHJlc3ApLnNsaWNlKDAsIDIwMDApfWAsXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IHVzYWdlID0gKHJlc3AudXNhZ2UgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID8/IHt9O1xuICBjb25zdCBjb3N0ID0gdHlwZW9mIHVzYWdlLmNvc3QgPT09IFwibnVtYmVyXCIgPyB1c2FnZS5jb3N0IDogMDtcbiAgY29uc3QgcHJvbXB0VG9rZW5zID0gdHlwZW9mIHVzYWdlLnByb21wdF90b2tlbnMgPT09IFwibnVtYmVyXCIgPyB1c2FnZS5wcm9tcHRfdG9rZW5zIDogMDtcbiAgY29uc3QgY29tcGxldGlvblRva2VucyA9XG4gICAgdHlwZW9mIHVzYWdlLmNvbXBsZXRpb25fdG9rZW5zID09PSBcIm51bWJlclwiID8gdXNhZ2UuY29tcGxldGlvbl90b2tlbnMgOiAwO1xuICBjb25zdCBkZXRhaWxzID0gKHVzYWdlLmNvbXBsZXRpb25fdG9rZW5zX2RldGFpbHMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID8/IHt9O1xuICBjb25zdCByZWFzb25pbmdUb2tlbnMgPVxuICAgIHR5cGVvZiBkZXRhaWxzLnJlYXNvbmluZ190b2tlbnMgPT09IFwibnVtYmVyXCIgPyBkZXRhaWxzLnJlYXNvbmluZ190b2tlbnMgOiAwO1xuXG4gIGxldCByYXc6IHVua25vd25bXTtcbiAgdHJ5IHtcbiAgICByYXcgPSBwYXJzZUJib3hlcyhjb250ZW50KTtcbiAgfSBjYXRjaCAoZXgpIHtcbiAgICB0aHJvdyBuZXcgRGlzY292ZXJFcnJvcihcbiAgICAgIGBtb2RlbCByZXR1cm5lZCBub24tSlNPTiBvdXRwdXQ6XFxuJHtjb250ZW50fVxcblxcblBhcnNlIGVycm9yOiAke2V4IGluc3RhbmNlb2YgRXJyb3IgPyBleC5tZXNzYWdlIDogU3RyaW5nKGV4KX1gLFxuICAgICk7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIHNvdXJjZTogcmVzb2x2ZShpbWFnZVBhdGgpLFxuICAgIHNvdXJjZV9zaXplOiBbd2lkdGgsIGhlaWdodF0sXG4gICAgc291cmNlX3NoYTI1Nl8xNjogc2hhLFxuICAgIG1vZGVsLFxuICAgIGNvc3RfdXNkOiBjb3N0LFxuICAgIHRva2VuczogeyBwcm9tcHQ6IHByb21wdFRva2VucywgY29tcGxldGlvbjogY29tcGxldGlvblRva2VucywgcmVhc29uaW5nOiByZWFzb25pbmdUb2tlbnMgfSxcbiAgICBlbGVtZW50czogZWxlbWVudHNGcm9tUmF3KHJhdywgd2lkdGgsIGhlaWdodCksXG4gIH07XG59XG5cbi8vIOKUgOKUgCBDTEkgZW50cnkgKHBhcml0eSB3aXRoIHRoZSBQeXRob24gb3JpZ2luYWwpIOKUgOKUgFxuYXN5bmMgZnVuY3Rpb24gbWFpbihhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IHsgcGFyc2VBcmdzIH0gPSBhd2FpdCBpbXBvcnQoXCJub2RlOnV0aWxcIik7XG4gIGxldCBwYXJzZWQ6IFJldHVyblR5cGU8dHlwZW9mIHBhcnNlQXJncz47XG4gIHRyeSB7XG4gICAgcGFyc2VkID0gcGFyc2VBcmdzKHtcbiAgICAgIGFyZ3M6IGFyZ3YsXG4gICAgICBvcHRpb25zOiB7XG4gICAgICAgIG91dDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gICAgICAgIG1vZGVsOiB7IHR5cGU6IFwic3RyaW5nXCIsIGRlZmF1bHQ6IERFRkFVTFRfTU9ERUwgfSxcbiAgICAgIH0sXG4gICAgICBhbGxvd1Bvc2l0aW9uYWxzOiB0cnVlLFxuICAgICAgc3RyaWN0OiB0cnVlLFxuICAgIH0pO1xuICB9IGNhdGNoIChlKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYGVycm9yOiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1cXG5gKTtcbiAgICByZXR1cm4gMjtcbiAgfVxuICBjb25zdCBpbWFnZVBhdGggPSBwYXJzZWQucG9zaXRpb25hbHNbMF07XG4gIGlmICghaW1hZ2VQYXRoKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXCJ1c2FnZTogZGlzY292ZXIudHMgPGltYWdlPiBbLS1vdXQgPG1hbmlmZXN0Lmpzb24+XSBbLS1tb2RlbCA8bW9kZWw+XVxcblwiKTtcbiAgICByZXR1cm4gMjtcbiAgfVxuICB0cnkge1xuICAgIGNvbnN0IG1hbmlmZXN0ID0gYXdhaXQgZGlzY292ZXIoaW1hZ2VQYXRoLCB7IG1vZGVsOiBwYXJzZWQudmFsdWVzLm1vZGVsIGFzIHN0cmluZyB9KTtcbiAgICBjb25zdCBvdXQgPVxuICAgICAgKHBhcnNlZC52YWx1ZXMub3V0IGFzIHN0cmluZyB8IHVuZGVmaW5lZCkgPz9cbiAgICAgIGpvaW4oZGlybmFtZShyZXNvbHZlKGltYWdlUGF0aCkpLCBgJHtiYXNlU3RlbShpbWFnZVBhdGgpfS1tYW5pZmVzdC5qc29uYCk7XG4gICAgYXdhaXQgQnVuLndyaXRlKG91dCwgSlNPTi5zdHJpbmdpZnkobWFuaWZlc3QsIG51bGwsIDIpKTtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShcbiAgICAgIGBEaXNjb3ZlcmVkICR7bWFuaWZlc3QuZWxlbWVudHMubGVuZ3RofSBlbGVtZW50KHMpIOKAlCBjb3N0ICQke21hbmlmZXN0LmNvc3RfdXNkLnRvRml4ZWQoNCl9XFxuYCxcbiAgICApO1xuICAgIGZvciAoY29uc3QgZSBvZiBtYW5pZmVzdC5lbGVtZW50cykge1xuICAgICAgY29uc3QgW3gxLCB5MSwgeDIsIHkyXSA9IGUuYmJveF9waXhlbDtcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAgICR7ZS50eXBlfSAgJHtlLm5hbWV9ICBzcmM9KCR7eDF9LCR7eTF9LCR7eDJ9LCR7eTJ9KVxcbmApO1xuICAgIH1cbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgTWFuaWZlc3Qgd3JpdHRlbjogJHtvdXR9XFxuYCk7XG4gICAgcmV0dXJuIDA7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBpZiAoZSBpbnN0YW5jZW9mIERpc2NvdmVyRXJyb3IpIHtcbiAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBFUlJPUjogJHtlLm1lc3NhZ2V9XFxuYCk7XG4gICAgICByZXR1cm4gMTtcbiAgICB9XG4gICAgdGhyb3cgZTtcbiAgfVxufVxuXG5mdW5jdGlvbiBiYXNlU3RlbShwYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBiYXNlID0gcGF0aC5zcGxpdChcIi9cIikucG9wKCkgPz8gcGF0aDtcbiAgY29uc3QgZG90ID0gYmFzZS5sYXN0SW5kZXhPZihcIi5cIik7XG4gIHJldHVybiBkb3QgPiAwID8gYmFzZS5zbGljZSgwLCBkb3QpIDogYmFzZTtcbn1cblxuaWYgKGltcG9ydC5tZXRhLm1haW4pIHtcbiAgLy8gYHByb2Nlc3MuZXhpdENvZGVgICsgYSBuYXR1cmFsIHJldHVybiwgTkVWRVIgYHByb2Nlc3MuZXhpdChjb2RlKWA6IEJ1bidzXG4gIC8vIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBmaWxlKSwgc28gYW5cbiAgLy8gZXhwbGljaXQgZXhpdCBkaXNjYXJkcyB3aGF0ZXZlciBoYXMgbm90IGRyYWluZWQg4oCUIG1lYXN1cmVkIGF0IGV4YWN0bHlcbiAgLy8gNjUsNTM2IGJ5dGVzLiBUaGUgcGF5bG9hZCBpcyBjb21wbGV0ZSBhbmQgb25seSB0aGUgd3JpdGUgaXMgbG9zdCwgc28gdGhlXG4gIC8vIGNhbGxlciBnZXRzIHdlbGwtZm9ybWVkLWxvb2tpbmcgSlNPTiB0aGF0IHN0b3BzIG1pZC1zdHJpbmcuIFJlcHJvZHVjZWQsXG4gIC8vIGZpeGVkIGFuZCBnYXRlZCBpbiBib3VudHkgZmlyc3QgKFAwLCAjNzcvIzc4KTsgc2FtZSBzaGFwZSwgc2FtZSByZWFzb24uXG4gIC8vIERvIG5vdCB0aWR5IHRoaXMgYmFjayBpbnRvIGFuIGV4cGxpY2l0IGV4aXQuXG4gIHByb2Nlc3MuZXhpdENvZGUgPSBhd2FpdCBtYWluKHByb2Nlc3MuYXJndi5zbGljZSgyKSk7XG59XG4iLAogICAgIi8vIHNoYXJlZC90eXBlcy50c1xuLy8gVGhlIHNpbmdsZSBzaGFyZWQgY29udHJhY3QgZm9yIG1hZ3BpZSdzIGNvbmp1cmF0aW9uLiBJbXBvcnRlZCBieSBzZXJ2ZXIudHMsXG4vLyByZWR1Y2UudHMsIGNsaS50cywgQU5EIHRoZSBSZWFjdCBjbGllbnQuXG4vL1xuLy8gbWFncGllIChyZWJ1aWx0KSBpcyBhIFNUQU5ESU5HIFJFVklFVyBTVVJGQUNFIG92ZXIgYSBjb21wb3NpdGUgaW1hZ2U6IHRoZVxuLy8gZGFlbW9uIGhvbGRzIHRoZSBleHRyYWN0aW9uIHN0YXRlLCB0aGUgUmVhY3Qgc3VyZmFjZSBzaG93cyB0aGUgZWxlbWVudFxuLy8gYnJlYWtkb3duLCBhbmQgdGhlIHVzZXIganVkZ2VzIGVhY2ggY3V0b3V0LCBjb21wYXJlcyByZW1vdmFsLW1vZGVsIHJlc3VsdHMsXG4vLyBhbmQgc2VsZWN0aXZlbHkgcmV0cmllcy4gVGhlIGFnZW50IGRyaXZlcyBkaXNjb3ZlcnkgKyBleHRyYWN0aW9uOyB0aGUgc3VyZmFjZVxuLy8gaXMgd2hlcmUgdGhlIHVzZXIgc3RlZXJzLlxuLy9cbi8vIFBST1ZJU0lPTkFMIOKAlCB0aGlzIHN0YXRlIHNoYXBlIGlzIGEgZGVzaWduLWluZGVwZW5kZW50IHNrZWxldG9uLiBUaGVcbi8vIG1hZ3BpZS1zcGVjaWZpYyBzdXJmYWNlICsgdGhlIGZpbmFsIHNldHRsZWQgc2hhcGUgYXJlIGJlaW5nIGRlc2lnbmVkIGluXG4vLyBwYXJhbGxlbC4gRXZlcnl0aGluZyBtYXJrZWQgYC8vIFRPRE8obW9jayk6IOKApmAgaXMgYSBkZWxpYmVyYXRlIHBsYWNlaG9sZGVyIHRoZVxuLy8gbW9jayB0cmFjayB3aWxsIHJlcGxhY2U7IGtlZXAgbXV0YXRvcnMgKHJlZHVjZS50cykgdGhpbiBhcm91bmQgaXQuXG5cbi8vIFRoZSBlbGVtZW50IHR5cGUgdGF4b25vbXkgcG9ydGVkIGZyb20gdGhlIFB5dGhvbiBvcmlnaW5hbCDigJQgZHJpdmVzIHRoZSAoZnV0dXJlKVxuLy8gYmFja2dyb3VuZC1yZW1vdmFsIGRlY2lzaW9uIGluIGV4dHJhY3QuXG5leHBvcnQgdHlwZSBFbGVtZW50VHlwZSA9XG4gIHwgXCJ3b3JkbWFya1wiXG4gIHwgXCJ0YWdsaW5lXCJcbiAgfCBcImljb25cIlxuICB8IFwiaWxsdXN0cmF0aW9uXCJcbiAgfCBcInN0aWNrZXJcIlxuICB8IFwicGFsZXR0ZVwiXG4gIHwgXCJ0eXBvZ3JhcGh5XCJcbiAgfCBcInNjcmVlbnNob3RcIlxuICB8IFwib3RoZXJcIjtcblxuZXhwb3J0IGNvbnN0IEVMRU1FTlRfVFlQRVM6IHJlYWRvbmx5IEVsZW1lbnRUeXBlW10gPSBbXG4gIFwid29yZG1hcmtcIixcbiAgXCJ0YWdsaW5lXCIsXG4gIFwiaWNvblwiLFxuICBcImlsbHVzdHJhdGlvblwiLFxuICBcInN0aWNrZXJcIixcbiAgXCJwYWxldHRlXCIsXG4gIFwidHlwb2dyYXBoeVwiLFxuICBcInNjcmVlbnNob3RcIixcbiAgXCJvdGhlclwiLFxuXSBhcyBjb25zdDtcblxuLy8gVGhlIGxpbmVhciBwcm9jZXNzIHNwaW5lICh0aGUgdG9wLWJhciBzdGVwcGVyKS4gT25lIGFjdGl2ZSBwaGFzZSBhdCBhIHRpbWU7XG4vLyB0aGUgY3Vyc29yIGFkdmFuY2VzIHdoZW4gdGhlIHVzZXIgc2VhbHMgYSBwaGFzZS4gU3RhdHVzIGlzIERFUklWRUQgZnJvbSB0aGVcbi8vIGN1cnNvciDigJQgcGhhc2VzIGJlZm9yZSBpdCBhcmUgc2VhbGVkLCB0aGUgY3Vyc29yIGlzIGFjdGl2ZSwgYWZ0ZXIgaXMgdXBjb21pbmcuXG5leHBvcnQgdHlwZSBQaGFzZUtleSA9IFwiaW50YWtlXCIgfCBcInNsaWNlXCIgfCBcInJlbW92ZVwiIHwgXCJleHBvcnRcIjtcbmV4cG9ydCBjb25zdCBQSEFTRVM6IHJlYWRvbmx5IFBoYXNlS2V5W10gPSBbXCJpbnRha2VcIiwgXCJzbGljZVwiLCBcInJlbW92ZVwiLCBcImV4cG9ydFwiXSBhcyBjb25zdDtcblxuLy8gQSBwaXhlbCBib3VuZGluZyBib3ggW3gxLCB5MSwgeDIsIHkyXSBpbiBzb3VyY2UtaW1hZ2UgY29vcmRpbmF0ZXMgKG1hdGNoZXNcbi8vIHRoZSBQeXRob24gb3JpZ2luYWwncyBgYmJveF9waXhlbGApLlxuZXhwb3J0IHR5cGUgQmJveCA9IFtudW1iZXIsIG51bWJlciwgbnVtYmVyLCBudW1iZXJdO1xuXG4vLyBUaGUgYmFja2Ryb3AgdGhlIHN1cmZhY2UgcHJldmlld3MgY3V0b3V0cyBhZ2FpbnN0IChhIGNoZWNrZXIgZm9yIHRyYW5zcGFyZW50KS5cbmV4cG9ydCB0eXBlIEJhY2tkcm9wID0gXCJ3aGl0ZVwiIHwgXCJncmF5XCIgfCBcImJsYWNrXCIgfCBcInRyYW5zcGFyZW50XCI7XG5cbi8vIE9uZSBleHRyYWN0YWJsZSBlbGVtZW50LiBNSU5JTUFMIHByb3Zpc2lvbmFsIHNoYXBlIOKAlCB0aGUgcmV2aWV3L2p1ZGdtZW50XG4vLyBtYWNoaW5lcnkgaXMgbW9ja2VkIG91dCBmb3Igbm93LiBgYmJveGAgaXMgY2Fub25pY2FsIGluIFNPVVJDRSBQSVhFTFMgKHdoYXRcbi8vIGRpc2NvdmVyIHByb2R1Y2VzIGFuZCBjcm9wIGNvbnN1bWVzKTsgdGhlIGNhbnZhcyBjb252ZXJ0cyBweOKGlGZyYWN0aW9uIHZpYVxuLy8gYHNvdXJjZS5zaXplYCBmb3IgcmVuZGVyaW5nL2VkaXRpbmcuXG5leHBvcnQgdHlwZSBFbGVtZW50U3RhdHVzID0gXCJwcm9wb3NlZFwiIHwgXCJjb25maXJtZWRcIiB8IFwiZHJvcHBlZFwiO1xuXG4vLyBBIHByb2R1Y2VkIGFzc2V0IGZvciBvbmUgZWxlbWVudDogdGhlIHJhdyBjcm9wIChtb2RlbDpcImNyb3BcIikgb3IgYSByZW1vdmFsXG4vLyByZXN1bHQuIGBwYXRoYCBpcyB0aGUgb24tZGlzayBQTkcgc2VydmVkIHZpYSAvYXNzZXRzOyBgcmV2YCBidW1wcyBvbiBldmVyeVxuLy8gKHJlLSlydW4gb2YgdGhlIFNBTUUgbW9kZWwg4oCUIHRoZSBmaWxlIGlzIG92ZXJ3cml0dGVuIGluIHBsYWNlLCBzbyB0aGUgc3VyZmFjZVxuLy8gYXBwZW5kcyA/dj08cmV2PiB0byBidXN0IHRoZSBicm93c2VyIGNhY2hlLiBga2luZGAgaXMgYSBsYWJlbC1jaGlwIGhpbnQgdGhlXG4vLyBhZ2VudCBzdXBwbGllczsgbmV2ZXIgaW5mZXJyZWQgaW4gdGhlIFVJLlxuZXhwb3J0IHR5cGUgRWxlbWVudFZlcnNpb24gPSB7XG4gIGlkOiBzdHJpbmc7XG4gIG1vZGVsOiBzdHJpbmc7IC8vIFwiY3JvcFwiIHwgXCJyZW1iZ1wiIHwgXCJicmlhXCIgfCBcImlkZW9ncmFtXCIgfCDigKYgKGFnZW50LWRlZmluZWQpXG4gIGtpbmQ/OiBcInJhd1wiIHwgXCJsb2NhbFwiIHwgXCJjbG91ZFwiO1xuICBwYXRoOiBzdHJpbmc7XG4gIHJldjogbnVtYmVyO1xuICBub3RlPzogc3RyaW5nO1xufTtcblxuZXhwb3J0IHR5cGUgRWxlbWVudCA9IHtcbiAgaWQ6IHN0cmluZztcbiAgbmFtZTogc3RyaW5nO1xuICB0eXBlOiBFbGVtZW50VHlwZTtcbiAgYmJveDogQmJveDtcbiAgc3RhdHVzOiBFbGVtZW50U3RhdHVzO1xuICAvLyDilIDilIAgZXh0cmFjdGlvbiDilIDilIBcbiAgLy8gUHJvZHVjZWQgYXNzZXRzLCBvbmUgcm93IHBlciBtb2RlbC4gY3JvcCA9IHZlcnNpb25zWzBdIChtb2RlbDpcImNyb3BcIikuXG4gIC8vIEFic2VudCB1bnRpbCB0aGUgZmlyc3QgY3V0OyB0cmVhdCB1bmRlZmluZWQgYXMgW10uIFRoZSBjaG9zZW4gdmVyc2lvbiBpc1xuICAvLyB3aGF0IHRoZSByYWlsL2dhbGxlcnkgcmVuZGVyIChjaG9zZW5WZXJzaW9uKCkgZmFsbHMgYmFjayB0byB2ZXJzaW9uc1swXSkuXG4gIHZlcnNpb25zPzogRWxlbWVudFZlcnNpb25bXTtcbiAgY2hvc2VuVmVyc2lvbklkPzogc3RyaW5nO1xuICAvLyBUaGUgc29sZSByZXZpZXcgc2lnbmFsOiB0aGUgdXNlciBmbGFnZ2VkIHRoaXMgZWxlbWVudCB0byBiZSByZS1ydW4gKHJlLXNsaWNlXG4gIC8vIGluIHRoZSBzbGljZXMgcGhhc2UsIHJlLXJlbW92ZSBpbiB0aGUgYmcgcGhhc2UpLiBBcHByb3ZhbCBpcyB0aGUgQUJTRU5DRSBvZiBhXG4gIC8vIGZsYWc7IGRpc2NhcmRpbmcgaXMgc3RhdHVzOlwiZHJvcHBlZFwiLiBDbGVhcmVkIHdoZW4gYSBmcmVzaCB2ZXJzaW9uIGxhbmRzLlxuICBmbGFnZ2VkPzogYm9vbGVhbjtcbn07XG5cbi8vIOKUgOKUgCB0aGUgY29udmVyc2F0aW9uICh0aGUgc3BpbmUsIHBvcnRlZCBzZXR0bGVkIGZyb20gaW1hZ28pIOKUgOKUgFxuZXhwb3J0IHR5cGUgTWVzc2FnZUtpbmQgPVxuICB8IFwidGV4dFwiIC8vIHBsYWluIGRpYWxvZ3VlIChlaXRoZXIgcm9sZSlcbiAgfCBcImdlc3R1cmVcIiAvLyBhIHN1cmZhY2UgYWN0aW9uIHN1cmZhY2VkIGFzIGEgbWVzc2FnZSAodXNlciBqdWRnZWQvcmV0cmllZC/igKYpXG4gIHwgXCJxdWVzdGlvblwiOyAvLyBhZ2VudCBuZWVkcyB0aGUgdXNlciAoYW4gdW5hbnN3ZXJlZCBvbmUg4oaSIFwiYXNraW5nXCIgcHJlc2VuY2UpXG5cbmV4cG9ydCB0eXBlIE1lc3NhZ2UgPSB7XG4gIGlkOiBzdHJpbmc7XG4gIHJvbGU6IFwidXNlclwiIHwgXCJhZ2VudFwiO1xuICBraW5kOiBNZXNzYWdlS2luZDtcbiAgdGV4dDogc3RyaW5nO1xuICB0czogbnVtYmVyO1xuICAvLyBraW5kOiBcInF1ZXN0aW9uXCIg4oCUIG9wdGlvbmFsIHF1aWNrIHJlcGxpZXMgKHRoZSBmdWxsIGFuc3dlciBjYW4gYmUgZnJlZSB0ZXh0KVxuICBvcHRpb25zPzogc3RyaW5nW107XG4gIC8vIGtpbmQ6IFwiZ2VzdHVyZVwiIOKAlCB3aGF0IHRoZSB1c2VyIGRpZCwgYW5kIHRvIHdoYXRcbiAgZ2VzdHVyZT86IHsga2luZDogc3RyaW5nOyB0YXJnZXRJZD86IHN0cmluZyB9O1xuICAvLyBBbiBvcHRpb25hbCBvbmUtY2xpY2sgQ1RBIHRoZSBhZ2VudCBhdHRhY2hlcyB0byBhIG1lc3NhZ2Ug4oCUIGEgU0hPUlRDVVQgZm9yIGFcbiAgLy8gY29udmVyc2F0aW9uYWwgYWN0ICh0aGUgdXNlciBjb3VsZCBoYXZlIGp1c3Qgc2FpZCBpdCkuIENsaWNraW5nIGRpc3BhdGNoZXNcbiAgLy8gYGNvbW1hbmRgIChlLmcuIHsgdHlwZTogXCJwaGFzZS5hZHZhbmNlXCIgfSkuIENvbnZlcnNhdGlvbiBzdGF5cyB0aGUgcHJpbWFyeVxuICAvLyBjYXBhYmlsaXR5OyB0aGlzIGlzIHN1Z2FyIG9uIHRvcCwgc3VyZmFjZWQgYnkgdGhlIGFnZW50IGF0IGl0cyBkaXNjcmV0aW9uLlxuICBhY3Rpb24/OiB7IGxhYmVsOiBzdHJpbmc7IGNvbW1hbmQ6IENsaWVudFRvU2VydmVyIH07XG59O1xuXG4vLyBBIGJveCBiZWZvcmUgdGhlIGRhZW1vbiBhc3NpZ25zIGl0IGFuIGlkIOKAlCBkcmF3biBieSB0aGUgdXNlciAoXCJtYXJrIGEgbWlzc2VkXG4vLyByZWdpb25cIikgb3IgYnkgdGhlIGFnZW50IGJveGluZyBpbmNyZW1lbnRhbGx5LiBUaGUgZGFlbW9uIGZpbGxzIGBpZGAgYW5kXG4vLyBkZWZhdWx0cyBuYW1lL3R5cGUvc3RhdHVzIG9uIGVsZW1lbnQuYWRkLlxuZXhwb3J0IHR5cGUgTmV3RWxlbWVudCA9IHtcbiAgYmJveDogQmJveDtcbiAgbmFtZT86IHN0cmluZztcbiAgdHlwZT86IEVsZW1lbnRUeXBlO1xuICBzdGF0dXM/OiBFbGVtZW50U3RhdHVzO1xufTtcblxuLy8gVGhlIHNvdXJjZSBjb21wb3NpdGUgaW1hZ2UgdW5kZXIgcmV2aWV3LiBgcGF0aGAgaXMgdGhlIG9uLWRpc2sgZmlsZSB0aGUgYWdlbnRcbi8vIHJlYWRzOyBgc2l6ZWAgaXMgW3csIGhdIGluIHB4OyBgc2hhYCBpcyB0aGUgZmlyc3QtMTYgb2YgdGhlIHNoYTI1NiAobWF0Y2hlc1xuLy8gdGhlIFB5dGhvbiBvcmlnaW5hbCdzIGBzb3VyY2Vfc2hhMjU2XzE2YCkuXG5leHBvcnQgdHlwZSBTb3VyY2UgPSB7XG4gIHBhdGg6IHN0cmluZztcbiAgc2l6ZTogW251bWJlciwgbnVtYmVyXTtcbiAgc2hhOiBzdHJpbmc7XG59O1xuXG4vLyDilIDilIAgdGhlIHdob2xlIHN0YXRlIChQUk9WSVNJT05BTCkg4pSA4pSAXG5leHBvcnQgdHlwZSBNYWdwaWVTdGF0ZSA9IHtcbiAgdGl0bGU6IHN0cmluZztcbiAgaW50ZW50OiBzdHJpbmc7IC8vIHdoYXQgdGhlIHVzZXIgd2FudHMgb3V0IG9mIHRoaXMgYm9hcmQgKGZyZWUgdGV4dCB0aGUgYWdlbnQgc2V0cylcbiAgcGhhc2U6IFBoYXNlS2V5OyAvLyB0aGUgbGluZWFyIHByb2Nlc3MgY3Vyc29yIChJbnRha2Ug4oaSIFNsaWNlIOKGkiBSZW1vdmUg4oaSIEV4cG9ydClcbiAgc291cmNlOiBTb3VyY2UgfCBudWxsO1xuICBlbGVtZW50czogRWxlbWVudFtdO1xuICBjb252ZXJzYXRpb246IE1lc3NhZ2VbXTtcbiAgYmFja2Ryb3A6IEJhY2tkcm9wO1xuICBzdGF0dXM6IHsgYnVzeTogYm9vbGVhbjsgdGV4dDogc3RyaW5nIH07XG4gIC8vIFRoZSBidWlsdCBleHBvcnQgYnVuZGxlIChFeHBvcnQgcGhhc2UpLCBpZiBhbnkg4oCUIHNlcnZlZCB2aWEgL2Fzc2V0cy88bmFtZT4uXG4gIGJ1bmRsZT86IHsgbmFtZTogc3RyaW5nOyBjb3VudDogbnVtYmVyIH07XG4gIC8vIFRoZSBjdXJyZW50IHNlc3Npb24gaWQgKHJ1bnRpbWU7IHRoZSBkYWVtb24gc2V0cyBpdCBhdCBzdGFydCwgTk9UIHBlcnNpc3RlZC1cbiAgLy8gbWVhbmluZ2Z1bCBzaW5jZSByZXN0b3JlIG1pbnRzIGEgbmV3IG9uZSkg4oCUIHNob3duIGluIEV4cG9ydCdzIHJlb3BlbiBoaW50LlxuICBzZXNzaW9uSWQ/OiBzdHJpbmc7XG59O1xuXG5leHBvcnQgZnVuY3Rpb24gZGVmYXVsdFN0YXRlKHRpdGxlOiBzdHJpbmcpOiBNYWdwaWVTdGF0ZSB7XG4gIHJldHVybiB7XG4gICAgdGl0bGUsXG4gICAgaW50ZW50OiBcIlwiLFxuICAgIHBoYXNlOiBcImludGFrZVwiLFxuICAgIHNvdXJjZTogbnVsbCxcbiAgICBlbGVtZW50czogW10sXG4gICAgY29udmVyc2F0aW9uOiBbXSxcbiAgICBiYWNrZHJvcDogXCJ0cmFuc3BhcmVudFwiLFxuICAgIHN0YXR1czogeyBidXN5OiBmYWxzZSwgdGV4dDogXCJcIiB9LFxuICB9O1xufVxuXG4vLyDilIDilIAgU2VydmVyIOKGkiBicm93c2VyIChXZWJTb2NrZXQpLiBUaGUgYnJvd3NlciBoYW5kbGVzIGV4YWN0bHkgdGhlc2UuIOKUgOKUgFxuZXhwb3J0IHR5cGUgU2VydmVyVG9DbGllbnQgPVxuICB8IHsgdHlwZTogXCJzdGF0ZVwiOyBzdGF0ZTogTWFncGllU3RhdGUgfVxuICB8IHsgdHlwZTogXCJtZXNzYWdlXCI7IHRleHQ6IHN0cmluZyB9XG4gIC8vIGFnZW50IHByZXNlbmNlIOKAlCBpcyBhdCBsZWFzdCBvbmUgYWdlbnQgdGFpbGluZyAvZXZlbnRzICh3YXRjaGluZyB0aGUgYm9hcmQpP1xuICAvLyBwdXNoZWQgb24gY2hhbmdlICsgb24gYnJvd3NlciBjb25uZWN0OyBydW50aW1lLW9ubHksIG5ldmVyIHBlcnNpc3RlZCBpbiBzdGF0ZS5cbiAgfCB7IHR5cGU6IFwicHJlc2VuY2VcIjsgYWdlbnQ6IGJvb2xlYW4gfVxuICB8IHsgdHlwZTogXCJzdWJtaXRcIiB9XG4gIHwgeyB0eXBlOiBcImNhbmNlbFwiIH07XG5cbi8vIOKUgOKUgCBCcm93c2VyIOKGkiBzZXJ2ZXIgKFdlYlNvY2tldCkuIFRoZSBjbGllbnQgc2VuZHMgZXhhY3RseSB0aGVzZS4g4pSA4pSAXG4vLyBFYWNoIGVpdGhlciBtdXRhdGVzIHN0YXRlIChyZS1icm9hZGNhc3QpIGFuZC9vciBlbWl0cyBhbiBTU0UgZXZlbnQgdGhlIGFnZW50XG4vLyByZWFjdHMgdG8uXG5leHBvcnQgdHlwZSBDbGllbnRUb1NlcnZlciA9XG4gIHwgeyB0eXBlOiBcInNheVwiOyB0ZXh0OiBzdHJpbmcgfSAvLyB1c2VyIHBvc3RzIGEgbWVzc2FnZSAvIGluc3RydWN0aW9uXG4gIHwgeyB0eXBlOiBcInNvdXJjZS5pbXBvcnRcIjsgbmFtZTogc3RyaW5nOyBkYXRhVXJsOiBzdHJpbmcgfSAvLyB1c2VyIGRyb3BwZWQgYSBjb21wb3NpdGUg4oaSIGRhZW1vbiBtYXRlcmlhbGl6ZXMgaXRcbiAgfCB7IHR5cGU6IFwiZWxlbWVudC5hZGRcIjsgZWxlbWVudDogTmV3RWxlbWVudCB9IC8vIHVzZXIgZHJldyBhIG1pc3NlZCByZWdpb24gb24gdGhlIGNhbnZhc1xuICB8IHsgdHlwZTogXCJlbGVtZW50LnVwZGF0ZVwiOyBpZDogc3RyaW5nOyBwYXRjaDogUGFydGlhbDxFbGVtZW50PiB9IC8vIG1vdmUgLyByZXNpemUgLyByZW5hbWUgLyByZXR5cGVcbiAgfCB7IHR5cGU6IFwiZWxlbWVudC5yZW1vdmVcIjsgaWQ6IHN0cmluZyB9IC8vIGhhcmQtZGVsZXRlIGEgYm94ICh1c3VhbGx5IGEgdXNlci1kcmF3biBvbmUpXG4gIHwgeyB0eXBlOiBcImVsZW1lbnQuanVkZ2VcIjsgaWQ6IHN0cmluZzsgc3RhdHVzOiBFbGVtZW50U3RhdHVzIH0gLy8gc29mdCBjb25maXJtL2Ryb3AgYSBkaXNjb3ZlcmVkIGVsZW1lbnRcbiAgfCB7IHR5cGU6IFwiZXh0cmFjdFwiOyBpZHM/OiBzdHJpbmdbXSB9IC8vIGN1dCBzbGljZXMgZm9yIGFsbCBjb25maXJtZWQgZWxlbWVudHMsIG9yIGEgc3Vic2V0IChyZS1jdXQpXG4gIHwgeyB0eXBlOiBcImVsZW1lbnQuZmxhZ1wiOyBpZDogc3RyaW5nOyBmbGFnZ2VkOiBib29sZWFuIH0gLy8gZmxhZy91bmZsYWcgZm9yIHJlLXJ1biAocmUtc2xpY2Ugb3IgcmUtcmVtb3ZlKVxuICB8IHsgdHlwZTogXCJ2ZXJzaW9uLmNob29zZVwiOyBpZDogc3RyaW5nOyB2ZXJzaW9uSWQ6IHN0cmluZyB9IC8vIHVzZXIgcGlja2VkIGEgdmVyc2lvbiDihpIgaXQgYmVjb21lcyBjaG9zZW4gKGFtYmllbnQpXG4gIHwgeyB0eXBlOiBcInJlbW92ZUJnXCI7IGlkcz86IHN0cmluZ1tdIH0gLy8gcmVtb3ZlIGJhY2tncm91bmRzIGZvciB0aGVzZSBhbHBoYS1lbGlnaWJsZSBlbGVtZW50cyAoYWJzZW50IOKGkiBhbGwgZWxpZ2libGUpXG4gIHwgeyB0eXBlOiBcInJldHJ5UmVtb3ZhbFwiOyBpZHM6IHN0cmluZ1tdIH0gLy8gXCJ0cnkgYSBkaWZmZXJlbnQgcmVtb3ZhbFwiIOKAlCBhZ2VudCBwaWNrcyBhbiBVTlVTRUQgbW9kZWw7IHBheWxvYWQgaXMgaWRzIG9ubHlcbiAgfCB7IHR5cGU6IFwiYmFja2Ryb3Auc2V0XCI7IGJhY2tkcm9wOiBCYWNrZHJvcCB9IC8vIGFtYmllbnQgcHJldmlldyBiYWNrZHJvcFxuICB8IHsgdHlwZTogXCJwaGFzZS5hZHZhbmNlXCIgfSAvLyBzZWFsIHRoZSBhY3RpdmUgcGhhc2UsIG1vdmUgdGhlIGN1cnNvciB0byB0aGUgbmV4dCAoaW1wZXJhdGl2ZSBoYW5kLW9mZilcbiAgfCB7IHR5cGU6IFwicGhhc2Uuc2V0XCI7IHBoYXNlOiBQaGFzZUtleSB9IC8vIGJhY2stbmF2IC8ganVtcCB0byBhIHBoYXNlIChhbWJpZW50KVxuICB8IHsgdHlwZTogXCJleHBvcnRcIjsgaWRzPzogc3RyaW5nW10gfSAvLyBidWlsZCB0aGUgZG93bmxvYWRhYmxlIGFzc2V0IGJ1bmRsZSAoY2hvc2VuIHZlcnNpb25zIG9mIHRoZXNlIC8gYWxsIG5vbi1kcm9wcGVkKVxuICB8IHsgdHlwZTogXCJzdWJtaXRcIiB9XG4gIHwgeyB0eXBlOiBcImNhbmNlbFwiIH07XG5cbi8vIOKUgOKUgCBBZ2VudCDihpIgc2VydmVyIChQT1NUIC9jbWQpLiBUaGUgYWdlbnQgZHJpdmVzIHRoZSBkYWVtb24gd2l0aCBleGFjdGx5IHRoZXNlLiDilIDilIBcbmV4cG9ydCB0eXBlIEFnZW50Q29tbWFuZCA9XG4gIHwgeyB0eXBlOiBcImluaXRcIjsgdGl0bGU/OiBzdHJpbmc7IGludGVudD86IHN0cmluZyB9XG4gIHwge1xuICAgICAgdHlwZTogXCJzYXlcIjtcbiAgICAgIHRleHQ6IHN0cmluZztcbiAgICAgIGFjdGlvbj86IHsgbGFiZWw6IHN0cmluZzsgY29tbWFuZDogQ2xpZW50VG9TZXJ2ZXIgfTtcbiAgICB9IC8vIHBvc3QgYWdlbnQgZGlhbG9ndWUgKGtpbmQ6XCJ0ZXh0XCIpOyBvcHRpb25hbCBpbmxpbmUgQ1RBIHNob3J0Y3V0XG4gIHwgeyB0eXBlOiBcImFza1wiOyB0ZXh0OiBzdHJpbmc7IG9wdGlvbnM/OiBzdHJpbmdbXSB9IC8vIHBvc3QgYW4gaW4tdGhyZWFkIHF1ZXN0aW9uXG4gIHwgeyB0eXBlOiBcInNvdXJjZS5zZXRcIjsgcGF0aDogc3RyaW5nOyBzaXplOiBbbnVtYmVyLCBudW1iZXJdOyBzaGE6IHN0cmluZyB9IC8vIHRoZSBjb21wb3NpdGUgdW5kZXIgcmV2aWV3XG4gIHwgeyB0eXBlOiBcImVsZW1lbnRzLnNldFwiOyBlbGVtZW50czogRWxlbWVudFtdIH0gLy8gcG9zdCB0aGUgZGlzY292ZXJlZCBicmVha2Rvd25cbiAgfCB7IHR5cGU6IFwiZWxlbWVudC5hZGRcIjsgZWxlbWVudDogTmV3RWxlbWVudCB9IC8vIGFnZW50IGJveGVzIGEgcmVnaW9uIGluY3JlbWVudGFsbHlcbiAgfCB7IHR5cGU6IFwiZWxlbWVudC51cGRhdGVcIjsgaWQ6IHN0cmluZzsgcGF0Y2g6IFBhcnRpYWw8RWxlbWVudD4gfSAvLyBtb3ZlL3Jlc2l6ZS9yZW5hbWUvcmV0eXBlICh2ZXJzaW9ucyBhcHBlbmQgdmlhIGVsZW1lbnQuYWRkVmVyc2lvbilcbiAgfCB7IHR5cGU6IFwiZWxlbWVudC5yZW1vdmVcIjsgaWQ6IHN0cmluZyB9IC8vIGFnZW50IHJldHJhY3RzIGEgYm94XG4gIHwgeyB0eXBlOiBcImVsZW1lbnQuYWRkVmVyc2lvblwiOyBpZDogc3RyaW5nOyB2ZXJzaW9uOiBFbGVtZW50VmVyc2lvbjsgY2hvb3NlPzogYm9vbGVhbiB9IC8vIGFnZW50IGFwcGVuZHMgYSBwcm9kdWNlZCB2ZXJzaW9uXG4gIHwgeyB0eXBlOiBcInBoYXNlLnNldFwiOyBwaGFzZTogUGhhc2VLZXkgfSAvLyBhZ2VudCBhZHZhbmNlcy9tb3ZlcyB0aGUgY3Vyc29yIG9uIHRoZSB1c2VyJ3MgY29udmVyc2F0aW9uYWwgcmVxdWVzdFxuICB8IHsgdHlwZTogXCJidW5kbGUuc2V0XCI7IG5hbWU6IHN0cmluZzsgY291bnQ6IG51bWJlciB9IC8vIGFnZW50IHBvc3RzIHRoZSBidWlsdCBleHBvcnQgYnVuZGxlIChzZXJ2ZWQgdmlhIC9hc3NldHMvPG5hbWU+KVxuICB8IHsgdHlwZTogXCJzdGF0dXNcIjsgYnVzeTogYm9vbGVhbjsgdGV4dD86IHN0cmluZyB9XG4gIHwgeyB0eXBlOiBcImNsb3NlXCIgfTtcblxuLy8gVGhlIGFnZW50IGV2ZW50IHNldCAoc2VydmVyIOKGkiBhZ2VudCBTU0UpIOKAlCBJTVBFUkFUSVZFUyBPTkxZOiB0aGUgbW92ZXMgd2hlcmVcbi8vIHRoZSB1c2VyICpoYW5kcyB3b3JrIHRvIHRoZSBhZ2VudCosIHBsdXMgbGlmZWN5Y2xlLiBBbWJpZW50IGVkaXRpbmcgb2YgdGhlXG4vLyBicmVha2Rvd24gaXMgZGVsaWJlcmF0ZWx5IE5PVCBoZXJlIOKAlCBib3ggbW92ZS9yZXNpemUvcmVuYW1lL3JldHlwZVxuLy8gKGVsZW1lbnQudXBkYXRlKSwgZHJhdyAoZWxlbWVudC5hZGQpLCBkZWxldGUgKGVsZW1lbnQucmVtb3ZlKSwgY29uZmlybS9kcm9wXG4vLyAoZWxlbWVudC5qdWRnZSksIHJlLXJ1biBmbGFnIChlbGVtZW50LmZsYWcpLCB2ZXJzaW9uIHBpY2sgKHZlcnNpb24uY2hvb3NlKSwgYW5kXG4vLyBiYWNrZHJvcCBhcmUgYWxsIHJlYWNoYWJsZSBmcm9tIC9zdGF0ZSwgd2hpY2ggdGhlIGFnZW50IHJlYWRzIGF0IHRoZSBtb21lbnQgYW5cbi8vIGltcGVyYXRpdmUgZmlyZXMuIFB1c2hpbmcgZWFjaCBlZGl0IHdvdWxkIGp1c3QgbmFycmF0ZSB0aGUgdXNlcidzIGJ1c3kgd29yay5cbi8vIFRoZSBpbXBlcmF0aXZlczogYHNheWAsIGBzb3VyY2UuYWRkZWRgICjihpIgZGlzY292ZXIpLCBgZXh0cmFjdGAgKOKGkiBjdXQgdGhlXG4vLyBjdXJyZW50IGJveGVzKSwgYHJlbW92ZUJnYCAo4oaSIHJlbW92ZSBiYWNrZ3JvdW5kcywgYWdlbnQgcGlja3MgdGhlIG1vZGVsKSxcbi8vIGByZXRyeVJlbW92YWxgICjihpIgdHJ5IGEgZGlmZmVyZW50IHJlbW92YWwsIGFnZW50IHBpY2tzIGFuIHVudXNlZCBtb2RlbCksXG4vLyBgcGhhc2UuYWR2YW5jZWAgKOKGkiB1c2VyIHNlYWxlZCBhIHBoYXNlOyBhIGhhbmQtb2ZmIHRvIHRoZSBuZXh0IGxlZyksXG4vLyBgcGhhc2Uuc2V0YCAo4oaSIHVzZXIgc3RlcHBlZCBCQUNLIHRvIGEgcGhhc2Ug4oCUIG5vdCBhbiBhY3Rpb24gdG8gdGFrZSwgYnV0XG4vLyBjb250ZXh0IGZvciB3aGF0J3MgY29taW5nLCBlLmcuIHJlLWN1dHMpLCBgc3VibWl0YCwgKyBsaWZlY3ljbGUuIEEgcGhhc2Ugc3dpdGNoXG4vLyBpcyBhIGRlbGliZXJhdGUgcmVsb2NhdGlvbiwgTk9UIGFtYmllbnQgZWRpdGluZyDigJQgc28gYm90aCBkaXJlY3Rpb25zIGFyZSBwdXNoZWQuXG5leHBvcnQgY29uc3QgQUdFTlRfRVZFTlRfVFlQRVMgPSBPYmplY3QuZnJlZXplKFtcbiAgXCJyZWFkeVwiLFxuICBcImNvbm5lY3RlZFwiLFxuICBcImRpc2Nvbm5lY3RlZFwiLFxuICBcInNheVwiLFxuICBcInNvdXJjZS5hZGRlZFwiLCAvLyB1c2VyIGRyb3BwZWQgYSBjb21wb3NpdGUg4oCUIHRoZSBhZ2VudCBydW5zIGRpc2NvdmVyIG9uIGl0XG4gIFwiZXh0cmFjdFwiLCAvLyB1c2VyIGFza2VkIHRvIChyZS0pY3V0IOKAlCB0aGUgYWdlbnQgcmVhZHMgdGhlIGJveGVzIGZyb20gL3N0YXRlXG4gIFwicmVtb3ZlQmdcIiwgLy8gdXNlciBhc2tlZCB0byByZW1vdmUgYmFja2dyb3VuZHMg4oCUIHRoZSBhZ2VudCBwaWNrcyB0aGUgbW9kZWxcbiAgXCJyZXRyeVJlbW92YWxcIiwgLy8gdXNlciBhc2tlZCB0byB0cnkgYSBkaWZmZXJlbnQgcmVtb3ZhbCDigJQgdGhlIGFnZW50IHBpY2tzIGFuIFVOVVNFRCBtb2RlbFxuICBcInBoYXNlLmFkdmFuY2VcIiwgLy8gdXNlciBzZWFsZWQgdGhlIGFjdGl2ZSBwaGFzZSDigJQgYSBoYW5kLW9mZiB0byB0aGUgbmV4dCBsZWcgb2Ygd29ya1xuICBcInBoYXNlLnNldFwiLCAvLyB1c2VyIHN0ZXBwZWQgQkFDSyB0byBhIHBoYXNlIOKAlCBjb250ZXh0IChyZS1jdXRzIGxpa2VseSksIG5vIGFjdGlvbiByZXF1aXJlZFxuICBcImV4cG9ydFwiLCAvLyB1c2VyIGFza2VkIHRvIGJ1aWxkIHRoZSBkb3dubG9hZGFibGUgYXNzZXQgYnVuZGxlIOKAlCB0aGUgYWdlbnQgemlwcyBpdFxuICBcInN1Ym1pdFwiLFxuICBcImNsb3NlZFwiLFxuXSBhcyBjb25zdCk7XG5leHBvcnQgdHlwZSBBZ2VudEV2ZW50VHlwZSA9ICh0eXBlb2YgQUdFTlRfRVZFTlRfVFlQRVMpW251bWJlcl07XG5cbi8vIFR5cGVkIHBheWxvYWRzIGZvciB0aGUgZXZlbnRzIHRoYXQgY2FycnkgZGF0YS5cbmV4cG9ydCB0eXBlIEFnZW50RXZlbnRQYXlsb2FkID0ge1xuICBzYXk6IHsgdGV4dDogc3RyaW5nIH07XG4gIFwic291cmNlLmFkZGVkXCI6IHsgcGF0aDogc3RyaW5nOyBzaXplOiBbbnVtYmVyLCBudW1iZXJdOyBzaGE6IHN0cmluZyB9O1xuICBleHRyYWN0OiB7IGlkcz86IHN0cmluZ1tdIH07IC8vIHdoaWNoIGVsZW1lbnRzIHRvIChyZS0pY3V0OyBhYnNlbnQg4oaSIGFsbCBjb25maXJtZWRcbiAgcmVtb3ZlQmc6IHsgaWRzPzogc3RyaW5nW10gfTsgLy8gd2hpY2ggZWxlbWVudHMgdG8gcmVtb3ZlIGJnIGZvcjsgYWJzZW50IOKGkiBhbGwgZWxpZ2libGVcbiAgcmV0cnlSZW1vdmFsOiB7IGlkczogc3RyaW5nW10gfTsgLy8gd2hpY2ggKGZsYWdnZWQpIGVsZW1lbnRzIHRvIHJlLXJlbW92ZTsgbW9kZWwgaXMgdGhlIGFnZW50J3MgY2FsbFxuICBcInBoYXNlLmFkdmFuY2VcIjogeyBwaGFzZTogUGhhc2VLZXkgfTsgLy8gdGhlIE5FVyBwaGFzZSB0aGUgdXNlciBhZHZhbmNlZCB0b1xuICBcInBoYXNlLnNldFwiOiB7IHBoYXNlOiBQaGFzZUtleSB9OyAvLyB0aGUgcGhhc2UgdGhlIHVzZXIgc3RlcHBlZCBiYWNrIHRvXG4gIGV4cG9ydDogeyBpZHM/OiBzdHJpbmdbXSB9OyAvLyB3aGljaCBlbGVtZW50cyB0byBidW5kbGUgKGFic2VudCDihpIgYWxsIG5vbi1kcm9wcGVkKVxufTtcbiIsCiAgICAiLy8gc2NyaXB0cy9yZWR1Y2UudHNcbi8vIFB1cmUsIGluLXBsYWNlIG11dGF0b3JzIG92ZXIgTWFncGllU3RhdGUgKyB0aGUgbGVhbiBwcm9qZWN0aW9uLiBUaGUgZGFlbW9uXG4vLyAoc2VydmVyLnRzKSBvcmNoZXN0cmF0ZXMgdGhlc2UgKGl0IG93bnMgaWRzLCBicm9hZGNhc3QsIFNTRSk7IHRoZXNlIGZ1bmN0aW9uc1xuLy8ganVzdCBtdXRhdGUgY2Fub25pY2FsIHN0YXRlIGFuZCByZXBvcnQgd2hldGhlciBhbnl0aGluZyBjaGFuZ2VkLCBzbyB0aGV5J3JlXG4vLyB1bml0LXRlc3RhYmxlIHdpdGggbm8gc3VicHJvY2Vzcy4gS2VlcCB0aGVtIFRISU4g4oCUIHRoZSBtYWdwaWUtc3BlY2lmaWMgcmV2aWV3XG4vLyBtYWNoaW5lcnkgKGp1ZGdtZW50LCBjdXRvdXRzKSBpcyBtb2NrZWQgb3V0IGZvciBub3c7IHdpZGVuIHRoZXNlIGFzIGl0IGxhbmRzLlxuXG5pbXBvcnQge1xuICB0eXBlIEJhY2tkcm9wLFxuICB0eXBlIEVsZW1lbnQsXG4gIHR5cGUgRWxlbWVudFN0YXR1cyxcbiAgdHlwZSBFbGVtZW50VmVyc2lvbixcbiAgdHlwZSBNYWdwaWVTdGF0ZSxcbiAgdHlwZSBNZXNzYWdlLFxuICB0eXBlIE5ld0VsZW1lbnQsXG4gIFBIQVNFUyxcbiAgdHlwZSBQaGFzZUtleSxcbiAgdHlwZSBTb3VyY2UsXG59IGZyb20gXCIuLi9zaGFyZWQvdHlwZXNcIjtcblxuLy8g4pSA4pSAIGlkIGhlbHBlcnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5mdW5jdGlvbiByYW5kSGV4KGJ5dGVzOiBudW1iZXIpOiBzdHJpbmcge1xuICBjb25zdCBidWYgPSBuZXcgVWludDhBcnJheShieXRlcyk7XG4gIGNyeXB0by5nZXRSYW5kb21WYWx1ZXMoYnVmKTtcbiAgcmV0dXJuIEFycmF5LmZyb20oYnVmLCAoYikgPT4gYi50b1N0cmluZygxNikucGFkU3RhcnQoMiwgXCIwXCIpKS5qb2luKFwiXCIpO1xufVxuZXhwb3J0IGZ1bmN0aW9uIG5ld0lkKHByZWZpeDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke3ByZWZpeH0tJHtyYW5kSGV4KDQpfWA7XG59XG5cbi8vIOKUgOKUgCBtdXRhdG9ycyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuZXhwb3J0IGZ1bmN0aW9uIHB1c2hNZXNzYWdlKFxuICBzOiBNYWdwaWVTdGF0ZSxcbiAgbTogT21pdDxNZXNzYWdlLCBcImlkXCIgfCBcInRzXCI+ICYgeyBpZD86IHN0cmluZyB9LFxuKTogTWVzc2FnZSB7XG4gIGNvbnN0IG1zZzogTWVzc2FnZSA9IHsgaWQ6IG0uaWQgPz8gbmV3SWQoXCJtXCIpLCB0czogRGF0ZS5ub3coKSwgLi4ubSB9IGFzIE1lc3NhZ2U7XG4gIHMuY29udmVyc2F0aW9uLnB1c2gobXNnKTtcbiAgcmV0dXJuIG1zZztcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNldFN0YXR1cyhzOiBNYWdwaWVTdGF0ZSwgYnVzeTogYm9vbGVhbiwgdGV4dCA9IFwiXCIpOiB2b2lkIHtcbiAgcy5zdGF0dXMgPSB7IGJ1c3ksIHRleHQgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNldEludGVudChzOiBNYWdwaWVTdGF0ZSwgaW50ZW50OiBzdHJpbmcpOiB2b2lkIHtcbiAgcy5pbnRlbnQgPSBpbnRlbnQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRTb3VyY2UoczogTWFncGllU3RhdGUsIHNvdXJjZTogU291cmNlKTogdm9pZCB7XG4gIHMuc291cmNlID0gc291cmNlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2V0RWxlbWVudHMoczogTWFncGllU3RhdGUsIGVsZW1lbnRzOiBFbGVtZW50W10pOiB2b2lkIHtcbiAgLy8gVHJ1c3QgdGhlIGFnZW50J3MgZGlzY292ZXJlZCBicmVha2Rvd24gd2hvbGVzYWxlOyBkZWZhdWx0IGFueSBtaXNzaW5nXG4gIC8vIHN0YXR1cyB0byBcInByb3Bvc2VkXCIgc28gdGhlIHN1cmZhY2UgYWx3YXlzIGhhcyBhIGp1ZGdlYWJsZSBlbGVtZW50LCBhbmRcbiAgLy8gKGRlZmVuc2l2ZWx5KSBtaW50IGFuIGlkIGZvciBhbnkgZWxlbWVudCBwb3N0ZWQgd2l0aG91dCBvbmUg4oCUIGRpc2NvdmVyXG4gIC8vIGFzc2lnbnMgaWRzLCBidXQgYSBoYW5kLXJvbGxlZCBgZWxlbWVudHMuc2V0YCBib2R5IG1pZ2h0IG5vdC5cbiAgcy5lbGVtZW50cyA9IGVsZW1lbnRzLm1hcCgoZSkgPT4gKHtcbiAgICAuLi5lLFxuICAgIGlkOiBlLmlkIHx8IG5ld0lkKFwiZVwiKSxcbiAgICBzdGF0dXM6IGUuc3RhdHVzID8/IFwicHJvcG9zZWRcIixcbiAgfSkpO1xufVxuXG4vLyBEZWZhdWx0IG5hbWUgZm9yIGFuIHVubmFtZWQgZHJhd24gcmVnaW9uOiByZWdpb25fPG4+LCB3aGVyZSBuIGlzIG9uZSBwYXN0IHRoZVxuLy8gY291bnQgb2YgZXhpc3RpbmcgcmVnaW9uX1xcZCsgbmFtZXMgKHNvIGEgZGVsZXRlLXRoZW4tZHJhdyBkb2Vzbid0IGNvbGxpZGUgd2l0aFxuLy8gYSBsaXZlIG9uZSDigJQgaXQgbnVtYmVycyBvZmYgdGhlIGN1cnJlbnQgcG9wdWxhdGlvbiwgdGhlIGNoZWFwIGhvdXNlIGhldXJpc3RpYykuXG5jb25zdCBSRUdJT05fUkUgPSAvXnJlZ2lvbl9cXGQrJC87XG5mdW5jdGlvbiBuZXh0UmVnaW9uTmFtZShzOiBNYWdwaWVTdGF0ZSk6IHN0cmluZyB7XG4gIGNvbnN0IG4gPSBzLmVsZW1lbnRzLmZpbHRlcigoZSkgPT4gUkVHSU9OX1JFLnRlc3QoZS5uYW1lKSkubGVuZ3RoICsgMTtcbiAgcmV0dXJuIGByZWdpb25fJHtufWA7XG59XG5cbi8vIEFkZCBhIHVzZXItZHJhd24gKG9yIGFnZW50LWJveGVkKSByZWdpb246IG1pbnQgYW4gaWQsIGRlZmF1bHQgbmFtZS90eXBlL3N0YXR1cy5cbi8vIFJldHVybnMgdGhlIG1hdGVyaWFsaXplZCBFbGVtZW50ICh0aGUgZGFlbW9uIGVtaXRzIGl0IG9uIHRoZSBTU0UvYnJvYWRjYXN0KS5cbmV4cG9ydCBmdW5jdGlvbiBhZGRFbGVtZW50KHM6IE1hZ3BpZVN0YXRlLCBkcmFmdDogTmV3RWxlbWVudCk6IEVsZW1lbnQge1xuICBjb25zdCBlbDogRWxlbWVudCA9IHtcbiAgICBpZDogbmV3SWQoXCJlXCIpLFxuICAgIG5hbWU6IGRyYWZ0Lm5hbWUgfHwgbmV4dFJlZ2lvbk5hbWUocyksXG4gICAgdHlwZTogZHJhZnQudHlwZSA/PyBcIm90aGVyXCIsXG4gICAgYmJveDogZHJhZnQuYmJveCxcbiAgICBzdGF0dXM6IGRyYWZ0LnN0YXR1cyA/PyBcImNvbmZpcm1lZFwiLFxuICB9O1xuICBzLmVsZW1lbnRzLnB1c2goZWwpO1xuICByZXR1cm4gZWw7XG59XG5cbi8vIEhhcmQtZGVsZXRlIGFuIGVsZW1lbnQgYnkgaWQgKGEgdXNlciByZXRyYWN0aW5nIGEgZHJhd24gYm94KS4gUmV0dXJucyB3aGV0aGVyXG4vLyBpdCBleGlzdGVkLlxuZXhwb3J0IGZ1bmN0aW9uIHJlbW92ZUVsZW1lbnQoczogTWFncGllU3RhdGUsIGlkOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgaSA9IHMuZWxlbWVudHMuZmluZEluZGV4KChlKSA9PiBlLmlkID09PSBpZCk7XG4gIGlmIChpIDwgMCkgcmV0dXJuIGZhbHNlO1xuICBzLmVsZW1lbnRzLnNwbGljZShpLCAxKTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbi8vIFBhcnRpYWwtbWVyZ2UgYW4gZWxlbWVudCAodGhlIGFnZW50IHBvc3RpbmcgbmFtZS90eXBlL2Jib3gvc3RhdHVzIGVkaXRzIGxhbmRzXG4vLyBoZXJlKS4gTmV2ZXIgbGV0cyBgaWRgIGJlIG92ZXJ3cml0dGVuLiBSZXR1cm5zIHRydWUgaWYgdGhlIGVsZW1lbnQgZXhpc3RlZC5cbi8vIFZlcnNpb24gcmVzdWx0cyBkbyBOT1QgZmxvdyB0aHJvdWdoIGhlcmUg4oCUIHRoZXkgYXBwZW5kIHZpYSBhZGRWZXJzaW9uIChhIGxpc3Rcbi8vIG9wLCBub3QgYSBmaWVsZCBtZXJnZSkuXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlRWxlbWVudChzOiBNYWdwaWVTdGF0ZSwgaWQ6IHN0cmluZywgcGF0Y2g6IFBhcnRpYWw8RWxlbWVudD4pOiBib29sZWFuIHtcbiAgY29uc3QgZWwgPSBzLmVsZW1lbnRzLmZpbmQoKGUpID0+IGUuaWQgPT09IGlkKTtcbiAgaWYgKCFlbCkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCB7IGlkOiBfZHJvcCwgLi4ucmVzdCB9ID0gcGF0Y2g7XG4gIE9iamVjdC5hc3NpZ24oZWwsIHJlc3QpO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuY29uc3QgRUxFTUVOVF9TVEFUVVNFUzogcmVhZG9ubHkgRWxlbWVudFN0YXR1c1tdID0gW1wicHJvcG9zZWRcIiwgXCJjb25maXJtZWRcIiwgXCJkcm9wcGVkXCJdO1xuXG5leHBvcnQgZnVuY3Rpb24ganVkZ2VFbGVtZW50KHM6IE1hZ3BpZVN0YXRlLCBpZDogc3RyaW5nLCBzdGF0dXM6IEVsZW1lbnRTdGF0dXMpOiBib29sZWFuIHtcbiAgaWYgKCFFTEVNRU5UX1NUQVRVU0VTLmluY2x1ZGVzKHN0YXR1cykpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgZWwgPSBzLmVsZW1lbnRzLmZpbmQoKGUpID0+IGUuaWQgPT09IGlkKTtcbiAgaWYgKCFlbCB8fCBlbC5zdGF0dXMgPT09IHN0YXR1cykgcmV0dXJuIGZhbHNlO1xuICBlbC5zdGF0dXMgPSBzdGF0dXM7XG4gIHJldHVybiB0cnVlO1xufVxuXG4vLyBGbGFnIChvciB1bmZsYWcpIGFuIGVsZW1lbnQgZm9yIGEgcmUtcnVuIOKAlCB0aGUgc29sZSByZXZpZXcgc2lnbmFsLiBBcHByb3ZhbCBpc1xuLy8gdGhlIGFic2VuY2Ugb2YgYSBmbGFnOyBkaXNjYXJkaW5nIGlzIHN0YXR1czpcImRyb3BwZWRcIi4gUmV0dXJucyB3aGV0aGVyIHRoZSBmbGFnXG4vLyBhY3R1YWxseSBjaGFuZ2VkICh0aGUgZGFlbW9uIG9ubHkgYnJvYWRjYXN0cyBvbiBhIGNoYW5nZSkuXG5leHBvcnQgZnVuY3Rpb24gZmxhZ0VsZW1lbnQoczogTWFncGllU3RhdGUsIGlkOiBzdHJpbmcsIGZsYWdnZWQ6IGJvb2xlYW4pOiBib29sZWFuIHtcbiAgY29uc3QgZWwgPSBzLmVsZW1lbnRzLmZpbmQoKGUpID0+IGUuaWQgPT09IGlkKTtcbiAgaWYgKCFlbCkgcmV0dXJuIGZhbHNlO1xuICBpZiAoKGVsLmZsYWdnZWQgPz8gZmFsc2UpID09PSBmbGFnZ2VkKSByZXR1cm4gZmFsc2U7XG4gIGVsLmZsYWdnZWQgPSBmbGFnZ2VkO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuLy8gQXBwZW5kIGEgcHJvZHVjZWQgdmVyc2lvbiwgVVBTRVJUSU5HIGJ5IG1vZGVsOiByZS1ydW5uaW5nIHRoZSBzYW1lIG1vZGVsXG4vLyBvdmVyd3JpdGVzIGl0cyBwYXRoICsgYnVtcHMgcmV2IChjYWNoZS1idXN0KSBhbmQga2VlcHMgdGhlIHN0YWJsZSBpZDsgYSBuZXdcbi8vIG1vZGVsIGFwcGVuZHMgYSByb3cuIEEgZnJlc2ggcmVzdWx0IGNsZWFycyBgZmxhZ2dlZGAgKHRoZSByZXF1ZXN0IGlzIGZ1bGZpbGxlZClcbi8vIGFuZCDigJQgdW5sZXNzIHsgY2hvb3NlOmZhbHNlIH0g4oCUIGJlY29tZXMgdGhlIGNob3NlbiB2ZXJzaW9uLiBSZXR1cm5zIHRoZSBzdG9yZWRcbi8vIHZlcnNpb24sIG9yIG51bGwgaWYgdGhlIGVsZW1lbnQgaXMgZ29uZS5cbmV4cG9ydCBmdW5jdGlvbiBhZGRWZXJzaW9uKFxuICBzOiBNYWdwaWVTdGF0ZSxcbiAgaWQ6IHN0cmluZyxcbiAgdjogRWxlbWVudFZlcnNpb24sXG4gIG9wdHM6IHsgY2hvb3NlPzogYm9vbGVhbiB9ID0ge30sXG4pOiBFbGVtZW50VmVyc2lvbiB8IG51bGwge1xuICBjb25zdCBlbCA9IHMuZWxlbWVudHMuZmluZCgoZSkgPT4gZS5pZCA9PT0gaWQpO1xuICBpZiAoIWVsKSByZXR1cm4gbnVsbDtcbiAgaWYgKCFlbC52ZXJzaW9ucykgZWwudmVyc2lvbnMgPSBbXTtcbiAgY29uc3QgZXhpc3RpbmcgPSBlbC52ZXJzaW9ucy5maW5kKCh4KSA9PiB4Lm1vZGVsID09PSB2Lm1vZGVsKTtcbiAgbGV0IHN0b3JlZDogRWxlbWVudFZlcnNpb247XG4gIGlmIChleGlzdGluZykge1xuICAgIGV4aXN0aW5nLnBhdGggPSB2LnBhdGg7XG4gICAgZXhpc3RpbmcucmV2ID0gKGV4aXN0aW5nLnJldiA/PyAwKSArIDE7XG4gICAgaWYgKHYua2luZCAhPT0gdW5kZWZpbmVkKSBleGlzdGluZy5raW5kID0gdi5raW5kO1xuICAgIGlmICh2Lm5vdGUgIT09IHVuZGVmaW5lZCkgZXhpc3Rpbmcubm90ZSA9IHYubm90ZTtcbiAgICBzdG9yZWQgPSBleGlzdGluZztcbiAgfSBlbHNlIHtcbiAgICBzdG9yZWQgPSB7IC4uLnYsIHJldjogdi5yZXYgPz8gMCB9O1xuICAgIGVsLnZlcnNpb25zLnB1c2goc3RvcmVkKTtcbiAgfVxuICBpZiAob3B0cy5jaG9vc2UgPz8gdHJ1ZSkgZWwuY2hvc2VuVmVyc2lvbklkID0gc3RvcmVkLmlkO1xuICBlbC5mbGFnZ2VkID0gZmFsc2U7XG4gIHJldHVybiBzdG9yZWQ7XG59XG5cbi8vIFRoZSB1c2VyIHNlbGVjdGluZyBhIHZlcnNpb24g4oaSIGl0IGJlY29tZXMgY2hvc2VuIChhbWJpZW50KS4gUmV0dXJucyB3aGV0aGVyIGl0XG4vLyBjaGFuZ2VkOyByZWplY3RzIGFuIHVua25vd24gZWxlbWVudCBvciBhIHZlcnNpb25JZCBub3QgcHJlc2VudCBvbiBpdC5cbmV4cG9ydCBmdW5jdGlvbiBjaG9vc2VWZXJzaW9uKHM6IE1hZ3BpZVN0YXRlLCBpZDogc3RyaW5nLCB2ZXJzaW9uSWQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBlbCA9IHMuZWxlbWVudHMuZmluZCgoZSkgPT4gZS5pZCA9PT0gaWQpO1xuICBpZiAoIWVsIHx8ICEoZWwudmVyc2lvbnMgPz8gW10pLnNvbWUoKHYpID0+IHYuaWQgPT09IHZlcnNpb25JZCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKGVsLmNob3NlblZlcnNpb25JZCA9PT0gdmVyc2lvbklkKSByZXR1cm4gZmFsc2U7XG4gIGVsLmNob3NlblZlcnNpb25JZCA9IHZlcnNpb25JZDtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmNvbnN0IEJBQ0tEUk9QUzogcmVhZG9ubHkgQmFja2Ryb3BbXSA9IFtcIndoaXRlXCIsIFwiZ3JheVwiLCBcImJsYWNrXCIsIFwidHJhbnNwYXJlbnRcIl07XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRCYWNrZHJvcChzOiBNYWdwaWVTdGF0ZSwgYmFja2Ryb3A6IEJhY2tkcm9wKTogYm9vbGVhbiB7XG4gIGlmICghQkFDS0RST1BTLmluY2x1ZGVzKGJhY2tkcm9wKSB8fCBzLmJhY2tkcm9wID09PSBiYWNrZHJvcCkgcmV0dXJuIGZhbHNlO1xuICBzLmJhY2tkcm9wID0gYmFja2Ryb3A7XG4gIHJldHVybiB0cnVlO1xufVxuXG4vLyDilIDilIAgcGhhc2Ugc3BpbmUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbi8vIEFkdmFuY2UgdGhlIGxpbmVhciBwaGFzZSBjdXJzb3IgdG8gdGhlIG5leHQgcGhhc2Ug4oCUIHdoYXQgdGhlIHNlYWwtYW5kLWhhbmQtb2ZmXG4vLyBnYXRlIGZpcmVzLiBSZXR1cm5zIHRoZSBuZXcgcGhhc2UsIG9yIG51bGwgaWYgYWxyZWFkeSBhdCB0aGUgbGFzdCAobm8tb3ApLlxuZXhwb3J0IGZ1bmN0aW9uIGFkdmFuY2VQaGFzZShzOiBNYWdwaWVTdGF0ZSk6IFBoYXNlS2V5IHwgbnVsbCB7XG4gIGNvbnN0IGkgPSBQSEFTRVMuaW5kZXhPZihzLnBoYXNlKTtcbiAgaWYgKGkgPCAwIHx8IGkgPj0gUEhBU0VTLmxlbmd0aCAtIDEpIHJldHVybiBudWxsO1xuICBzLnBoYXNlID0gUEhBU0VTW2kgKyAxXTtcbiAgcmV0dXJuIHMucGhhc2U7XG59XG5cbi8vIFNldCB0aGUgcGhhc2UgY3Vyc29yIGRpcmVjdGx5IChiYWNrLW5hdiAvIGp1bXApLiBWYWxpZGF0ZXMgYWdhaW5zdCBQSEFTRVM7XG4vLyByZXBvcnRzIHdoZXRoZXIgaXQgY2hhbmdlZC5cbmV4cG9ydCBmdW5jdGlvbiBzZXRQaGFzZShzOiBNYWdwaWVTdGF0ZSwgcGhhc2U6IFBoYXNlS2V5KTogYm9vbGVhbiB7XG4gIGlmICghUEhBU0VTLmluY2x1ZGVzKHBoYXNlKSB8fCBzLnBoYXNlID09PSBwaGFzZSkgcmV0dXJuIGZhbHNlO1xuICBzLnBoYXNlID0gcGhhc2U7XG4gIHJldHVybiB0cnVlO1xufVxuXG4vLyBSZWNvcmQgdGhlIGJ1aWx0IGV4cG9ydCBidW5kbGUgKHRoZSBhZ2VudCBwb3N0cyBpdCBhZnRlciB6aXBwaW5nKS4gVGhlIHN1cmZhY2Vcbi8vIG9mZmVycyBpdCBhcyBhIGRvd25sb2FkIHZpYSAvYXNzZXRzLzxuYW1lPi5cbmV4cG9ydCBmdW5jdGlvbiBzZXRCdW5kbGUoczogTWFncGllU3RhdGUsIG5hbWU6IHN0cmluZywgY291bnQ6IG51bWJlcik6IHZvaWQge1xuICBzLmJ1bmRsZSA9IHsgbmFtZSwgY291bnQgfTtcbn1cblxuLy8g4pSA4pSAIGxlYW4gcHJvamVjdGlvbiDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vIFN0cmlwIGFueSAoZXZlbnR1YWxseSBoZWF2eSkgaW5saW5lZCBibG9icyBmcm9tIHRoZSBhZ2VudC1mYWNpbmcgL3N0YXRlIHNvIHRoZVxuLy8gc25hcHNob3Qgc3RheXMgc21hbGw7IHRoZSBhZ2VudCByZWFkcyBvbi1kaXNrIHZlcnNpb24gcGF0aHMgaW5zdGVhZC4gVmVyc2lvbnNcbi8vIGNhcnJ5IG9ubHkgYHBhdGhgIChub3QgaW5saW5lZCBpbWFnZSBkYXRhKSwgc28gdGhpcyBpcyBuZWFyLWlkZW50aXR5IOKAlCBidXQgaXRcbi8vIGRlZmVuc2l2ZWx5IGRyb3BzIGFueSBgc3JjYC9gY3V0b3V0c2AgZmllbGRzIGFuIGVsZW1lbnQgbWlnaHQgaW5saW5lLCBhbmQgbmV2ZXJcbi8vIG11dGF0ZXMgdGhlIHNvdXJjZSBzdGF0ZS5cbmV4cG9ydCBmdW5jdGlvbiBsZWFuU3RhdGUoczogTWFncGllU3RhdGUpOiBNYWdwaWVTdGF0ZSB7XG4gIHJldHVybiB7XG4gICAgLi4ucyxcbiAgICBlbGVtZW50czogcy5lbGVtZW50cy5tYXAoKGUpID0+IHtcbiAgICAgIGNvbnN0IGxlYW4gPSB7IC4uLmUgfSBhcyBFbGVtZW50ICYgeyBzcmM/OiB1bmtub3duOyBjdXRvdXRzPzogdW5rbm93biB9O1xuICAgICAgZGVsZXRlIGxlYW4uc3JjO1xuICAgICAgZGVsZXRlIGxlYW4uY3V0b3V0cztcbiAgICAgIHJldHVybiBsZWFuO1xuICAgIH0pLFxuICB9O1xufVxuIiwKICAgICIvLyBzaGFyZWQvdmVyc2lvbnMudHNcbi8vIFB1cmUgdmVyc2lvbiBoZWxwZXJzIHNoYXJlZCBieSB0aGUgYmFja2VuZCBDTEkgKHNyYy9tYWdwaWUvYmFja2VuZC9jbGkudHMsXG4vLyB3aGljaCByZWFkcyBjaG9zZW5WZXJzaW9uIGZvciBleHBvcnQpIEFORCB0aGUgUmVhY3QgY2xpZW50IChNYWdwaWVTaGVsbCxcbi8vIEV4cG9ydFZpZXcsIFJlbW92ZUdhbGxlcnkpLiBzZXJ2ZXIudHMgZG9lcyBOT1QgaW1wb3J0IHRoZW0g4oCUIHRoZSBkYWVtb24tc2lkZVxuLy8gY29uc3VtZXIgaXMgdGhlIENMSSwgYW5kIHRoYXQgaXMgd2hhdCBtYWtlcyB0aGlzIHR3by1zaWRlZC4gTm8gbm9kZToqIOKAlCBrZWVwXG4vLyBicm93c2VyLXNhZmUuIEFuIGVsZW1lbnQncyBwcm9kdWNlZCBhc3NldHMgYXJlIGEgbW9kZWwtdGFnZ2VkIGxpc3QgKHZlcnNpb25zW10pO1xuLy8gdGhlc2UgcmVzb2x2ZSBcIndoaWNoIG9uZSBpcyBzaG93blwiIGFuZCBcIml0cyBjYWNoZS1idXN0ZWQgVVJMXCIuXG5cbmltcG9ydCB0eXBlIHsgRWxlbWVudCwgRWxlbWVudFZlcnNpb24gfSBmcm9tIFwiLi90eXBlc1wiO1xuXG4vLyBUaGUgdmVyc2lvbiB0aGUgc3VyZmFjZSByZW5kZXJzOiB0aGUgZXhwbGljaXRseSBjaG9zZW4gb25lLCBlbHNlIHRoZSBmaXJzdFxuLy8gKHRoZSBjcm9wKS4gVG9sZXJhdGVzIGFuIGFic2VudC9lbXB0eSBsaXN0IGFuZCBhIHN0YWxlIGNob3NlblZlcnNpb25JZC5cbmV4cG9ydCBmdW5jdGlvbiBjaG9zZW5WZXJzaW9uKGVsOiBFbGVtZW50KTogRWxlbWVudFZlcnNpb24gfCB1bmRlZmluZWQge1xuICBjb25zdCB2cyA9IGVsLnZlcnNpb25zID8/IFtdO1xuICByZXR1cm4gdnMuZmluZCgodikgPT4gdi5pZCA9PT0gZWwuY2hvc2VuVmVyc2lvbklkKSA/PyB2c1swXTtcbn1cblxuLy8gVGhlIC9hc3NldHMgVVJMIGZvciBhIHZlcnNpb24sIGNhY2hlLWJ1c3RlZCBieSBpdHMgcmV2LiBBIHJlLXJ1biBvdmVyd3JpdGVzIHRoZVxuLy8gZmlsZSBpbiBwbGFjZSwgc28gd2l0aG91dCA/dj08cmV2PiB0aGUgYnJvd3NlciBzaG93cyB0aGUgc3RhbGUgY2FjaGVkIGltYWdlLlxuZXhwb3J0IGZ1bmN0aW9uIHZlcnNpb25VcmwodjogRWxlbWVudFZlcnNpb24pOiBzdHJpbmcge1xuICByZXR1cm4gYC9hc3NldHMvJHt2LnBhdGguc3BsaXQoXCIvXCIpLnBvcCgpfT92PSR7di5yZXYgPz8gMH1gO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIG9uZS1saW5lIEpTT04gZW1pdHRlciDigJQgT05FIGltcGxlbWVudGF0aW9uLCBpbXBvcnRlZCBieSBldmVyeVxuICogc3BlbGwgdGhhdCBzcGVha3MgdGhlIGFnZW50IHdpcmUuXG4gKlxuICog4puUIFRISVMgRklMRSBJUyBgc3JjL2tpdC9gJ3MgRklSU1QgSU5IQUJJVEFOVCwgYW5kIHRoYXQgaXMgbG9hZC1iZWFyaW5nIGJleW9uZFxuICogdGhlIHNoYXJpbmcgaXQgZG9lcy4gV2FyZCAyIChcInRoZSBraXQgaXMgYSBsZWFmXCIpIGhhcyBiZWVuIGdyZWVuIGJ5XG4gKiBDT05TVFJVQ1RJT04gc2luY2UgUGhhc2UgMCDigJQgaXQgaGFkIG5vdGhpbmcgdG8gd2FsaywgYW5kIHNhaWQgc28gb24gZXZlcnlcbiAqIHJ1bi4gVGhpcyBtb2R1bGUgaXMgdGhlIGZpcnN0IHRoaW5nIGl0IGFjdHVhbGx5IGd1YXJkcywgd2hpY2ggaXMgd2h5IHRoZVxuICogd2FyZCdzIHplcm8tZ3VhcmQgY2VsbCBkaXN0aW5ndWlzaGVzIGFuIEFCU0VOVCBraXQgZnJvbSBhbiBFTVBUWSBvbmUuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgbm90IGEgc3BlbGwsXG4gKiBub3QgYSBzdXJmYWNlLCBub3QgYSBiYWNrZW5kLiBUaGF0IGlzIHdhcmQgMidzIGFzc2VydGlvbiwgbm90IGEgY29udmVudGlvbixcbiAqIGFuZCBpdCBpcyB3aGF0IG1ha2VzIHRoZSBraXQgc2FmZSB0byBpbmxpbmUgaW50byBhbnkgc3BlbGwncyBidW5kbGUuXG4gKlxuICogRGVsaWJlcmF0ZWx5IGRlcGVuZGVuY3ktZnJlZSBhbmQgZGVsaWJlcmF0ZWx5IGR1bGw6IGl0IGlzIGJ1bmRsZWQgSU5UTyBlYWNoXG4gKiBzcGVsbCdzIGVtaXR0ZWQgQ0xJIChDb250cmFjdCA0J3MgYnVpbHQtYmFja2VuZCBhbWVuZG1lbnQpLCBzbyBhbnl0aGluZyBpdFxuICogcmVhY2hlZCBmb3Igd291bGQgYmVjb21lIGEgZGVwZW5kZW5jeSBvZiB0d28gc2hpcHBlZCBhcnRpZmFjdHMgYXQgb25jZS5cbiAqXG4gKiBUaGUgd2lyZSBjb250cmFjdCBpdCBlbmNvZGVzOiBleGFjdGx5IG9uZSBKU09OIGRvY3VtZW50LCBvbmUgdHJhaWxpbmdcbiAqIG5ld2xpbmUsIG5vdGhpbmcgZWxzZSBvbiBzdGRvdXQuIEEgY2FsbGVyIHJlYWRpbmcgb3VyIHN0ZG91dCB3aXRoIGFcbiAqIGxpbmUtZGVsaW1pdGVkIHBhcnNlciBkZXBlbmRzIG9uIHRoYXQgbmV3bGluZTsgYSBjYWxsZXIgcmVhZGluZyB0byBFT0ZcbiAqIGRlcGVuZHMgb24gdGhlcmUgYmVpbmcgbm8gc2Vjb25kIGRvY3VtZW50LlxuICovXG5leHBvcnQgZnVuY3Rpb24gcHJpbnRKc29uKGRhdGE6IHVua25vd24pOiB2b2lkIHtcbiAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SlNPTi5zdHJpbmdpZnkoZGF0YSl9XFxuYCk7XG59XG4iCiAgXSwKICAibWFwcGluZ3MiOiAiOzs7O0FBd0JBO0FBQ0E7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFVQTtBQUNBLDhCQUFtQixrQkFBUztBQUM1QjtBQUNBLHNCQUFTOzs7QUMzQlQ7OztBQ0RPLElBQU0sbUJBQTZDLElBQUksSUFBSTtBQUFBLEVBQ2hFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQ0YsQ0FBQztBQUdNLElBQU0sd0JBQWtELElBQUksSUFBSTtBQUFBLEVBQ3JFO0FBQUEsRUFDQTtB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QUFNLFFBQVEsQ0FBQztBQUFBLE1BQ3hDO0FBQUEsU0FDRztBQUFBLE1BQ0gsUUFBUSxPQUFPO0FBQUEsTUFDZjtBQUFBLFNBQ0c7QUFBQSxNQUNILFlBQVk7QUFBQSxNQUNaO0FBQUEsU0FDRztBQUFBLE1BQ0gsUUFBUSxPQUFPLE1BQU0sR0FBRztBQUFBLENBQVE7QUFBQSxNQUNoQztBQUFBO0FBQUEsTUFPQSxJQUFJLHdCQUF3QixTQUFTLFVBQVU7QUFBQTtBQUFBLEVBR25ELE9BQU87QUFBQTtBQUdULElBQUksa0JBQWtCO0FBQUEsRUFRcEIsUUFBUSxXQUFXLE1BQU0sS0FBSyxRQUFRLEtBQUssTUFBTSxDQUFDLENBQUM7QUFDckQ7QUFpQkEsZUFBc0IsR0FBRyxHQUFvQjtBQUFBLEVBQzNDLE9BQU8sTUFBTSxLQUFLLFFBQVEsS0FBSyxNQUFNLENBQUMsQ0FBQztBQUFBOyIsCiAgImRlYnVnSWQiOiAiQ0M4NEMyM0M5MEY3RjgwNDY0NzU2RTIxNjQ3NTZFMjEiLAogICJuYW1lcyI6IFtdCn0=
