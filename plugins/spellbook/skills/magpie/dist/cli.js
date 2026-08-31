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

// plugins/spellbook/skills/magpie/surface/state/alpha.ts
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

// plugins/spellbook/skills/magpie/surface/state/types.ts
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

// plugins/spellbook/skills/magpie/surface/state/reduce.ts
function randHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}
function newId(prefix) {
  return `${prefix}-${randHex(4)}`;
}

// plugins/spellbook/skills/magpie/surface/state/versions.ts
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
    cwd: join3(SCRIPT_DIR, "..")
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

//# debugId=BDA87A6B3381FC7A64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL21hZ3BpZS9iYWNrZW5kL2NsaS50cyIsICIuLi9zY3JpcHRzL2JhY2tlbmQudHMiLCAiLi4vc3VyZmFjZS9zdGF0ZS9hbHBoYS50cyIsICIuLi9zY3JpcHRzL2Rpc2NvdmVyLnRzIiwgIi4uL3N1cmZhY2Uvc3RhdGUvdHlwZXMudHMiLCAiLi4vc3VyZmFjZS9zdGF0ZS9yZWR1Y2UudHMiLCAiLi4vc3VyZmFjZS9zdGF0ZS92ZXJzaW9ucy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L2xpYi9wcmludEpzb24udHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiIyEvdXNyL2Jpbi9lbnYgYnVuXG5cbi8vIG1hZ3BpZSBDTEkg4oCUIHRoaW4sIHN0YXRlbGVzcyB3cmFwcGVyIGFyb3VuZCB0aGUgcGVyLXNlc3Npb24gZGFlbW9uJ3MgSFRUUFxuLy8gc3VyZmFjZSAoc2VydmVyLnRzKS4gT25lIEhUVFAgcm91bmQtdHJpcCBwZXIgdmVyYi4gYHRhaWxgIHN0cmVhbXMgU1NFIHVzZXJcbi8vIGV2ZW50cyBhcyBKU09OTCBmb3IgTW9uaXRvciB0byB3cmFwIChhIGBncm91bmRpbmdgIGFuY2hvciBsaW5lIGZpcnN0KS5cbi8vXG4vLyBMaWZlY3ljbGU6XG4vLyAgIGJ1biBjbGkudHMgb3BlbiBbLS10aXRsZSAuLl0gWy0taW50ZW50IC4uXSBbLS1yZXN0b3JlIDxpZD5dIFstLXRpbWVvdXQgU10gWy0tbm8tb3Blbl1cbi8vICAgYnVuIGNsaS50cyB0YWlsIFstLXNpbmNlIE5dICAgICAgICAgICAgIyBTU0UgdXNlciBldmVudHMg4oaSIEpTT05MIChNb25pdG9yIHRoaXMpXG4vLyAgIGJ1biBjbGkudHMgc3RhdGUgWy0tZnVsbF0gICAgICAgICAgICAgICMgbGVhbiBzdGF0ZSBzbmFwc2hvdCAoYWRkIC0tZnVsbCBmb3IgcmF3KVxuLy9cbi8vIERyaXZpbmcgdGhlIHN1cmZhY2UgKFBPU1QgL2NtZCk6XG4vLyAgIGJ1biBjbGkudHMgc2F5IFt0ZXh0Li4uXSBbLS1zdGRpbl0gICAgICAgICAgICAgICAgICMgcG9zdCBhZ2VudCBkaWFsb2d1ZSAodGV4dCBvciBwaXBlZCBzdGRpbilcbi8vICAgYnVuIGNsaS50cyBhc2sgPHRleHQuLi4+IFstLW9wdGlvbnMgXCJhfGJ8Y1wiXSAgICAgICAjIGFzayB0aGUgdXNlciAoaW4tdGhyZWFkKVxuLy8gICBidW4gY2xpLnRzIHN0YXR1cyBvbiBbdGV4dC4uLl0gfCBzdGF0dXMgb2ZmICAgICAgICAjIHRoZSB3b3JraW5nIHNwaW5uZXJcbi8vICAgYnVuIGNsaS50cyBzb3VyY2UgPGltYWdlUGF0aD4gICAgICAgICAgICAgICAgICAgICAgIyBzZXQgdGhlIGNvbXBvc2l0ZSB1bmRlciByZXZpZXcgKGNvbXB1dGVzIHNoYSArIHNpemUpXG4vLyAgIGJ1biBjbGkudHMgY21kIFstLXN0ZGluXSAgICAgICAgICAgICAgICAgICAgICAgICAgICAjIFBPU1QgYSByYXcgQWdlbnRDb21tYW5kIEpTT04gYm9keSAoZnJvbSBzdGRpbilcbi8vICAgYnVuIGNsaS50cyBjbG9zZSB8IGluZm8gfCBzZXNzaW9ucyB8IGhlbHBcbi8vXG4vLyBgLS1zdGRpbmAgcmVhZHMgdGhlIGJvZHkgZnJvbSBzdGRpbiBzbyBuYXR1cmFsLWxhbmd1YWdlIHRleHQgaXMgbmV2ZXIgaW5saW5lZFxuLy8gaW50byBhIHNoZWxsLXBhcnNlZCBhcmcuIFBheWxvYWQgb24gc3Rkb3V0LCBsaXZlbmVzcy9lY2hvIG9uIHN0ZGVyci5cbi8vXG4vLyBBbGwgdmVyYnMgdGFyZ2V0IHRoZSBtb3N0IHJlY2VudCBzZXNzaW9uIGJ5IGRlZmF1bHQ7IHBhc3MgLS1zZXNzaW9uIDxpZD4uXG5cbmltcG9ydCB7IHNwYXduIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHtcbiAgY29weUZpbGVTeW5jLFxuICBleGlzdHNTeW5jLFxuICBta2RpclN5bmMsXG4gIHJlYWRkaXJTeW5jLFxuICByZWFkRmlsZVN5bmMsXG4gIHJtU3luYyxcbiAgc3RhdFN5bmMsXG4gIHdyaXRlRmlsZVN5bmMsXG59IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgYmFzZW5hbWUsIGRpcm5hbWUsIGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoIH0gZnJvbSBcIm5vZGU6dXJsXCI7XG5pbXBvcnQgeyBwYXJzZUFyZ3MgYXMgbm9kZVBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcbmltcG9ydCB7XG4gIHR5cGUgQWxwaGFQb2xpY3ksXG4gIGlzTWVkaWFGb3JnZU1vZGVsLFxuICBtZWRpYUZvcmdlQmFja2VuZCxcbiAgcmVtYmdCYWNrZW5kLFxuICBzaG91bGRSZW1vdmUsXG59IGZyb20gXCIuLi8uLi8uLi9wbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvbWFncGllL3NjcmlwdHMvYmFja2VuZFwiO1xuaW1wb3J0IHsgRGlzY292ZXJFcnJvciwgZGlzY292ZXIgfSBmcm9tIFwiLi4vLi4vLi4vcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL21hZ3BpZS9zY3JpcHRzL2Rpc2NvdmVyXCI7XG5pbXBvcnQgeyBuZXdJZCB9IGZyb20gXCIuLi8uLi8uLi9wbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvbWFncGllL3N1cmZhY2Uvc3RhdGUvcmVkdWNlXCI7XG5pbXBvcnQgdHlwZSB7IEVsZW1lbnQgfSBmcm9tIFwiLi4vLi4vLi4vcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL21hZ3BpZS9zdXJmYWNlL3N0YXRlL3R5cGVzXCI7XG5pbXBvcnQgeyBjaG9zZW5WZXJzaW9uIH0gZnJvbSBcIi4uLy4uLy4uL3BsdWdpbnMvc3BlbGxib29rL3NraWxscy9tYWdwaWUvc3VyZmFjZS9zdGF0ZS92ZXJzaW9uc1wiO1xuaW1wb3J0IHsgcHJpbnRKc29uIH0gZnJvbSBcIi4uLy4uL2tpdC9saWIvcHJpbnRKc29uXCI7XG5cbi8vIFN3YWxsb3cgRVBJUEUgKGEgZG93bnN0cmVhbSBgaGVhZGAvTW9uaXRvciBjbG9zaW5nIG91ciBzdGRvdXQgc2hvdWxkbid0IGNyYXNoKS5cbnByb2Nlc3Muc3Rkb3V0Lm9uKFwiZXJyb3JcIiwgKGU6IE5vZGVKUy5FcnJub0V4Y2VwdGlvbikgPT4ge1xuICBpZiAoZS5jb2RlID09PSBcIkVQSVBFXCIpIHByb2Nlc3MuZXhpdCgwKTtcbn0pO1xuXG5jb25zdCBTQ1JJUFRfRElSID0gZGlybmFtZShmaWxlVVJMVG9QYXRoKGltcG9ydC5tZXRhLnVybCkpO1xuLy8gU2VlIHRoZSBhc3Ryb2xhYmUgdHdpbjogYGRpc3QvYCBhbmQgYHNjcmlwdHMvYCBhcmUgdGhlIHNhbWUgZGVwdGgsIHNvIG9ubHlcbi8vIGEgU0lCTElORy1yZWxhdGl2ZSBwYXRoIGJyZWFrcyB3aGVuIHRoaXMgZXhlY3V0ZXMgYXMgYC4uL2Rpc3QvY2xpLmpzYC5cbmNvbnN0IFNFUlZFUl9TQ1JJUFQgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCJzY3JpcHRzXCIsIFwic2VydmVyLnRzXCIpO1xuXG4vLyBPdXIgcGx1Z2luIHZlcnNpb24gKGZyb20gcGx1Z2luLmpzb24pIOKAlCB0aGUgb25lIG51bWJlciBtYWdwaWUgY2FuIGhvbmVzdGx5XG4vLyByZXBvcnQgYXMgaXRzIG93bi4gRDEgYXNrcyBhIENMSSB0byBhbnN3ZXIgYC0tdmVyc2lvbmA7IGFuIGFnZW50IHRoYXQgY2Fubm90XG4vLyB0ZWxsIHdoaWNoIGJ1aWxkIGl0IGlzIGRyaXZpbmcgY2Fubm90IHRlbGwgYSBtaXNzaW5nIGZlYXR1cmUgZnJvbSBhIHN0YWxlXG4vLyBpbnN0YWxsLiBCZXN0LWVmZm9ydDogbnVsbCBpZiB0aGUgcmVhZCBmYWlscywgYW5kIGAtLXZlcnNpb25gIHNheXMgc28gcmF0aGVyXG4vLyB0aGFuIGludmVudGluZyBvbmUuIFNhbWUgcmVzb2x1dGlvbiBncmFwZXZpbmUgdXNlcy5cbmZ1bmN0aW9uIHJlYWRQbHVnaW5WZXJzaW9uKCk6IHN0cmluZyB8IG51bGwge1xuICB0cnkge1xuICAgIGNvbnN0IHBsdWdpbkpzb25QYXRoID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcIi5jbGF1ZGUtcGx1Z2luXCIsIFwicGx1Z2luLmpzb25cIik7XG4gICAgcmV0dXJuIEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHBsdWdpbkpzb25QYXRoLCBcInV0Zi04XCIpKS52ZXJzaW9uID8/IG51bGw7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5jb25zdCBQTFVHSU5fVkVSU0lPTiA9IHJlYWRQbHVnaW5WZXJzaW9uKCk7XG5cbnR5cGUgU2Vzc2lvbiA9IHtcbiAgdXJsOiBzdHJpbmc7XG4gIHBvcnQ6IG51bWJlcjtcbiAgc2Vzc2lvbl9pZDogc3RyaW5nO1xuICB0aXRsZTogc3RyaW5nO1xuICBmaWxlc19kaXI/OiBzdHJpbmc7XG59O1xuXG4vLyDilIDilIAgZXJyb3IgZW52ZWxvcGUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vL1xuLy8gbWFncGllIGRlY2xhcmVzIGBkZWZhdWx0T3V0cHV0OiBcImpzb25cImAsIGFuZCB0aGF0IGRlY2xhcmF0aW9uIGlzIGFib3V0IEVWRVJZXG4vLyBzdHJlYW0sIG5vdCBqdXN0IHRoZSBoYXBweSBwYXRoLiBBIGNhbGxlciB0aGF0IGdldHMgb25lIEpTT04gZG9jdW1lbnQgZnJvbSBhXG4vLyB2ZXJiIGFuZCBwcm9zZSBmcm9tIGEgZmFpbHVyZSBoYXMgdG8gcGFyc2UgdHdvIGZvcm1hdHMgdG8gdXNlIG9uZSB0b29sIOKAlCBhbmRcbi8vIHRoZSBmYWlsdXJlIGlzIHRoZSBjYXNlIHdoZXJlIGl0IGNhbiBsZWFzdCBhZmZvcmQgdG8gZ3Vlc3MuIFNvIGEgZmFpbHVyZSBpc1xuLy8gT05FIEpTT04gZG9jdW1lbnQgb24gc3RkZXJyLCBhbmQgc3Rkb3V0IHN0YXlzIGVtcHR5IGJlY2F1c2Ugc3Rkb3V0IGNhcnJpZXNcbi8vIGRhdGEgYW5kIGEgZmFpbHVyZSBoYXMgbm9uZS5cbi8vXG4vLyBga2luZGAgaXMgdGhlIGNvbnRyYWN0OyBgbWVzc2FnZWAgaXMgcHJlc2VudGF0aW9uLiBSZXdvcmRpbmcgYSBtZXNzYWdlIG11c3Rcbi8vIG5ldmVyIGJyZWFrIGEgY2FsbGVyLCB3aGljaCBpdCBkb2VzIHRoZSBtb21lbnQgYW55b25lIG1hdGNoZXMgb24gcHJvc2UuXG4vLyBFeGl0IGNvZGVzIGZvbGxvdyB0aGUgYWNjIHRheG9ub215OiB1c2FnZSBlcnJvcnMgYXJlIHRoZSBjYWxsZXIncyB0byBmaXggYnlcbi8vIGNoYW5naW5nIHRoZSBjb21tYW5kLCBpbnRlcm5hbCBmYXVsdHMgYXJlIG5vdCwgYW5kIGNvbGxhcHNpbmcgdGhlbSBpbnRvIG9uZVxuLy8gbnVtYmVyIGxlYXZlcyBhbiBhZ2VudCB3aXRoIG5vdGhpbmcgdG8gcm91dGUgb24uXG50eXBlIEVycktpbmQgPSBcInVzYWdlXCIgfCBcImludGVybmFsXCIgfCBcIm5vdF9mb3VuZFwiIHwgXCJjb25mbGljdFwiO1xuXG5jb25zdCBFWElUX0ZPUjogUmVjb3JkPEVycktpbmQsIG51bWJlcj4gPSB7XG4gIHVzYWdlOiAyLCAvLyB0aGUgY2FsbGVyIGNhbiBmaXggdGhpcyBieSBjaGFuZ2luZyB0aGUgY29tbWFuZFxuICBpbnRlcm5hbDogMSwgLy8gbWFncGllIGJyb2tlOyB0aGUgaW52b2NhdGlvbiBtYXkgaGF2ZSBiZWVuIGZpbmVcbiAgbm90X2ZvdW5kOiA1LCAvLyB0aGUgbmFtZWQgdGhpbmcgZG9lcyBub3QgZXhpc3RcbiAgY29uZmxpY3Q6IDYsIC8vIGEgcHJlY29uZGl0aW9uIGZhaWxlZFxufTtcblxuLy8gVGhlIHZlcmIgdW5kZXIgZXhlY3V0aW9uLCBzbyB0aGUgZW52ZWxvcGUgY2FuIG5hbWUgaXQuIFNldCBvbmNlIGJ5IG1haW4oKS5cbmxldCBDVVJSRU5UX0NPTU1BTkQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG5mdW5jdGlvbiBlcnJvckVudmVsb3BlKFxuICBraW5kOiBFcnJLaW5kLFxuICBtZXNzYWdlOiBzdHJpbmcsXG4gIGV4dHJhPzogeyBoaW50Pzogc3RyaW5nOyBjaG9pY2VzPzogc3RyaW5nW10gfSxcbik6IHN0cmluZyB7XG4gIHJldHVybiBgJHtKU09OLnN0cmluZ2lmeSh7XG4gICAgb2s6IGZhbHNlLFxuICAgIGVycm9yOiB7XG4gICAgICBraW5kLFxuICAgICAgZXhpdF9jb2RlOiBFWElUX0ZPUltraW5kXSxcbiAgICAgIC8vIE9ubHkgcmF0ZSBsaW1pdHMgYXJlIHdvcnRoIHJldHJ5aW5nIHVuY2hhbmdlZDsgbm90aGluZyBtYWdwaWUgcmFpc2VzIGlzLlxuICAgICAgcmV0cnlhYmxlOiBmYWxzZSxcbiAgICAgIG1lc3NhZ2UsXG4gICAgICAuLi4oZXh0cmE/LmhpbnQgPyB7IGhpbnQ6IGV4dHJhLmhpbnQgfSA6IHt9KSxcbiAgICAgIC4uLihleHRyYT8uY2hvaWNlcyA/IHsgY2hvaWNlczogZXh0cmEuY2hvaWNlcyB9IDoge30pLFxuICAgIH0sXG4gICAgbWV0YTogeyBjb21tYW5kOiBDVVJSRU5UX0NPTU1BTkQgfSxcbiAgfSl9XFxuYDtcbn1cblxuZnVuY3Rpb24gZGllKFxuICBtc2c6IHN0cmluZyxcbiAga2luZDogRXJyS2luZCA9IFwidXNhZ2VcIixcbiAgZXh0cmE/OiB7IGhpbnQ/OiBzdHJpbmc7IGNob2ljZXM/OiBzdHJpbmdbXSB9LFxuKTogbmV2ZXIge1xuICBwcm9jZXNzLnN0ZGVyci53cml0ZShlcnJvckVudmVsb3BlKGtpbmQsIG1zZywgZXh0cmEpKTtcbiAgcHJvY2Vzcy5leGl0KEVYSVRfRk9SW2tpbmRdKTtcbn1cblxuZnVuY3Rpb24gc2xlZXAobXM6IG51bWJlcik6IFByb21pc2U8dm9pZD4ge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgbXMpKTtcbn1cblxuZnVuY3Rpb24gc2Vzc2lvbkZpbGVQYXRoKHNlc3Npb24/OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gc2Vzc2lvbiA/IGpvaW4odG1wZGlyKCksIGBtYWdwaWUtJHtzZXNzaW9ufS5qc29uYCkgOiBqb2luKHRtcGRpcigpLCBcIm1hZ3BpZS1sYXRlc3QuanNvblwiKTtcbn1cblxuZnVuY3Rpb24gcmVhZFNlc3Npb24oc2Vzc2lvbj86IHN0cmluZyk6IFNlc3Npb24gfCBudWxsIHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoc2Vzc2lvbkZpbGVQYXRoKHNlc3Npb24pLCBcInV0ZjhcIikpIGFzIFNlc3Npb247XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlcXVpcmVTZXNzaW9uKHNlc3Npb24/OiBzdHJpbmcpOiBTZXNzaW9uIHtcbiAgY29uc3QgcyA9IHJlYWRTZXNzaW9uKHNlc3Npb24pO1xuICBpZiAoIXMpIGRpZShcIm5vIHJ1bm5pbmcgbWFncGllIHNlc3Npb24g4oCUIHJ1bjogY2xpLnRzIG9wZW5cIiwgXCJub3RfZm91bmRcIik7XG4gIHJldHVybiBzO1xufVxuXG5hc3luYyBmdW5jdGlvbiBhcGkoXG4gIHBvcnQ6IG51bWJlcixcbiAgbWV0aG9kOiBzdHJpbmcsXG4gIHBhdGg6IHN0cmluZyxcbiAgYm9keT86IHVua25vd24sXG4pOiBQcm9taXNlPHsgc3RhdHVzOiBudW1iZXI7IGRhdGE6IHVua25vd24gfT4ge1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9JHtwYXRofWAsIHtcbiAgICBtZXRob2QsXG4gICAgaGVhZGVyczogYm9keSAhPT0gdW5kZWZpbmVkID8geyBcImNvbnRlbnQtdHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9IDogdW5kZWZpbmVkLFxuICAgIGJvZHk6IGJvZHkgIT09IHVuZGVmaW5lZCA/IEpTT04uc3RyaW5naWZ5KGJvZHkpIDogdW5kZWZpbmVkLFxuICB9KTtcbiAgbGV0IGRhdGE6IHVua25vd24gPSBudWxsO1xuICB0cnkge1xuICAgIGRhdGEgPSBhd2FpdCByZXMuanNvbigpO1xuICB9IGNhdGNoIHt9XG4gIHJldHVybiB7IHN0YXR1czogcmVzLnN0YXR1cywgZGF0YSB9O1xufVxuXG4vLyBTcGxpdCBhcmd2IGludG8gcG9zaXRpb25hbHMgKyBmbGFncy4gYC0tZmxhZyB2YWx1ZWAsIGAtLWZsYWc9dmFsdWVgLCBvciBib29sZWFuLlxuLy8gIzgxIC8gRDQg4oCUIFRIRSBSRUNPR05JWkVEIFNFVCwgQVQgUEFSU0VSIEFMVElUVURFLlxuLy9cbi8vIFRoZSBoYW5kLXJvbGxlZCBwYXJzZXIgaGFkIG5vIHJlZ2lzdHJ5LCBzbyBhbiB1bmtub3duIGZsYWcgd2FzIGFjY2VwdGVkIGF0XG4vLyBleGl0IDAgYW5kIHRoZSB2ZXJiIHJhbiBhbnl3YXksIGFuZCBmcmVlIHByb3NlIGNvbnRhaW5pbmcgYSBgLS13b3JkYCB3YXNcbi8vIHNpbGVudGx5IHRydW5jYXRlZCBhdCB0aGF0IHdvcmQuIGBub2RlOnV0aWxgIHN0cmljdCBzdXBwbGllcyByZWplY3Rpb24sIHRoZVxuLy8gYD1gIGZvcm0gYW5kIHRoZSBgLS1gIHRlcm1pbmF0b3IgZnJvbSB0aGUgc3RhbmRhcmQgbGlicmFyeS5cbi8vXG4vLyBUeXBlcyBhcmUgdGhvdGgncyBhdWRpdGVkIGFydGlmYWN0ICgxNSBzdHJpbmcgwrcgNCBib29sZWFuKSwgZWFjaCBzZXR0bGVkIGJ5XG4vLyB1bmFtYmlndW91cyBldmlkZW5jZSBhdCBldmVyeSBjb25zdW1wdGlvbiBzaXRlLiBHZXR0aW5nIG9uZSB3cm9uZyBpcyBub3QgYVxuLy8gbm8tb3A6IGEgXCJzdHJpbmdcIiB0aGF0IHNob3VsZCBiZSBib29sZWFuIFNXQUxMT1dTIFRIRSBORVhUIFBPU0lUSU9OQUwsIGFuZCBhXG4vLyBcImJvb2xlYW5cIiB0aGF0IHNob3VsZCBiZSBzdHJpbmcgYnJlYWtzIHRoZSBzcGFjZSBmb3JtLlxuY29uc3QgQ0xJX09QVElPTlMgPSB7XG4gIGFscGhhOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgYmJveDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGlkczogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGludGVudDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGxhYmVsOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbW9kZWw6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBuYW1lOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgb3B0aW9uczogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHBhZDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHJlc3RvcmU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzZXNzaW9uOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc2luY2U6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0aW1lb3V0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdGl0bGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0eXBlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZnVsbDogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBcIm5vLW9wZW5cIjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICByZW1vdmU6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgc3RkaW46IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbn0gYXMgY29uc3Q7XG5cbi8vIFdISUNIIEZMQUdTIEVBQ0ggVkVSQiBBQ0NFUFRTIOKAlCBhbmQgdGhlIG9ubHkgc291cmNlIG9mIHRoZSB2ZXJiIHNldC5cbi8vXG4vLyBUaGUgcGFyc2VyIHVzZWQgdG8gZW5mb3JjZSBPTkUgR0xPQkFMIHJlZ2lzdHJ5OiBldmVyeSB2ZXJiIGFjY2VwdGVkIGV2ZXJ5XG4vLyBmbGFnLCBzbyBgY2xvc2UgLS1hbHBoYSBhdXRvYCBhbmQgYHNheSAtLWJib3ggMSwyLDMsNGAgcGFyc2VkIGNsZWFuIGFuZCBkaWRcbi8vIG5vdGhpbmcuIEEgcmVjb3JkZWQtc3VyZmFjZSBjZW5zdXMgY291bnRlZCAyODkgc3VjaCBmbGFnL3BhdGggcGFpcnMg4oCUIDI4OVxuLy8gaW52b2NhdGlvbnMgbWFncGllIGFjY2VwdGVkIGF0IGV4aXQgMCBhbmQgY291bGQgbm90IGFjdCBvbi4gVGhhdCBpcyB0aGVcbi8vIGZhaWx1cmUgdGhpcyB3aG9sZSBraXQgaXMgbmFtZWQgZm9yOiB0aGUgdG9vbCBkb2VzIHRoZSB3cm9uZyB0aGluZyBhbmQgcmVwb3J0c1xuLy8gc3VjY2Vzcy4gQW4gdW5rbm93bi1mbGFnIGNoZWNrIGF0IHRoZSByb290IGNhbm5vdCBzZWUgaXQsIGJlY2F1c2Ugbm9uZSBvZiB0aGVcbi8vIGZsYWdzIGFyZSB1bmtub3duIOKAlCB0aGV5IGFyZSBqdXN0IG5vdCBrbm93biBIRVJFLlxuLy9cbi8vIFNvIHRoZSByZWNvZ25pemVkIHNldCBpcyBwZXIgdmVyYiwgYW5kIHRoaXMgdGFibGUgaXMgaXQuIGBWRVJCU2AgaXMgZGVyaXZlZFxuLy8gZnJvbSBpdHMga2V5cyBhbmQgZWFjaCB2ZXJiIHBhcnNlcyBhZ2FpbnN0IGl0cyBvd24gb3B0aW9ucywgd2hpY2ggbWVhbnMgdGhlXG4vLyBoZWxwIHRleHQsIHRoZSByZWplY3Rpb24ncyBgY2hvaWNlc2AgYW5kIHRoZSBwYXJzZXIgY2FuIG5vIGxvbmdlciBkaXNhZ3JlZTpcbi8vIHRoZXJlIGlzIG9uZSBvYmplY3QsIGFuZCBhZGRpbmcgYSBmbGFnIHRvIGEgdmVyYiBpcyBvbmUgZWRpdC5cbmV4cG9ydCBjb25zdCBWRVJCX1NQRUMgPSB7XG4gIG9wZW46IFtcInRpdGxlXCIsIFwiaW50ZW50XCIsIFwidGltZW91dFwiLCBcInJlc3RvcmVcIiwgXCJuby1vcGVuXCJdLFxuICBzZXNzaW9uczogW10sXG4gIHRhaWw6IFtcInNlc3Npb25cIiwgXCJzaW5jZVwiXSxcbiAgc3RhdGU6IFtcInNlc3Npb25cIiwgXCJmdWxsXCJdLFxuICBzYXk6IFtcInNlc3Npb25cIiwgXCJzdGRpblwiXSxcbiAgYXNrOiBbXCJzZXNzaW9uXCIsIFwib3B0aW9uc1wiXSxcbiAgc3RhdHVzOiBbXCJzZXNzaW9uXCJdLFxuICBzb3VyY2U6IFtcInNlc3Npb25cIl0sXG4gIGRpc2NvdmVyOiBbXCJzZXNzaW9uXCJdLFxuICBleHRyYWN0OiBbXCJzZXNzaW9uXCIsIFwiaWRzXCIsIFwicmVtb3ZlXCIsIFwiYWxwaGFcIiwgXCJwYWRcIiwgXCJtb2RlbFwiLCBcImxhYmVsXCJdLFxuICBleHBvcnQ6IFtcInNlc3Npb25cIiwgXCJpZHNcIl0sXG4gIFwiZWxlbWVudC1hZGRcIjogW1wic2Vzc2lvblwiLCBcImJib3hcIiwgXCJuYW1lXCIsIFwidHlwZVwiXSxcbiAgXCJlbGVtZW50LXJlbW92ZVwiOiBbXCJzZXNzaW9uXCJdLFxuICBjbWQ6IFtcInNlc3Npb25cIiwgXCJzdGRpblwiXSxcbiAgY2xvc2U6IFtcInNlc3Npb25cIl0sXG4gIGluZm86IFtcInNlc3Npb25cIl0sXG4gIGhlbHA6IFtdLFxufSBhcyBjb25zdCBzYXRpc2ZpZXMgUmVjb3JkPHN0cmluZywgcmVhZG9ubHkgKGtleW9mIHR5cGVvZiBDTElfT1BUSU9OUylbXT47XG5cbnR5cGUgVmVyYiA9IGtleW9mIHR5cGVvZiBWRVJCX1NQRUM7XG5cbmNvbnN0IFZFUkJTID0gT2JqZWN0LmtleXMoVkVSQl9TUEVDKSBhcyBWZXJiW107XG5cbmNvbnN0IGlzVmVyYiA9ICh2OiBzdHJpbmcpOiB2IGlzIFZlcmIgPT4gT2JqZWN0Lmhhc093bihWRVJCX1NQRUMsIHYpO1xuXG4vLyBUaGUgZmxhZ3Mgb25lIHZlcmIgYWNjZXB0cywgYXMgdGhlIGNhbGxlciBzcGVsbHMgdGhlbS5cbmNvbnN0IGZsYWdzRm9yID0gKHZlcmI6IFZlcmIpOiBzdHJpbmdbXSA9PiBWRVJCX1NQRUNbdmVyYl0ubWFwKChrKSA9PiBgLS0ke2t9YCkuc29ydCgpO1xuXG5jbGFzcyBVc2FnZUVycm9yIGV4dGVuZHMgRXJyb3Ige31cblxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQXJncyhcbiAgYXJnczogc3RyaW5nW10sXG4gIHZlcmI/OiBWZXJiLFxuKToge1xuICBwb3M6IHN0cmluZ1tdO1xuICBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj47XG59IHtcbiAgLy8gVFdPIFNUQUdFUywgQU5EIFRIRSBPUkRFUiBJUyBUSEUgUE9JTlQuXG4gIC8vXG4gIC8vIFN0YWdlIDEgcGFyc2VzIGFnYWluc3QgdGhlIFdIT0xFIHJlZ2lzdHJ5LCBzbyBhIHRva2VuIG1hZ3BpZSBoYXMgbmV2ZXJcbiAgLy8gaGVhcmQgb2YgaXMgcmVmdXNlZCBieSBgbm9kZTp1dGlsYCB3aXRoIGl0cyBvd24gbWVzc2FnZS4gU3RhZ2UgMiB0aGVuIGFza3NcbiAgLy8gdGhlIHF1ZXN0aW9uIHRoZSBwYXJzZXIgY2Fubm90OiBpcyB0aGlzIGZsYWcgYWNjZXB0ZWQgQVQgVEhJUyBWRVJCLlxuICAvL1xuICAvLyBEb2luZyBpdCB0aGUgb3RoZXIgd2F5IOKAlCBoYW5kaW5nIHBhcnNlQXJncyBhIHBlci12ZXJiIHN1YnNldCDigJQgd2FzIHRoZSBmaXJzdFxuICAvLyBzaGFwZSwgYW5kIGl0IGFuc3dlcmVkIGBzYXkgLS1iYm94YCB3aXRoIFwiVW5rbm93biBvcHRpb24gJy0tYmJveCdcIiwgd2hpY2ggaXNcbiAgLy8gZmFsc2UuIGAtLWJib3hgIGlzIGEgcGVyZmVjdGx5IGdvb2QgZmxhZzsgaXQganVzdCBpcyBub3QgYHNheWAncy4gQW4gYWdlbnRcbiAgLy8gdG9sZCBhIHJlYWwgZmxhZyBpcyB1bmtub3duIGdvZXMgbG9va2luZyBmb3IgYSB0eXBvIGl0IGRpZCBub3QgbWFrZS5cbiAgLy9cbiAgLy8gSXQgYWxzbyBjb3N0IHRoZSBncmltb2lyZSdzIGZsYWctaW52YXJpYW50IHdhcmQgaXRzIGZvb3Rpbmc6IHRoYXQgY2hlY2tcbiAgLy8gcmVzb2x2ZXMgYG9wdGlvbnM6IDxpZGVudGlmaWVyPmAgYmFjayB0byBhIGxpdGVyYWwgZGVjbGFyYXRpb24sIGFuZCBhIHN1YnNldFxuICAvLyBjb21wdXRlZCBhdCB0aGUgY2FsbCBzaXRlIGlzIG5vdCBvbmUuIFRoZSB3YXJkIGNvdWxkIG5vIGxvbmdlciByZWFkIG1hZ3BpZSdzXG4gIC8vIHJlZ2lzdHJ5IGF0IGFsbCBhbmQgcmVwb3J0ZWQgdGhlIGVudHJ5IHBvaW50IHVucmVzb2x2ZWQg4oCUIHRoZSBpbnN0cnVtZW50XG4gIC8vIHNheWluZyBcIkkgY2Fubm90IHNlZSB0aGlzXCIsIGV4YWN0bHkgYXMgZGVzaWduZWQuIEtlZXBpbmcgYENMSV9PUFRJT05TYCBhdFxuICAvLyB0aGUgY2FsbCBzaXRlIGtlZXBzIHRoZSByZWdpc3RyeSBsZWdpYmxlIHRvIGl0LlxuICBsZXQgcGFyc2VkOiB7IHZhbHVlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj47IHBvc2l0aW9uYWxzOiBzdHJpbmdbXSB9O1xuICB0cnkge1xuICAgIHBhcnNlZCA9IG5vZGVQYXJzZUFyZ3Moe1xuICAgICAgYXJncyxcbiAgICAgIG9wdGlvbnM6IENMSV9PUFRJT05TLFxuICAgICAgc3RyaWN0OiB0cnVlLFxuICAgICAgYWxsb3dQb3NpdGlvbmFsczogdHJ1ZSxcbiAgICB9KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHRocm93IG5ldyBVc2FnZUVycm9yKGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSk7XG4gIH1cblxuICBpZiAodmVyYikge1xuICAgIGNvbnN0IGFsbG93ZWQgPSBuZXcgU2V0PHN0cmluZz4oVkVSQl9TUEVDW3ZlcmJdKTtcbiAgICBjb25zdCBzdHJheSA9IE9iamVjdC5rZXlzKHBhcnNlZC52YWx1ZXMpLmZpbmQoKGspID0+ICFhbGxvd2VkLmhhcyhrKSk7XG4gICAgaWYgKHN0cmF5KSB7XG4gICAgICB0aHJvdyBuZXcgVXNhZ2VFcnJvcihcbiAgICAgICAgYC0tJHtzdHJheX0gaXMgbm90IGFjY2VwdGVkIGJ5IFxcYCR7dmVyYn1cXGAgKGl0IGlzIGEgcmVjb2duaXplZCBtYWdwaWUgZmxhZywganVzdCBub3QgdGhpcyB2ZXJiJ3MpYCxcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBwb3M6IHBhcnNlZC5wb3NpdGlvbmFscyxcbiAgICBmbGFnczogcGFyc2VkLnZhbHVlcyBhcyBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPixcbiAgfTtcbn1cblxuLy8gUmVhZCBhbGwgb2Ygc3RkaW4gYXMgdGV4dCAoQnVuLnN0ZGluKS4gVXNlZCBieSBgLS1zdGRpbmAgc28gTkwgdGV4dCBpc24ndCBhXG4vLyBzaGVsbC1wYXJzZWQgYXJnLlxuYXN5bmMgZnVuY3Rpb24gcmVhZFN0ZGluKCk6IFByb21pc2U8c3RyaW5nPiB7XG4gIHJldHVybiAoYXdhaXQgQnVuLnN0ZGluLnRleHQoKSkudHJpbSgpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBwb3N0Q21kKHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCwgbXNnOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikge1xuICBjb25zdCBzID0gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbik7XG4gIGNvbnN0IHsgc3RhdHVzIH0gPSBhd2FpdCBhcGkocy5wb3J0LCBcIlBPU1RcIiwgXCIvY21kXCIsIG1zZyk7XG4gIGlmIChzdGF0dXMgIT09IDIwMCkgZGllKGBjbWQgZmFpbGVkIChIVFRQICR7c3RhdHVzfSkg4oCUIGlzIHRoZSBzZXNzaW9uIHN0aWxsIGFsaXZlP2AsIFwiaW50ZXJuYWxcIik7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBzZW50OiBtc2cudHlwZSB9KTtcbn1cblxuLy8g4pSA4pSAIHZlcmJzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5hc3luYyBmdW5jdGlvbiBjbWRPcGVuKGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPikge1xuICBjb25zdCBhcmdzID0gW1wicnVuXCIsIFNFUlZFUl9TQ1JJUFRdO1xuICBpZiAoZmxhZ3MudGl0bGUpIGFyZ3MucHVzaChcIi0tdGl0bGVcIiwgU3RyaW5nKGZsYWdzLnRpdGxlKSk7XG4gIGlmIChmbGFncy5pbnRlbnQpIGFyZ3MucHVzaChcIi0taW50ZW50XCIsIFN0cmluZyhmbGFncy5pbnRlbnQpKTtcbiAgaWYgKGZsYWdzLnRpbWVvdXQpIGFyZ3MucHVzaChcIi0tdGltZW91dFwiLCBTdHJpbmcoZmxhZ3MudGltZW91dCkpO1xuICBpZiAoZmxhZ3MucmVzdG9yZSkgYXJncy5wdXNoKFwiLS1yZXN0b3JlXCIsIFN0cmluZyhmbGFncy5yZXN0b3JlKSk7XG4gIGlmIChmbGFnc1tcIm5vLW9wZW5cIl0pIGFyZ3MucHVzaChcIi0tbm8tb3BlblwiKTtcblxuICBjb25zdCBwcmV2SWQgPSByZWFkU2Vzc2lvbigpPy5zZXNzaW9uX2lkO1xuICAvLyBEZXRhY2hlZCBub2RlOmNoaWxkX3Byb2Nlc3MgKG5vdCBCdW4uc3Bhd24pIHNvIHRoZSBkYWVtb24gU1VSVklWRVMgdGhpcyBDTElcbiAgLy8gcHJvY2VzcyBleGl0aW5nIOKAlCB0aGUgaG91c2UgcGF0dGVybiBmb3IgYSBzdGFuZGluZyBkYWVtb24uIGN3ZCBwaW5uZWQgdG8gdGhlXG4gIC8vIHNraWxsIHJvb3Qgc28gQnVuIGZpbmRzIGJ1bmZpZy50b21sIChyZWdpc3RlcnMgYnVuLXBsdWdpbi10YWlsd2luZCkuXG4gIGNvbnN0IHByb2MgPSBzcGF3bihwcm9jZXNzLmV4ZWNQYXRoLCBhcmdzLCB7XG4gICAgZGV0YWNoZWQ6IHRydWUsXG4gICAgc3RkaW86IFtcImlnbm9yZVwiLCBcImlnbm9yZVwiLCBcImlnbm9yZVwiXSxcbiAgICBlbnY6IHByb2Nlc3MuZW52LFxuICAgIGN3ZDogam9pbihTQ1JJUFRfRElSLCBcIi4uXCIpLFxuICB9KTtcbiAgcHJvYy51bnJlZigpO1xuXG4gIGNvbnN0IGRlYWRsaW5lID0gRGF0ZS5ub3coKSArIDUwMDA7XG4gIHdoaWxlIChEYXRlLm5vdygpIDwgZGVhZGxpbmUpIHtcbiAgICBhd2FpdCBzbGVlcCg4MCk7XG4gICAgY29uc3QgcyA9IHJlYWRTZXNzaW9uKCk7XG4gICAgaWYgKHMgJiYgcy5zZXNzaW9uX2lkICE9PSBwcmV2SWQpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3MucG9ydH0vc3RhdGVgKTtcbiAgICAgICAgaWYgKHIub2spIHtcbiAgICAgICAgICBwcmludEpzb24ocyk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogbm90IHVwIHlldCAqL1xuICAgICAgfVxuICAgIH1cbiAgfVxuICBkaWUoXCJtYWdwaWUgc2VydmVyIGZhaWxlZCB0byBzdGFydCB3aXRoaW4gNXNcIiwgXCJpbnRlcm5hbFwiKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kU3RhdGUoc2Vzc2lvbj86IHN0cmluZywgZnVsbCA9IGZhbHNlKSB7XG4gIGNvbnN0IHMgPSByZXF1aXJlU2Vzc2lvbihzZXNzaW9uKTtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaShzLnBvcnQsIFwiR0VUXCIsIGAvc3RhdGUke2Z1bGwgPyBcIlwiIDogXCI/bGVhbj0xXCJ9YCk7XG4gIGlmIChzdGF0dXMgIT09IDIwMCkgZGllKGBzdGF0ZSBmYWlsZWQgKEhUVFAgJHtzdGF0dXN9KWAsIFwiaW50ZXJuYWxcIik7XG4gIHByaW50SnNvbihkYXRhKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gY21kVGFpbChzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsIHNpbmNlQXJnOiBudW1iZXIpIHtcbiAgbGV0IHNpbmNlID0gc2luY2VBcmc7XG4gIGxldCBkZWxheSA9IDI1MDtcbiAgbGV0IHN0b3BwZWQgPSBmYWxzZTtcbiAgbGV0IGJvdW5kSWQgPSBzZXNzaW9uO1xuICBsZXQgZ3JvdW5kZWQgPSBmYWxzZTtcbiAgY29uc3Qgc3RvcCA9ICgpID0+IHtcbiAgICBzdG9wcGVkID0gdHJ1ZTtcbiAgICBwcm9jZXNzLmV4aXQoMCk7XG4gIH07XG4gIHByb2Nlc3Mub24oXCJTSUdJTlRcIiwgc3RvcCk7XG4gIHByb2Nlc3Mub24oXCJTSUdURVJNXCIsIHN0b3ApO1xuXG4gIHdoaWxlICghc3RvcHBlZCkge1xuICAgIGNvbnN0IHMgPSByZWFkU2Vzc2lvbihib3VuZElkKTtcbiAgICBpZiAoIXMpIHtcbiAgICAgIGlmIChncm91bmRlZCkgcHJvY2Vzcy5leGl0KDApOyAvLyBvdXIgcGlubmVkIHNlc3Npb24gd2VudCBhd2F5IOKGkiBkb25lXG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcIiMgbm8gc2Vzc2lvbiB5ZXQsIHJldHJ5aW5n4oCmXFxuXCIpO1xuICAgICAgYXdhaXQgc2xlZXAoZGVsYXkpO1xuICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIDUwMDApO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmICghYm91bmRJZCkgYm91bmRJZCA9IHMuc2Vzc2lvbl9pZDsgLy8gcGluIHRvIHRoZSBmaXJzdCBzZXNzaW9uIHdlIHJlc29sdmVkXG4gICAgaWYgKCFncm91bmRlZCkge1xuICAgICAgZ3JvdW5kZWQgPSB0cnVlO1xuICAgICAgLy8gZ3JvdW5kaW5nIGFuY2hvciDigJQgcGFyc2VhYmxlICsgdmlzaWJsZSBpbiBhIE1vbml0b3I7IG5hbWVzIHRoZSBiaW5kaW5nLlxuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgICAgIGAke0pTT04uc3RyaW5naWZ5KHsgdHlwZTogXCJncm91bmRpbmdcIiwgc2Vzc2lvbl9pZDogcy5zZXNzaW9uX2lkLCBwb3J0OiBzLnBvcnQgfSl9XFxuYCxcbiAgICAgICk7XG4gICAgfVxuICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgIHRyeSB7XG4gICAgICByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3MucG9ydH0vZXZlbnRzP3NpbmNlPSR7c2luY2V9YCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBhd2FpdCBzbGVlcChkZWxheSk7XG4gICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgNTAwMCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKCFyZXMub2sgfHwgIXJlcy5ib2R5KSB7XG4gICAgICBhd2FpdCBzbGVlcChkZWxheSk7XG4gICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgNTAwMCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgZGVsYXkgPSAyNTA7XG4gICAgY29uc3QgcmVhZGVyID0gcmVzLmJvZHkuZ2V0UmVhZGVyKCk7XG4gICAgY29uc3QgZGVjID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgbGV0IGJ1ZiA9IFwiXCI7XG4gICAgd2hpbGUgKHRydWUpIHtcbiAgICAgIGxldCBjaHVuazogUmVhZGFibGVTdHJlYW1SZWFkUmVzdWx0PFVpbnQ4QXJyYXk+O1xuICAgICAgdHJ5IHtcbiAgICAgICAgY2h1bmsgPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgICAgaWYgKGNodW5rLmRvbmUpIGJyZWFrO1xuICAgICAgYnVmICs9IGRlYy5kZWNvZGUoY2h1bmsudmFsdWUsIHsgc3RyZWFtOiB0cnVlIH0pO1xuICAgICAgZm9yIChsZXQgc2VwID0gYnVmLmluZGV4T2YoXCJcXG5cXG5cIik7IHNlcCA+PSAwOyBzZXAgPSBidWYuaW5kZXhPZihcIlxcblxcblwiKSkge1xuICAgICAgICBjb25zdCBibG9jayA9IGJ1Zi5zbGljZSgwLCBzZXApO1xuICAgICAgICBidWYgPSBidWYuc2xpY2Uoc2VwICsgMik7XG4gICAgICAgIGNvbnN0IGRhdGFMaW5lczogc3RyaW5nW10gPSBbXTtcbiAgICAgICAgZm9yIChjb25zdCBsaW5lIG9mIGJsb2NrLnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgICAgICAgaWYgKGxpbmUuc3RhcnRzV2l0aChcIjpcIikpIHtcbiAgICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFwiOiBtYWdwaWUta2VlcGFsaXZlXFxuXCIpO1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoXCJkYXRhOlwiKSkgZGF0YUxpbmVzLnB1c2gobGluZS5zbGljZSg1KS50cmltKCkpO1xuICAgICAgICB9XG4gICAgICAgIGlmICghZGF0YUxpbmVzLmxlbmd0aCkgY29udGludWU7XG4gICAgICAgIGNvbnN0IHBheWxvYWQgPSBkYXRhTGluZXMuam9pbihcIlxcblwiKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBldiA9IEpTT04ucGFyc2UocGF5bG9hZCkgYXMgeyBpZD86IG51bWJlcjsgdHlwZT86IHN0cmluZyB9O1xuICAgICAgICAgIGlmICh0eXBlb2YgZXYuaWQgPT09IFwibnVtYmVyXCIgJiYgZXYuaWQgPiBzaW5jZSkgc2luY2UgPSBldi5pZDtcbiAgICAgICAgICBpZiAoZXYudHlwZSA9PT0gXCJjbG9zZWRcIikge1xuICAgICAgICAgICAgLy8gUDBmIOKAlCBTSEFQRSBCOiB0aGUgZHJhaW4gY2FsbGJhY2sgcmlkZXMgVEhJUyB3cml0ZSwgc28gaXQgZmlyZXNcbiAgICAgICAgICAgIC8vIG9uIHRoaXMgd3JpdGUncyBjb21wbGV0aW9uLiBOT1QgYSB0cmFpbGluZyBgd3JpdGUoXCJcIiwgY2IpYCDigJQgYVxuICAgICAgICAgICAgLy8gZHJhaW4gY2FsbGJhY2sgY292ZXJzIG9ubHkgaXRzIG93biB3cml0ZSBhbmQgaXMgbm90IGEgYmFycmllclxuICAgICAgICAgICAgLy8gKG1lYXN1cmVkIGJ5dGUtZm9yLWJ5dGUgYXMgYnJva2VuIGFzIG5vIGZpeCksIGFuZCB0aGF0IGlzIGV4YWN0bHlcbiAgICAgICAgICAgIC8vIHRoZSBoZWxwZXIgdGhpcyB3cml0ZS10aGVuLWV4aXQgc2hhcGUgaW52aXRlcy5cbiAgICAgICAgICAgIC8vXG4gICAgICAgICAgICAvLyBQRVItU0lURSBQUkVDT05ESVRJT04sIHJlYWQgYXQgVEhJUyBzaXRlIHJhdGhlciB0aGFuIGNhcnJpZWQgb3ZlclxuICAgICAgICAgICAgLy8gZnJvbSBhIHNpYmxpbmc6IHRoZSBleGl0IHNpdHMgaW5zaWRlIGB3aGlsZSAoIXN0b3BwZWQpYCAtPlxuICAgICAgICAgICAgLy8gYHdoaWxlICh0cnVlKWAgLT4gdGhlIGZyYW1lIGxvb3AsIHNvIGBwcm9jZXNzLmV4aXRDb2RlYCArIGFcbiAgICAgICAgICAgIC8vIG5hdHVyYWwgcmV0dXJuIChzaGFwZSBEKSBkb2VzIE5PVCBsZWF2ZSB0aGUgdGFpbCDigJQgaXQgZmFsbHNcbiAgICAgICAgICAgIC8vIHRocm91Z2ggYW5kIHRoZSBsb29wcyBnbyByb3VuZCBhZ2Fpbi4gVGhlIGV4cGxpY2l0IGByZXR1cm5gIGlzXG4gICAgICAgICAgICAvLyB3aGF0IGV4aXRzIHRoZSBsb29wczsgdGhlIGNhbGxiYWNrIGlzIHdoYXQgZHJhaW5zLiBCb3RoLCBmb3JcbiAgICAgICAgICAgIC8vIGRpZmZlcmVudCByZWFzb25zLlxuICAgICAgICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7cGF5bG9hZH1cXG5gLCAoKSA9PiBwcm9jZXNzLmV4aXQoMCkpO1xuICAgICAgICAgICAgc3RvcHBlZCA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgfVxuICAgICAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke3BheWxvYWR9XFxuYCk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIC8qIHNraXAgbWFsZm9ybWVkIGZyYW1lICovXG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgYXdhaXQgc2xlZXAoZGVsYXkpO1xuICB9XG59XG5cbmZ1bmN0aW9uIGNtZEluZm8oc2Vzc2lvbj86IHN0cmluZykge1xuICBjb25zdCBzID0gcmVhZFNlc3Npb24oc2Vzc2lvbik7XG4gIGlmICghcykgZGllKFwibm8gcnVubmluZyBtYWdwaWUgc2Vzc2lvblwiLCBcIm5vdF9mb3VuZFwiKTtcbiAgcHJpbnRKc29uKHMpO1xufVxuXG5mdW5jdGlvbiBjbWRTZXNzaW9ucygpIHtcbiAgLy8gTWlycm9yIHBlcnNpc3Quc2VydmVyJ3Mgc25hcHNob3QgZGlyIHJlc29sdXRpb24gKGF2b2lkIGltcG9ydGluZyBub2RlOmZzIHBhdGhcbiAgLy8gbG9naWMgdHdpY2UpOiAkTUFHUElFX0hPTUUvc25hcHNob3RzIG9yIH4vLm1hZ3BpZS9zbmFwc2hvdHMuXG4gIGNvbnN0IGhvbWUgPSBwcm9jZXNzLmVudi5NQUdQSUVfSE9NRSA/PyBqb2luKHByb2Nlc3MuZW52LkhPTUUgPz8gXCJcIiwgXCIubWFncGllXCIpO1xuICBjb25zdCBkaXIgPSBqb2luKGhvbWUsIFwic25hcHNob3RzXCIpO1xuICBsZXQgZmlsZXM6IHN0cmluZ1tdO1xuICB0cnkge1xuICAgIGZpbGVzID0gcmVhZGRpclN5bmMoZGlyKS5maWx0ZXIoKGYpID0+IGYuZW5kc1dpdGgoXCIuanNvblwiKSk7XG4gIH0gY2F0Y2gge1xuICAgIHByaW50SnNvbih7IHNlc3Npb25zOiBbXSB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgdHlwZSBSb3cgPSB7IGlkOiBzdHJpbmc7IHRpdGxlOiBzdHJpbmc7IGVsZW1lbnRzOiBudW1iZXI7IG10aW1lOiBudW1iZXIgfTtcbiAgY29uc3Qgcm93czogUm93W10gPSBbXTtcbiAgZm9yIChjb25zdCBmIG9mIGZpbGVzKSB7XG4gICAgY29uc3QgcGF0aCA9IGpvaW4oZGlyLCBmKTtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc3QgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpO1xuICAgICAgcm93cy5wdXNoKHtcbiAgICAgICAgaWQ6IGYucmVwbGFjZSgvXFwuanNvbiQvLCBcIlwiKSxcbiAgICAgICAgdGl0bGU6IHN0LnRpdGxlLFxuICAgICAgICBlbGVtZW50czogQXJyYXkuaXNBcnJheShzdC5lbGVtZW50cykgPyBzdC5lbGVtZW50cy5sZW5ndGggOiAwLFxuICAgICAgICBtdGltZTogc3RhdFN5bmMocGF0aCkubXRpbWVNcyxcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogc2tpcCB1bnJlYWRhYmxlIHNuYXBzaG90ICovXG4gICAgfVxuICB9XG4gIHJvd3Muc29ydCgoYSwgYikgPT4gYi5tdGltZSAtIGEubXRpbWUpO1xuICAvLyBPTkUgSlNPTiBkb2N1bWVudCwgbGlrZSBldmVyeSBvdGhlciBkYXRhIHZlcmIuIFRoaXMgcHJpbnRlZCBhIHByb3NlIHRhYmxlXG4gIC8vIHVudGlsIHRoZSBtYWNoaW5lLW1vZGUgZGVjbGFyYXRpb24gd2VudCBpbiwgYXQgd2hpY2ggcG9pbnQgdGhlIHRvb2wgd2FzXG4gIC8vIGNsYWltaW5nIGBkZWZhdWx0T3V0cHV0OiBcImpzb25cImAgd2hpbGUgYW5zd2VyaW5nIHRoaXMgdmVyYiBpbiBwcm9zZSDigJQgYVxuICAvLyBkZWNsYXJhdGlvbiBpcyBvbmx5IHdvcnRoIHdoYXQgaXRzIGxlYXN0IGhvbmVzdCBwYXRoIG1ha2VzIGl0LlxuICBwcmludEpzb24oeyBzZXNzaW9uczogcm93cyB9KTtcbn1cblxuLy8gYHNvdXJjZSA8aW1hZ2VQYXRoPmAg4oCUIGNvbXB1dGUgc2hhMjU2WzoxNl0gKyBwaXhlbCBzaXplIChCdW4uSW1hZ2UpIGFuZCBwb3N0XG4vLyBzb3VyY2Uuc2V0LiBUaGUgYWdlbnQgcnVucyBkaXNjb3ZlciBzZXBhcmF0ZWx5OyB0aGlzIGp1c3QgcmVnaXN0ZXJzIHRoZSBib2FyZC5cbmFzeW5jIGZ1bmN0aW9uIGNtZFNvdXJjZShzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsIGltYWdlUGF0aDogc3RyaW5nKSB7XG4gIGNvbnN0IGZpbGUgPSBCdW4uZmlsZShpbWFnZVBhdGgpO1xuICBpZiAoIShhd2FpdCBmaWxlLmV4aXN0cygpKSkgZGllKGBpbWFnZSBub3QgZm91bmQ6ICR7aW1hZ2VQYXRofWAsIFwibm90X2ZvdW5kXCIpO1xuICBjb25zdCBieXRlcyA9IG5ldyBVaW50OEFycmF5KGF3YWl0IGZpbGUuYXJyYXlCdWZmZXIoKSk7XG4gIGNvbnN0IHNoYSA9IG5ldyBCdW4uQ3J5cHRvSGFzaGVyKFwic2hhMjU2XCIpLnVwZGF0ZShieXRlcykuZGlnZXN0KFwiaGV4XCIpLnNsaWNlKDAsIDE2KTtcbiAgY29uc3QgbWV0YSA9IGF3YWl0IG5ldyBCdW4uSW1hZ2UoYnl0ZXMpLm1ldGFkYXRhKCk7XG4gIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgIHR5cGU6IFwic291cmNlLnNldFwiLFxuICAgIHBhdGg6IGltYWdlUGF0aCxcbiAgICBzaXplOiBbbWV0YS53aWR0aCA/PyAwLCBtZXRhLmhlaWdodCA/PyAwXSxcbiAgICBzaGEsXG4gIH0pO1xufVxuXG4vLyBgZWxlbWVudC1hZGQgLS1iYm94IFwieDEseTEseDIseTJcIiBbLS1uYW1lIC4uXSBbLS10eXBlIC4uXWAg4oCUIGFnZW50IGJveGVzIGFcbi8vIHJlZ2lvbiBpbmNyZW1lbnRhbGx5IChzb3VyY2UgcGl4ZWxzKS4gTWlycm9ycyB0aGUgdXNlcidzIFwibWFyayBhIG1pc3NlZCByZWdpb25cIi5cbmFzeW5jIGZ1bmN0aW9uIGNtZEVsZW1lbnRBZGQoc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkLCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgcmF3ID0gdHlwZW9mIGZsYWdzLmJib3ggPT09IFwic3RyaW5nXCIgPyBmbGFncy5iYm94IDogXCJcIjtcbiAgY29uc3QgcGFydHMgPSByYXcuc3BsaXQoXCIsXCIpLm1hcCgobikgPT4gcGFyc2VJbnQobi50cmltKCksIDEwKSk7XG4gIGlmIChwYXJ0cy5sZW5ndGggIT09IDQgfHwgcGFydHMuc29tZSgobikgPT4gTnVtYmVyLmlzTmFOKG4pKSkge1xuICAgIGRpZSgndXNhZ2U6IGVsZW1lbnQtYWRkIC0tYmJveCBcIngxLHkxLHgyLHkyXCIgWy0tbmFtZSA8bmFtZT5dIFstLXR5cGUgPHR5cGU+XScpO1xuICB9XG4gIGNvbnN0IGVsZW1lbnQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyBiYm94OiBwYXJ0cyB9O1xuICBpZiAodHlwZW9mIGZsYWdzLm5hbWUgPT09IFwic3RyaW5nXCIpIGVsZW1lbnQubmFtZSA9IGZsYWdzLm5hbWU7XG4gIGlmICh0eXBlb2YgZmxhZ3MudHlwZSA9PT0gXCJzdHJpbmdcIikgZWxlbWVudC50eXBlID0gZmxhZ3MudHlwZTtcbiAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwiZWxlbWVudC5hZGRcIiwgZWxlbWVudCB9KTtcbn1cblxuLy8gYGRpc2NvdmVyYCDigJQgcmVhZCAvc3RhdGUgZm9yIHNvdXJjZS5wYXRoLCBydW4gZGlzY292ZXIudHMgb24gaXQsIGJ1aWxkIHRoZVxuLy8gRWxlbWVudFtdIChzdGF0dXMgXCJwcm9wb3NlZFwiLCBiYm94IGZyb20gdGhlIG1hbmlmZXN0J3MgYmJveF9waXhlbCksIGFuZCBQT1NUXG4vLyBlbGVtZW50cy5zZXQuIFRoZSB3aG9sZSBkaXNjb3ZlcuKGkmJyZWFrZG93biBsb29wIGluIG9uZSBzaG90IChmb3IgdGhlIGFnZW50IG9yIGFcbi8vIHRlc3RlcikuIFJlcXVpcmVzIE9QRU5ST1VURVJfQVBJX0tFWSBpbiB0aGUgZW52aXJvbm1lbnQuXG5hc3luYyBmdW5jdGlvbiBjbWREaXNjb3ZlcihzZXNzaW9uPzogc3RyaW5nKSB7XG4gIGNvbnN0IHMgPSByZXF1aXJlU2Vzc2lvbihzZXNzaW9uKTtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaShzLnBvcnQsIFwiR0VUXCIsIFwiL3N0YXRlXCIpO1xuICBpZiAoc3RhdHVzICE9PSAyMDApIGRpZShgc3RhdGUgZmFpbGVkIChIVFRQICR7c3RhdHVzfSlgLCBcImludGVybmFsXCIpO1xuICBjb25zdCBzcmMgPSAoZGF0YSBhcyB7IHN0YXRlPzogeyBzb3VyY2U/OiB7IHBhdGg/OiBzdHJpbmcgfSB9IH0pLnN0YXRlPy5zb3VyY2U7XG4gIGNvbnN0IHBhdGggPSBzcmM/LnBhdGg7XG4gIGlmICghcGF0aCkgZGllKFwibm8gc291cmNlIHNldCDigJQgZHJvcCBhIGNvbXBvc2l0ZSAob3IgcnVuOiBzb3VyY2UgPGltYWdlUGF0aD4pIGZpcnN0XCIsIFwiY29uZmxpY3RcIik7XG4gIGxldCBtYW5pZmVzdDogQXdhaXRlZDxSZXR1cm5UeXBlPHR5cGVvZiBkaXNjb3Zlcj4+O1xuICB0cnkge1xuICAgIG1hbmlmZXN0ID0gYXdhaXQgZGlzY292ZXIocGF0aCk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBpZiAoZSBpbnN0YW5jZW9mIERpc2NvdmVyRXJyb3IpIGRpZShgZGlzY292ZXIgZmFpbGVkOiAke2UubWVzc2FnZX1gLCBcImludGVybmFsXCIpO1xuICAgIHRocm93IGU7XG4gIH1cbiAgY29uc3QgZWxlbWVudHM6IEVsZW1lbnRbXSA9IG1hbmlmZXN0LmVsZW1lbnRzLm1hcCgoZSkgPT4gKHtcbiAgICBpZDogbmV3SWQoXCJlXCIpLFxuICAgIG5hbWU6IGUubmFtZSxcbiAgICB0eXBlOiBlLnR5cGUsXG4gICAgYmJveDogZS5iYm94X3BpeGVsLFxuICAgIHN0YXR1czogXCJwcm9wb3NlZFwiLFxuICB9KSk7XG4gIGNvbnN0IGNvc3QgPSBtYW5pZmVzdC5jb3N0X3VzZCA/IGAg4oCUICQke21hbmlmZXN0LmNvc3RfdXNkLnRvRml4ZWQoNCl9YCA6IFwiXCI7XG4gIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBtYWdwaWU6IGRpc2NvdmVyZWQgJHtlbGVtZW50cy5sZW5ndGh9IGVsZW1lbnQocykgb24gJHtwYXRofSR7Y29zdH1cXG5gKTtcbiAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwiZWxlbWVudHMuc2V0XCIsIGVsZW1lbnRzIH0pO1xufVxuXG4vLyBNaXJyb3IgcmVtb3ZlLnB5J3Mgc2FmZV9maWxlbmFtZSBzbyB0aGUgY3V0b3V0IGZpbGVuYW1lIGlzIHN0YWJsZSArIHRyYXZlcnNhbC1cbi8vIHNhZmUgKHRoZSBzdXJmYWNlIHNlcnZlcyBpdCB2aWEgL2Fzc2V0cy88YmFzZW5hbWU+KS5cbmZ1bmN0aW9uIHNhbml0aXplKG5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGNsZWFuZWQgPSBBcnJheS5mcm9tKG5hbWUgfHwgXCJcIilcbiAgICAubWFwKChjKSA9PiAoL1tBLVphLXowLTlcXC1fLl0vLnRlc3QoYykgPyBjIDogXCJfXCIpKVxuICAgIC5qb2luKFwiXCIpXG4gICAgLnJlcGxhY2UoL15cXC4rLywgXCJcIik7IC8vIG5vIGhpZGRlbiBkb3RmaWxlc1xuICByZXR1cm4gY2xlYW5lZCB8fCBcImVsZW1lbnRcIjtcbn1cblxuLy8gVGhlIG9uLWRpc2sgZmlsZW5hbWUgZm9yIGEgdmVyc2lvbjogZWFjaCBNT0RFTCBnZXRzIGl0cyBvd24gZmlsZSBzbyB2ZXJzaW9uc1xuLy8gZG9uJ3Qgb3ZlcndyaXRlIGVhY2ggb3RoZXIgYW5kIGRvbid0IGNvbGxpZGUgaW4gdGhlIGJyb3dzZXIgY2FjaGUgKHR3byB2ZXJzaW9uc1xuLy8gYXQgdGhlIHNhbWUgVVJMIHdvdWxkIHNob3cgYSBzdGFsZSBpbWFnZSkuIFRoZSByYXcgY3JvcCBrZWVwcyB0aGUgYmFyZVxuLy8gYDxuYW1lPi5wbmdgOyBldmVyeSByZW1vdmFsIG1vZGVsIGlzIHN1ZmZpeGVkIGA8bmFtZT4uPG1vZGVsPi5wbmdgLlxuZXhwb3J0IGZ1bmN0aW9uIGN1dG91dEZpbGVuYW1lKG5hbWU6IHN0cmluZywgYmFja2VuZDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke3Nhbml0aXplKG5hbWUpfSR7YmFja2VuZCA9PT0gXCJjcm9wXCIgPyBcIlwiIDogYC4ke2JhY2tlbmR9YH0ucG5nYDtcbn1cblxuLy8gYGV4dHJhY3QgWy0taWRzIGEsYl0gWy0tcmVtb3ZlXSBbLS1hbHBoYSBhdXRvfGFsbHxub25lXSBbLS1wYWQgTl1gIOKAlCBjdXQgYVxuLy8gc2xpY2UgZm9yIGV2ZXJ5IG5vbi1kcm9wcGVkIGVsZW1lbnQgKG9yIGp1c3QgYC0taWRzYCwgb24gcmUtY3V0KS4gREVGQVVMVCBpc1xuLy8gQ1JPUC1PTkxZIChhIHJhdyBQaWxsb3cgc2xpY2UsIG5vIGJhY2tncm91bmQgcmVtb3ZhbCDihpIgYmFja2VuZCBsYWJlbCBcImNyb3BcIikuXG4vLyBgLS1yZW1vdmVgIHN3aXRjaGVzIG9uIHJlbWJnIGJhY2tncm91bmQgcmVtb3ZhbCAoLS1hbHBoYSBhdXRvIOKGkiBiYWNrZW5kXG4vLyBcInJlbWJnXCIpIGZvciB0aGUgbmV4dCBwaGFzZTsgYW4gZXhwbGljaXQgYC0tYWxwaGFgIG92ZXJyaWRlcyB0aGUgcG9saWN5LlxuLy8gUmVhZHMgL3N0YXRlIGZvciBzb3VyY2UucGF0aCArIGVsZW1lbnRzLCBjdXRzIGVhY2ggdmlhIHJlbWJnQmFja2VuZCAo4oaSXG4vLyByZW1vdmUucHkpLCBhbmQgcG9zdHMgdGhlIHJlc3VsdCBiYWNrIHdpdGggZWxlbWVudC5hZGRWZXJzaW9uLiBTZXRzIHRoZSBidXN5XG4vLyBzcGlubmVyIGFyb3VuZCB0aGUgbG9vcDsgcGVyLWVsZW1lbnQgcHJvZ3Jlc3Mg4oaSIHN0ZGVyciwgc3VtbWFyeSDihpIgc3Rkb3V0LlxuYXN5bmMgZnVuY3Rpb24gY21kRXh0cmFjdChzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsIGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPikge1xuICBjb25zdCBzID0gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbik7XG4gIGlmICghcy5maWxlc19kaXIpIGRpZShcInNlc3Npb24gaGFzIG5vIGZpbGVzX2RpciDigJQgY2Fubm90IG1hdGVyaWFsaXplIGN1dG91dHNcIiwgXCJjb25mbGljdFwiKTtcblxuICAvLyBQb2xpY3k6IGNyb3Atb25seSBieSBkZWZhdWx0OyAtLXJlbW92ZSBmbGlwcyB0byByZW1iZyAoYXV0byk7IC0tYWxwaGEgd2lucy5cbiAgbGV0IGFscGhhOiBBbHBoYVBvbGljeSA9IGZsYWdzLnJlbW92ZSA9PT0gdHJ1ZSA/IFwiYXV0b1wiIDogXCJub25lXCI7XG4gIGlmICh0eXBlb2YgZmxhZ3MuYWxwaGEgPT09IFwic3RyaW5nXCIpIHtcbiAgICBpZiAoIVtcImF1dG9cIiwgXCJhbGxcIiwgXCJub25lXCJdLmluY2x1ZGVzKGZsYWdzLmFscGhhKSkge1xuICAgICAgZGllKGAtLWFscGhhIG11c3QgYmUgYXV0b3xhbGx8bm9uZSAoZ290ICR7ZmxhZ3MuYWxwaGF9KWApO1xuICAgIH1cbiAgICBhbHBoYSA9IGZsYWdzLmFscGhhIGFzIEFscGhhUG9saWN5O1xuICB9XG4gIC8vIFRoZSB2ZXJzaW9uIGxhYmVsID0gdGhlIHJlbW92YWwgTU9ERUw6IFwiY3JvcFwiIChubyByZW1vdmFsKSwgXCJyZW1iZ1wiIChyZW1iZydzXG4gIC8vIGRlZmF1bHQgdTJuZXQpLCBvciBhIHNwZWNpZmljIHJlbWJnIG1vZGVsIG5hbWUgb24gYSByZXRyeSAoLS1tb2RlbCwgZS5nLlxuICAvLyBpc25ldC1nZW5lcmFsLXVzZSkuIEVhY2ggbGFiZWwg4oaSIGl0cyBvd24gZmlsZSAoY3V0b3V0RmlsZW5hbWUpIHNvIHZlcnNpb25zXG4gIC8vIGNvZXhpc3QgKyBkb24ndCBjYWNoZS1jb2xsaWRlOyBhZGRWZXJzaW9uIHVwc2VydHMgYnkgdGhpcyBsYWJlbC5cbiAgY29uc3QgcmVxTW9kZWwgPSB0eXBlb2YgZmxhZ3MubW9kZWwgPT09IFwic3RyaW5nXCIgPyBmbGFncy5tb2RlbCA6IHVuZGVmaW5lZDtcbiAgLy8gUm91dGUgYnkgaWQgU0hBUEUsIG5ldmVyIGEgaGFyZGNvZGVkIG1vZGVsIGxpc3Q6IGEgbWVkaWEtZm9yZ2UgaWQgaXMgYVxuICAvLyBwcm92aWRlciBwYXRoIChoYXMgXCIvXCIpOyBhIGJhcmUgbmFtZSBpcyBhIHJlbWJnIG1vZGVsLiBUaGUgYWdlbnQgZGlzY292ZXJzXG4gIC8vIG1lZGlhLWZvcmdlIGJnLXJlbW92ZSBpZHMgdmlhIGBtZWRpYS1mb3JnZSBtb2RlbHMgbGlzdGAgYW5kIHBhc3NlcyBvbmUgaGVyZS5cbiAgY29uc3QgdXNlTWVkaWFGb3JnZSA9IHJlcU1vZGVsID8gaXNNZWRpYUZvcmdlTW9kZWwocmVxTW9kZWwpIDogZmFsc2U7XG4gIGNvbnN0IHJlbWJnTW9kZWwgPSByZXFNb2RlbCAmJiAhdXNlTWVkaWFGb3JnZSA/IHJlcU1vZGVsIDogdW5kZWZpbmVkO1xuICAvLyBUaGUgdmVyc2lvbiBsYWJlbCAoaXRzIHN0cmlwIHJvdyArIGZpbGVuYW1lKS4gRnJpZW5kbHk6IGV4cGxpY2l0IC0tbGFiZWwgd2lucztcbiAgLy8gZWxzZSBmb3IgYSBtZWRpYS1mb3JnZSBwYXRoIGlkIHVzZSB0aGUgc2VnbWVudCBhZnRlciB0aGUgdmVuZG9yOyBlbHNlIHRoZVxuICAvLyBtb2RlbCBuYW1lLiBjcm9wLW9ubHkgaGFzIG5vIG1vZGVsLlxuICBjb25zdCBleHBsaWNpdExhYmVsID0gdHlwZW9mIGZsYWdzLmxhYmVsID09PSBcInN0cmluZ1wiID8gZmxhZ3MubGFiZWwgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IGxhYmVsID1cbiAgICBhbHBoYSA9PT0gXCJub25lXCJcbiAgICAgID8gXCJjcm9wXCJcbiAgICAgIDogKGV4cGxpY2l0TGFiZWwgPz9cbiAgICAgICAgKHVzZU1lZGlhRm9yZ2UgPyAoKHJlcU1vZGVsIGFzIHN0cmluZykuc3BsaXQoXCIvXCIpWzFdID8/IFwiY2xvdWRcIikgOiAocmVxTW9kZWwgPz8gXCJyZW1iZ1wiKSkpO1xuICAvLyBEZWZhdWx0IHBhZCA9IDA6IHRoZSBzbGljZSBtdXN0IG1hdGNoIHRoZSBib3ggdGhlIHVzZXIgZHJldyAoV1lTSVdZRykuIFRoZSBib3hcbiAgLy8gSVMgdGhlIHBhZGRpbmcgY29udHJvbCDigJQgZHJhZyBhIGhhbmRsZSBvdXQgZm9yIGJyZWF0aGluZyByb29tLiAocmVtb3ZlLnB5J3Mgb3duXG4gIC8vIGRlZmF1bHQgaXMgOCwgc28gd2UgTVVTVCBwYXNzIGFuIGV4cGxpY2l0IDAsIG5vdCB1bmRlZmluZWQuKSAtLXBhZCBvdmVycmlkZXMuXG4gIGNvbnN0IHBhZCA9IHR5cGVvZiBmbGFncy5wYWQgPT09IFwic3RyaW5nXCIgPyBwYXJzZUludChmbGFncy5wYWQsIDEwKSA6IDA7XG4gIGlmIChOdW1iZXIuaXNOYU4ocGFkKSkgZGllKFwiLS1wYWQgbXVzdCBiZSBhIG51bWJlclwiKTtcbiAgY29uc3QgaWRGaWx0ZXIgPVxuICAgIHR5cGVvZiBmbGFncy5pZHMgPT09IFwic3RyaW5nXCJcbiAgICAgID8gbmV3IFNldChcbiAgICAgICAgICBmbGFncy5pZHNcbiAgICAgICAgICAgIC5zcGxpdChcIixcIilcbiAgICAgICAgICAgIC5tYXAoKHgpID0+IHgudHJpbSgpKVxuICAgICAgICAgICAgLmZpbHRlcihCb29sZWFuKSxcbiAgICAgICAgKVxuICAgICAgOiB1bmRlZmluZWQ7XG5cbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaShzLnBvcnQsIFwiR0VUXCIsIFwiL3N0YXRlXCIpO1xuICBpZiAoc3RhdHVzICE9PSAyMDApIGRpZShgc3RhdGUgZmFpbGVkIChIVFRQICR7c3RhdHVzfSlgLCBcImludGVybmFsXCIpO1xuICBjb25zdCBzdCA9IChkYXRhIGFzIHsgc3RhdGU/OiB7IHNvdXJjZT86IHsgcGF0aD86IHN0cmluZyB9OyBlbGVtZW50cz86IEVsZW1lbnRbXSB9IH0pLnN0YXRlO1xuICBjb25zdCBzb3VyY2VQYXRoID0gc3Q/LnNvdXJjZT8ucGF0aDtcbiAgaWYgKCFzb3VyY2VQYXRoKVxuICAgIGRpZShcIm5vIHNvdXJjZSBzZXQg4oCUIGRyb3AgYSBjb21wb3NpdGUgKG9yIHJ1bjogc291cmNlIDxpbWFnZVBhdGg+KSBmaXJzdFwiLCBcImNvbmZsaWN0XCIpO1xuICBsZXQgZWxlbWVudHMgPSAoc3Q/LmVsZW1lbnRzID8/IFtdKS5maWx0ZXIoKGUpID0+IGUuc3RhdHVzICE9PSBcImRyb3BwZWRcIik7XG4gIGlmIChpZEZpbHRlcikgZWxlbWVudHMgPSBlbGVtZW50cy5maWx0ZXIoKGUpID0+IGlkRmlsdGVyLmhhcyhlLmlkKSk7XG4gIC8vIFdoZW4gUkVNT1ZJTkcsIG5ldmVyIHRvdWNoIGFscGhhLWZvcmJpZGRlbiB0eXBlcyAocGFsZXR0ZSAvIHNjcmVlbnNob3QgL1xuICAvLyB0eXBvZ3JhcGh5KSDigJQgdGhleSBzdGF5IHdob2xlIGJ5IHBvbGljeS4gU2tpcCB0aGVtIHNvIHdlIGRvbid0IHdyaXRlIGFcbiAgLy8gbWlzbGFiZWxlZCwgcmVkdW5kYW50IFwicmVtb3ZhbFwiIHZlcnNpb24gdGhhdCdzIHJlYWxseSBqdXN0IHRoZSBjcm9wLlxuICBsZXQga2VwdFdob2xlID0gMDtcbiAgaWYgKGFscGhhICE9PSBcIm5vbmVcIikge1xuICAgIGNvbnN0IGJlZm9yZSA9IGVsZW1lbnRzLmxlbmd0aDtcbiAgICBlbGVtZW50cyA9IGVsZW1lbnRzLmZpbHRlcigoZSkgPT4gc2hvdWxkUmVtb3ZlKGUudHlwZSwgYWxwaGEpKTtcbiAgICBrZXB0V2hvbGUgPSBiZWZvcmUgLSBlbGVtZW50cy5sZW5ndGg7XG4gIH1cbiAgaWYgKCFlbGVtZW50cy5sZW5ndGgpIHtcbiAgICBkaWUoXG4gICAgICBrZXB0V2hvbGUgPiAwXG4gICAgICAgID8gYG5vdGhpbmcgdG8gcmVtb3ZlIOKAlCAke2tlcHRXaG9sZX0gc2VsZWN0ZWQgZWxlbWVudCR7a2VwdFdob2xlID09PSAxID8gXCIgaXMgYVwiIDogXCJzIGFyZVwifSBrZXB0LXdob2xlIHR5cGUke2tlcHRXaG9sZSA9PT0gMSA/IFwiXCIgOiBcInNcIn0gKHBhbGV0dGUvc2NyZWVuc2hvdC90eXBvZ3JhcGh5KWBcbiAgICAgICAgOiBpZEZpbHRlclxuICAgICAgICAgID8gXCJubyBtYXRjaGluZyBleHRyYWN0YWJsZSBlbGVtZW50cyBmb3IgLS1pZHNcIlxuICAgICAgICAgIDogXCJubyBleHRyYWN0YWJsZSBlbGVtZW50cyAoYWxsIGRyb3BwZWQgb3Igbm9uZSBkaXNjb3ZlcmVkKVwiLFxuICAgICk7XG4gIH1cblxuICBhd2FpdCBhcGkocy5wb3J0LCBcIlBPU1RcIiwgXCIvY21kXCIsIHsgdHlwZTogXCJzdGF0dXNcIiwgYnVzeTogdHJ1ZSwgdGV4dDogXCJleHRyYWN0aW5n4oCmXCIgfSk7XG4gIGxldCBkb25lID0gMDtcbiAgbGV0IGZhaWxlZCA9IDA7XG4gIHRyeSB7XG4gICAgZm9yIChjb25zdCBlbCBvZiBlbGVtZW50cykge1xuICAgICAgY29uc3Qgb3V0UGF0aCA9IGpvaW4ocy5maWxlc19kaXIsIGN1dG91dEZpbGVuYW1lKGVsLm5hbWUsIGxhYmVsKSk7XG4gICAgICB0cnkge1xuICAgICAgICAvLyBDbG91ZCAobWVkaWEtZm9yZ2UpIHJ1bnMgb24gdGhlIGVsZW1lbnQncyBleGlzdGluZyBjcm9wIGltYWdlIChzaW5nbGUtXG4gICAgICAgIC8vIGltYWdlIHRyYW5zZm9ybSk7IHJlbWJnIGNyb3BzIHRoZSBiYm94IGZyb20gdGhlIHNvdXJjZSBpdHNlbGYuXG4gICAgICAgIGNvbnN0IGN1dG91dCA9IHVzZU1lZGlhRm9yZ2VcbiAgICAgICAgICA/IGF3YWl0IG1lZGlhRm9yZ2VCYWNrZW5kLmN1dChcbiAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIHNvdXJjZVBhdGg6IGpvaW4ocy5maWxlc19kaXIsIGN1dG91dEZpbGVuYW1lKGVsLm5hbWUsIFwiY3JvcFwiKSksXG4gICAgICAgICAgICAgICAgYmJveDogZWwuYmJveCxcbiAgICAgICAgICAgICAgICB0eXBlOiBlbC50eXBlLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICBvdXRQYXRoLFxuICAgICAgICAgICAgICB7IG1vZGVsOiByZXFNb2RlbCB9LFxuICAgICAgICAgICAgKVxuICAgICAgICAgIDogYXdhaXQgcmVtYmdCYWNrZW5kLmN1dCh7IHNvdXJjZVBhdGgsIGJib3g6IGVsLmJib3gsIHR5cGU6IGVsLnR5cGUgfSwgb3V0UGF0aCwge1xuICAgICAgICAgICAgICBhbHBoYSxcbiAgICAgICAgICAgICAgcGFkLFxuICAgICAgICAgICAgICBtb2RlbDogcmVtYmdNb2RlbCxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICBhd2FpdCBhcGkocy5wb3J0LCBcIlBPU1RcIiwgXCIvY21kXCIsIHtcbiAgICAgICAgICB0eXBlOiBcImVsZW1lbnQuYWRkVmVyc2lvblwiLFxuICAgICAgICAgIGlkOiBlbC5pZCxcbiAgICAgICAgICAvLyBhZGRWZXJzaW9uIHVwc2VydHMgYnkgbW9kZWwgKGJ1bXBzIHJldiDihpIgY2FjaGUtYnVzdCkgYW5kIGNsZWFycyB0aGVcbiAgICAgICAgICAvLyBmbGFnOyBjcm9wID0gcmF3LCByZW1iZyBtb2RlbCA9IGxvY2FsLCBtZWRpYS1mb3JnZSA9IGNsb3VkLlxuICAgICAgICAgIHZlcnNpb246IHtcbiAgICAgICAgICAgIGlkOiBuZXdJZChcInZcIiksXG4gICAgICAgICAgICBtb2RlbDogbGFiZWwsIC8vIFwiY3JvcFwiIHwgXCJyZW1iZ1wiIHwgPHJlbWJnIG1vZGVsPiB8IDxtZWRpYS1mb3JnZSBsYWJlbD5cbiAgICAgICAgICAgIGtpbmQ6IGxhYmVsID09PSBcImNyb3BcIiA/IFwicmF3XCIgOiB1c2VNZWRpYUZvcmdlID8gXCJjbG91ZFwiIDogXCJsb2NhbFwiLFxuICAgICAgICAgICAgcGF0aDogY3V0b3V0LnBhdGgsXG4gICAgICAgICAgICByZXY6IDAsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBjaG9vc2U6IHRydWUsXG4gICAgICAgIH0pO1xuICAgICAgICBkb25lKys7XG4gICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBtYWdwaWU6IGN1dCAke2VsLm5hbWV9ICgke2VsLnR5cGV9LCAke2xhYmVsfSkg4oaSICR7Y3V0b3V0LnBhdGh9XFxuYCk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGZhaWxlZCsrO1xuICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICBgbWFncGllOiBjdXQgRkFJTEVEIGZvciAke2VsLm5hbWV9OiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1cXG5gLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cbiAgfSBmaW5hbGx5IHtcbiAgICBhd2FpdCBhcGkocy5wb3J0LCBcIlBPU1RcIiwgXCIvY21kXCIsIHsgdHlwZTogXCJzdGF0dXNcIiwgYnVzeTogZmFsc2UgfSk7XG4gIH1cbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGN1dDogZG9uZSwgZmFpbGVkLCB0b3RhbDogZWxlbWVudHMubGVuZ3RoLCBrZXB0V2hvbGUsIG1vZGVsOiBsYWJlbCB9KTtcbn1cblxuZnVuY3Rpb24gZXNjYXBlSHRtbChzOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gcy5yZXBsYWNlKFxuICAgIC9bJjw+XCJdL2csXG4gICAgKGMpID0+ICh7IFwiJlwiOiBcIiZhbXA7XCIsIFwiPFwiOiBcIiZsdDtcIiwgXCI+XCI6IFwiJmd0O1wiLCAnXCInOiBcIiZxdW90O1wiIH0pW2NdIGFzIHN0cmluZyxcbiAgKTtcbn1cblxudHlwZSBNYW5pZmVzdEFzc2V0ID0ge1xuICBuYW1lOiBzdHJpbmc7XG4gIHR5cGU6IHN0cmluZztcbiAgbW9kZWw6IHN0cmluZztcbiAga2luZDogc3RyaW5nIHwgbnVsbDtcbiAgYmJveDogbnVtYmVyW107XG4gIGZpbGU6IHN0cmluZztcbiAgY3JvcDogc3RyaW5nIHwgbnVsbDtcbn07XG5cbi8vIEEgc2VsZi1jb250YWluZWQgY29udGFjdCBzaGVldCAobWFncGllIGNyZWFtIGlkZW50aXR5KSDigJQgb3BlbiBpbiBhIGJyb3dzZXIsIG5vXG4vLyBkZXBzLiBCYWNrZHJvcCB0b2dnbGUgKGNoZWNrZXIvd2hpdGUvZ3JheS9ibGFjaykgdG8ganVkZ2UgdHJhbnNwYXJlbmN5LCBhbmRcbi8vIHR5cGUgZmlsdGVycyBidWlsdCBmcm9tIHRoZSB0YXhvbm9teSB3ZSB0YWdnZWQgZHVyaW5nIHRoZSBydW4uIGBhLmZpbGVgIGlzIHRoZVxuLy8gaW4temlwIHBhdGggKGFzc2V0cy88bmFtZT4ucG5nKS5cbmZ1bmN0aW9uIGJ1aWxkR2FsbGVyeUh0bWwodGl0bGU6IHN0cmluZywgYXNzZXRzOiBNYW5pZmVzdEFzc2V0W10pOiBzdHJpbmcge1xuICBjb25zdCB0eXBlcyA9IFsuLi5uZXcgU2V0KGFzc2V0cy5tYXAoKGEpID0+IGEudHlwZSkpXS5zb3J0KCk7XG4gIGNvbnN0IHR5cGVDaGlwcyA9IFtcImFsbFwiLCAuLi50eXBlc11cbiAgICAubWFwKCh0KSA9PiB7XG4gICAgICBjb25zdCBuID0gdCA9PT0gXCJhbGxcIiA/IGFzc2V0cy5sZW5ndGggOiBhc3NldHMuZmlsdGVyKChhKSA9PiBhLnR5cGUgPT09IHQpLmxlbmd0aDtcbiAgICAgIHJldHVybiBgPGJ1dHRvbiBjbGFzcz1cImNoaXAke3QgPT09IFwiYWxsXCIgPyBcIiBhY3RpdmVcIiA6IFwiXCJ9XCIgZGF0YS1maWx0ZXI9XCIke2VzY2FwZUh0bWwodCl9XCI+JHtlc2NhcGVIdG1sKHQpfSA8c3BhbiBjbGFzcz1cIm5cIj4ke259PC9zcGFuPjwvYnV0dG9uPmA7XG4gICAgfSlcbiAgICAuam9pbihcIlwiKTtcbiAgY29uc3QgY2FyZHMgPSBhc3NldHNcbiAgICAubWFwKFxuICAgICAgKGEpID0+IGAgICAgICA8ZmlndXJlIGNsYXNzPVwiY2FyZFwiIGRhdGEtdHlwZT1cIiR7ZXNjYXBlSHRtbChhLnR5cGUpfVwiPlxuICAgICAgICA8ZGl2IGNsYXNzPVwidGh1bWJcIj48aW1nIHNyYz1cIiR7ZXNjYXBlSHRtbChhLmZpbGUpfVwiIGFsdD1cIiR7ZXNjYXBlSHRtbChhLm5hbWUpfVwiPjwvZGl2PlxuICAgICAgICA8ZmlnY2FwdGlvbj5cbiAgICAgICAgICA8c3BhbiBjbGFzcz1cIm5hbWVcIj4ke2VzY2FwZUh0bWwoYS5uYW1lKX08L3NwYW4+XG4gICAgICAgICAgPHNwYW4gY2xhc3M9XCJtZXRhXCI+JHtlc2NhcGVIdG1sKGEudHlwZSl9IMK3ICR7ZXNjYXBlSHRtbChhLm1vZGVsKX0ke2Eua2luZCA/IGAgKCR7ZXNjYXBlSHRtbChhLmtpbmQpfSlgIDogXCJcIn08L3NwYW4+XG4gICAgICAgIDwvZmlnY2FwdGlvbj5cbiAgICAgIDwvZmlndXJlPmAsXG4gICAgKVxuICAgIC5qb2luKFwiXFxuXCIpO1xuICByZXR1cm4gYDwhZG9jdHlwZSBodG1sPlxuPGh0bWwgbGFuZz1cImVuXCI+PGhlYWQ+PG1ldGEgY2hhcnNldD1cInV0Zi04XCI+XG48dGl0bGU+JHtlc2NhcGVIdG1sKHRpdGxlKX0g4oCUIG1hZ3BpZSBhc3NldHM8L3RpdGxlPlxuPHN0eWxlPlxuICA6cm9vdCB7IC0tY3JlYW06I2Y2ZjFlNzsgLS1pbms6IzE0MTgxYjsgLS1saW5lOiNlMmQ5YzY7IC0taW5kaWdvOiM1YjViZjA7IH1cbiAgYm9keSB7IGZvbnQtZmFtaWx5Oi1hcHBsZS1zeXN0ZW0sc3lzdGVtLXVpLHNhbnMtc2VyaWY7IGJhY2tncm91bmQ6dmFyKC0tY3JlYW0pOyBjb2xvcjp2YXIoLS1pbmspOyBtYXJnaW46MDsgcGFkZGluZzoyOHB4OyB9XG4gIGgxIHsgZm9udC1zaXplOjIwcHg7IGZvbnQtd2VpZ2h0OjcwMDsgbWFyZ2luOjA7IH0gLmNvdW50IHsgY29sb3I6IzlhOGY3ODsgZm9udC13ZWlnaHQ6NDAwOyB9XG4gIC50b29sYmFyIHsgZGlzcGxheTpmbGV4OyBnYXA6MThweDsgYWxpZ24taXRlbXM6Y2VudGVyOyBmbGV4LXdyYXA6d3JhcDsgbWFyZ2luOjE2cHggMCA0cHg7IH1cbiAgLmdyb3VwIHsgZGlzcGxheTpmbGV4OyBnYXA6NnB4OyBhbGlnbi1pdGVtczpjZW50ZXI7IH1cbiAgLmxhYmVsIHsgZm9udC1zaXplOjExcHg7IGNvbG9yOiM5YThmNzg7IHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsgbGV0dGVyLXNwYWNpbmc6LjA0ZW07IH1cbiAgLyogYmFja2Ryb3AgPSBjb2xvciBzd2F0Y2hlcyAobm90IHdvcmRzKTsgdHJhbnNwYXJlbnQgPSBhIG1pbmkgY2hlY2tlciBzcXVhcmUgKi9cbiAgLnN3IHsgd2lkdGg6MjJweDsgaGVpZ2h0OjIycHg7IHBhZGRpbmc6MDsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTsgYm9yZGVyLXJhZGl1czo1cHg7IGN1cnNvcjpwb2ludGVyOyBib3gtc2l6aW5nOmJvcmRlci1ib3g7IH1cbiAgLnN3LmFjdGl2ZSB7IG91dGxpbmU6MnB4IHNvbGlkIHZhcigtLWluZGlnbyk7IG91dGxpbmUtb2Zmc2V0OjFweDsgfVxuICAuc3cuY2hlY2tlciB7IGJhY2tncm91bmQtY29sb3I6I2ZmZjtcbiAgICBiYWNrZ3JvdW5kLWltYWdlOmxpbmVhci1ncmFkaWVudCg0NWRlZywjYzljOWM5IDI1JSx0cmFuc3BhcmVudCAyNSUpLGxpbmVhci1ncmFkaWVudCgtNDVkZWcsI2M5YzljOSAyNSUsdHJhbnNwYXJlbnQgMjUlKSxsaW5lYXItZ3JhZGllbnQoNDVkZWcsdHJhbnNwYXJlbnQgNzUlLCNjOWM5YzkgNzUlKSxsaW5lYXItZ3JhZGllbnQoLTQ1ZGVnLHRyYW5zcGFyZW50IDc1JSwjYzljOWM5IDc1JSk7XG4gICAgYmFja2dyb3VuZC1zaXplOjhweCA4cHg7IGJhY2tncm91bmQtcG9zaXRpb246MCAwLDAgNHB4LDRweCAtNHB4LC00cHggMDsgfVxuICAvKiBzaXplID0gYSBzbWFsbCBTL00vTCBzZWdtZW50ZWQgY29udHJvbCAqL1xuICAuc2VnIHsgZm9udDppbmhlcml0OyBmb250LXNpemU6MTJweDsgcGFkZGluZzo0cHggOXB4OyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpOyBiYWNrZ3JvdW5kOiNmZmZkZjg7IGNvbG9yOnZhcigtLWluayk7IGN1cnNvcjpwb2ludGVyOyB9XG4gIC5zZWc6Zmlyc3QtY2hpbGQgeyBib3JkZXItcmFkaXVzOjZweCAwIDAgNnB4OyB9IC5zZWc6bGFzdC1jaGlsZCB7IGJvcmRlci1yYWRpdXM6MCA2cHggNnB4IDA7IH0gLnNlZysuc2VnIHsgYm9yZGVyLWxlZnQ6bm9uZTsgfVxuICAuc2VnLmFjdGl2ZSB7IGJhY2tncm91bmQ6dmFyKC0taW5kaWdvKTsgY29sb3I6I2ZmZjsgYm9yZGVyLWNvbG9yOnZhcigtLWluZGlnbyk7IH1cbiAgLmNoaXAgeyBmb250OmluaGVyaXQ7IGZvbnQtc2l6ZToxMnB4OyBwYWRkaW5nOjRweCAxMHB4OyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpOyBib3JkZXItcmFkaXVzOjk5OXB4OyBiYWNrZ3JvdW5kOiNmZmZkZjg7IGNvbG9yOnZhcigtLWluayk7IGN1cnNvcjpwb2ludGVyOyB9XG4gIC5jaGlwLmFjdGl2ZSB7IGJhY2tncm91bmQ6dmFyKC0taW5kaWdvKTsgY29sb3I6I2ZmZjsgYm9yZGVyLWNvbG9yOnZhcigtLWluZGlnbyk7IH1cbiAgLmNoaXAgLm4geyBvcGFjaXR5Oi42OyBtYXJnaW4tbGVmdDoycHg7IH1cbiAgLmdyaWQgeyBkaXNwbGF5OmdyaWQ7IGdyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoYXV0by1maWxsLG1pbm1heCgxNzBweCwxZnIpKTsgZ2FwOjEwcHg7IG1hcmdpbi10b3A6MTZweDsgfVxuICBib2R5W2RhdGEtc2l6ZT1cInNtXCJdIC5ncmlkIHsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdChhdXRvLWZpbGwsbWlubWF4KDEzMnB4LDFmcikpOyB9XG4gIGJvZHlbZGF0YS1zaXplPVwibGdcIl0gLmdyaWQgeyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KGF1dG8tZmlsbCxtaW5tYXgoMjY0cHgsMWZyKSk7IGdhcDoxNHB4OyB9XG4gIC5jYXJkIHsgYmFja2dyb3VuZDojZmZmZGY4OyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpOyBib3JkZXItcmFkaXVzOjEwcHg7IG92ZXJmbG93OmhpZGRlbjsgbWluLXdpZHRoOjA7IH1cbiAgLnRodW1iIHsgaGVpZ2h0OjE2MHB4OyBkaXNwbGF5OmZsZXg7IGFsaWduLWl0ZW1zOmNlbnRlcjsganVzdGlmeS1jb250ZW50OmNlbnRlcjsgYmFja2dyb3VuZC1jb2xvcjojZmZmO1xuICAgIGJhY2tncm91bmQtaW1hZ2U6bGluZWFyLWdyYWRpZW50KDQ1ZGVnLCNlN2UwZDIgMjUlLHRyYW5zcGFyZW50IDI1JSksbGluZWFyLWdyYWRpZW50KC00NWRlZywjZTdlMGQyIDI1JSx0cmFuc3BhcmVudCAyNSUpLGxpbmVhci1ncmFkaWVudCg0NWRlZyx0cmFuc3BhcmVudCA3NSUsI2U3ZTBkMiA3NSUpLGxpbmVhci1ncmFkaWVudCgtNDVkZWcsdHJhbnNwYXJlbnQgNzUlLCNlN2UwZDIgNzUlKTtcbiAgICBiYWNrZ3JvdW5kLXNpemU6MTZweCAxNnB4OyBiYWNrZ3JvdW5kLXBvc2l0aW9uOjAgMCwwIDhweCw4cHggLThweCwtOHB4IDA7IH1cbiAgYm9keVtkYXRhLXNpemU9XCJzbVwiXSAudGh1bWIgeyBoZWlnaHQ6MTEycHg7IH0gYm9keVtkYXRhLXNpemU9XCJsZ1wiXSAudGh1bWIgeyBoZWlnaHQ6MjQwcHg7IH1cbiAgYm9keVtkYXRhLWJnPVwid2hpdGVcIl0gLnRodW1iIHsgYmFja2dyb3VuZDojZmZmIWltcG9ydGFudDsgYmFja2dyb3VuZC1pbWFnZTpub25lIWltcG9ydGFudDsgfVxuICBib2R5W2RhdGEtYmc9XCJncmF5XCJdIC50aHVtYiB7IGJhY2tncm91bmQ6IzhhOGE4YSFpbXBvcnRhbnQ7IGJhY2tncm91bmQtaW1hZ2U6bm9uZSFpbXBvcnRhbnQ7IH1cbiAgYm9keVtkYXRhLWJnPVwiYmxhY2tcIl0gLnRodW1iIHsgYmFja2dyb3VuZDojMTExIWltcG9ydGFudDsgYmFja2dyb3VuZC1pbWFnZTpub25lIWltcG9ydGFudDsgfVxuICAudGh1bWIgaW1nIHsgbWF4LXdpZHRoOjg4JTsgbWF4LWhlaWdodDo4OCU7IG9iamVjdC1maXQ6Y29udGFpbjsgfVxuICBmaWdjYXB0aW9uIHsgcGFkZGluZzo3cHggOXB4OyBkaXNwbGF5OmZsZXg7IGZsZXgtZGlyZWN0aW9uOmNvbHVtbjsgZ2FwOjFweDsgbWluLXdpZHRoOjA7IH1cbiAgLm5hbWUsIC5tZXRhIHsgd2hpdGUtc3BhY2U6bm93cmFwOyBvdmVyZmxvdzpoaWRkZW47IHRleHQtb3ZlcmZsb3c6ZWxsaXBzaXM7IH1cbiAgLm5hbWUgeyBmb250LXNpemU6MTIuNXB4OyBmb250LXdlaWdodDo2MDA7IH0gLm1ldGEgeyBmb250LXNpemU6MTFweDsgY29sb3I6IzZmNmM2NjsgfVxuPC9zdHlsZT48L2hlYWQ+PGJvZHkgZGF0YS1iZz1cImNoZWNrZXJcIiBkYXRhLXNpemU9XCJtZFwiPlxuICA8aDE+8J+QpiAke2VzY2FwZUh0bWwodGl0bGUpfSA8c3BhbiBjbGFzcz1cImNvdW50XCI+4oCUICR7YXNzZXRzLmxlbmd0aH0gYXNzZXQke2Fzc2V0cy5sZW5ndGggPT09IDEgPyBcIlwiIDogXCJzXCJ9PC9zcGFuPjwvaDE+XG4gIDxkaXYgY2xhc3M9XCJ0b29sYmFyXCI+XG4gICAgPGRpdiBjbGFzcz1cImdyb3VwXCI+PHNwYW4gY2xhc3M9XCJsYWJlbFwiPkJhY2tkcm9wPC9zcGFuPlxuICAgICAgPGJ1dHRvbiBjbGFzcz1cInN3IGNoZWNrZXIgYWN0aXZlXCIgZGF0YS1iZy1idG49XCJjaGVja2VyXCIgdGl0bGU9XCJUcmFuc3BhcmVudFwiPjwvYnV0dG9uPlxuICAgICAgPGJ1dHRvbiBjbGFzcz1cInN3XCIgZGF0YS1iZy1idG49XCJ3aGl0ZVwiIHN0eWxlPVwiYmFja2dyb3VuZDojZmZmZmZmXCIgdGl0bGU9XCJXaGl0ZVwiPjwvYnV0dG9uPlxuICAgICAgPGJ1dHRvbiBjbGFzcz1cInN3XCIgZGF0YS1iZy1idG49XCJncmF5XCIgc3R5bGU9XCJiYWNrZ3JvdW5kOiM4YThhOGFcIiB0aXRsZT1cIkdyYXlcIj48L2J1dHRvbj5cbiAgICAgIDxidXR0b24gY2xhc3M9XCJzd1wiIGRhdGEtYmctYnRuPVwiYmxhY2tcIiBzdHlsZT1cImJhY2tncm91bmQ6IzExMTExMVwiIHRpdGxlPVwiQmxhY2tcIj48L2J1dHRvbj5cbiAgICA8L2Rpdj5cbiAgICA8ZGl2IGNsYXNzPVwiZ3JvdXBcIj48c3BhbiBjbGFzcz1cImxhYmVsXCI+U2l6ZTwvc3Bhbj5cbiAgICAgIDxidXR0b24gY2xhc3M9XCJzZWdcIiBkYXRhLXNpemUtYnRuPVwic21cIiB0aXRsZT1cIlNtYWxsXCI+UzwvYnV0dG9uPlxuICAgICAgPGJ1dHRvbiBjbGFzcz1cInNlZyBhY3RpdmVcIiBkYXRhLXNpemUtYnRuPVwibWRcIiB0aXRsZT1cIk1lZGl1bVwiPk08L2J1dHRvbj5cbiAgICAgIDxidXR0b24gY2xhc3M9XCJzZWdcIiBkYXRhLXNpemUtYnRuPVwibGdcIiB0aXRsZT1cIkxhcmdlXCI+TDwvYnV0dG9uPlxuICAgIDwvZGl2PlxuICAgIDxkaXYgY2xhc3M9XCJncm91cFwiPjxzcGFuIGNsYXNzPVwibGFiZWxcIj5UeXBlPC9zcGFuPiR7dHlwZUNoaXBzfTwvZGl2PlxuICA8L2Rpdj5cbiAgPGRpdiBjbGFzcz1cImdyaWRcIj5cbiR7Y2FyZHN9XG4gIDwvZGl2PlxuICA8c2NyaXB0PlxuICAgIHZhciBib2R5PWRvY3VtZW50LmJvZHk7XG4gICAgZnVuY3Rpb24gd2lyZShzZWwsIGFwcGx5KXsgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbChzZWwpLmZvckVhY2goZnVuY3Rpb24oYil7IGIuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBmdW5jdGlvbigpe1xuICAgICAgYXBwbHkoYik7XG4gICAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKHNlbCkuZm9yRWFjaChmdW5jdGlvbih4KXsgeC5jbGFzc0xpc3QudG9nZ2xlKCdhY3RpdmUnLCB4PT09Yik7IH0pO1xuICAgIH0pOyB9KTsgfVxuICAgIHdpcmUoJ1tkYXRhLWJnLWJ0bl0nLCBmdW5jdGlvbihiKXsgYm9keS5kYXRhc2V0LmJnPWIuZGF0YXNldC5iZ0J0bjsgfSk7XG4gICAgd2lyZSgnW2RhdGEtc2l6ZS1idG5dJywgZnVuY3Rpb24oYil7IGJvZHkuZGF0YXNldC5zaXplPWIuZGF0YXNldC5zaXplQnRuOyB9KTtcbiAgICB2YXIgY2FyZHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY2FyZCcpKTtcbiAgICB3aXJlKCdbZGF0YS1maWx0ZXJdJywgZnVuY3Rpb24oYil7IHZhciB0PWIuZGF0YXNldC5maWx0ZXI7XG4gICAgICBjYXJkcy5mb3JFYWNoKGZ1bmN0aW9uKGMpeyBjLnN0eWxlLmRpc3BsYXk9KHQ9PT0nYWxsJ3x8Yy5kYXRhc2V0LnR5cGU9PT10KT8nJzonbm9uZSc7IH0pOyB9KTtcbiAgPC9zY3JpcHQ+XG48L2JvZHk+PC9odG1sPlxuYDtcbn1cblxuLy8gYGV4cG9ydCBbLS1pZHMgYSxiXWAg4oCUIGJ1aWxkIHRoZSBkb3dubG9hZGFibGUgYXNzZXQgYnVuZGxlIGZyb20gZWFjaCBlbGVtZW50J3Ncbi8vIENIT1NFTiB2ZXJzaW9uOiBzdGFnZSBjbGVhbi1uYW1lZCBQTkdzICgrIHRoZSByYXcgY3JvcCB3aGVuIHRoZSBjaG9zZW4gaXMgYVxuLy8gcmVtb3ZhbCkgKyBtYW5pZmVzdC5qc29uICsgZ2FsbGVyeS5odG1sLCB6aXAgaW50byB0aGUgc2Vzc2lvbiBmaWxlcyBkaXIsIGFuZFxuLy8gcG9zdCBidW5kbGUuc2V0IHNvIHRoZSBzdXJmYWNlIG9mZmVycyBpdCB2aWEgL2Fzc2V0cy88bmFtZT4uIFJlc29sdmVzIHZlcnNpb25cbi8vIGZpbGVzIGJ5IEJBU0VOQU1FIGluIGZpbGVzX2RpciAocm9idXN0IHRvIHN0YWxlIGFic29sdXRlIHBhdGhzIGFmdGVyIGEgcmVzdG9yZSkuXG5hc3luYyBmdW5jdGlvbiBjbWRFeHBvcnQoc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkLCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgcyA9IHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pO1xuICBpZiAoIXMuZmlsZXNfZGlyKSBkaWUoXCJzZXNzaW9uIGhhcyBubyBmaWxlc19kaXIg4oCUIGNhbm5vdCBidWlsZCBhIGJ1bmRsZVwiLCBcImNvbmZsaWN0XCIpO1xuICBjb25zdCBpZEZpbHRlciA9XG4gICAgdHlwZW9mIGZsYWdzLmlkcyA9PT0gXCJzdHJpbmdcIlxuICAgICAgPyBuZXcgU2V0KFxuICAgICAgICAgIGZsYWdzLmlkc1xuICAgICAgICAgICAgLnNwbGl0KFwiLFwiKVxuICAgICAgICAgICAgLm1hcCgoeCkgPT4geC50cmltKCkpXG4gICAgICAgICAgICAuZmlsdGVyKEJvb2xlYW4pLFxuICAgICAgICApXG4gICAgICA6IHVuZGVmaW5lZDtcblxuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpKHMucG9ydCwgXCJHRVRcIiwgXCIvc3RhdGVcIik7XG4gIGlmIChzdGF0dXMgIT09IDIwMCkgZGllKGBzdGF0ZSBmYWlsZWQgKEhUVFAgJHtzdGF0dXN9KWAsIFwiaW50ZXJuYWxcIik7XG4gIGNvbnN0IHN0ID0gKGRhdGEgYXMgeyBzdGF0ZT86IHsgdGl0bGU/OiBzdHJpbmc7IGVsZW1lbnRzPzogRWxlbWVudFtdIH0gfSkuc3RhdGU7XG4gIGxldCBlbGVtZW50cyA9IChzdD8uZWxlbWVudHMgPz8gW10pLmZpbHRlcigoZSkgPT4gZS5zdGF0dXMgIT09IFwiZHJvcHBlZFwiKTtcbiAgaWYgKGlkRmlsdGVyKSBlbGVtZW50cyA9IGVsZW1lbnRzLmZpbHRlcigoZSkgPT4gaWRGaWx0ZXIuaGFzKGUuaWQpKTtcbiAgaWYgKCFlbGVtZW50cy5sZW5ndGgpXG4gICAgZGllKGlkRmlsdGVyID8gXCJubyBtYXRjaGluZyBlbGVtZW50cyBmb3IgLS1pZHNcIiA6IFwibm8gYXNzZXRzIHRvIGV4cG9ydFwiLCBcImNvbmZsaWN0XCIpO1xuICBjb25zdCB0aXRsZSA9IHN0Py50aXRsZSA/PyBcIm1hZ3BpZVwiO1xuXG4gIGNvbnN0IHN0YWdlRGlyID0gam9pbihzLmZpbGVzX2RpciwgXCJidW5kbGUtc3RhZ2VcIik7XG4gIGNvbnN0IHppcE5hbWUgPSBcIm1hZ3BpZS1idW5kbGUuemlwXCI7XG4gIGxldCByZXN1bHQ6IHsgY291bnQ6IG51bWJlciB9IHwgbnVsbCA9IG51bGw7XG4gIGxldCBmYWlsdXJlOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgLy8gVGhlIGBleHBvcnRgIGltcGVyYXRpdmUgc2V0IHN0YXR1cy5idXN5IG9uIHJlY2VpcHQ7IGNsZWFyIGl0IChhbmQgY2xlYW4gdGhlXG4gIC8vIHN0YWdlIGRpcikgb24gRVZFUlkgZXhpdCBwYXRoIOKAlCBvdGhlcndpc2UgdGhlIEV4cG9ydCBvdmVybGF5IHN0aWNrcy5cbiAgdHJ5IHtcbiAgICBybVN5bmMoc3RhZ2VEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICAvLyBGb2xkZXJpemU6IGZpbmFsIGNob3NlbiBhc3NldHMgdW5kZXIgYXNzZXRzLywgcmF3IGNyb3BzIHVuZGVyIGNyb3BzLyDigJQgc28gYVxuICAgIC8vIHdob2xlIGZvbGRlciBjYW4gYmUgZ3JhYmJlZCB3aXRob3V0IHBhcnNpbmcgbWl4ZWQgZmlsZXMuIGNyb3BzLyBpcyBjcmVhdGVkXG4gICAgLy8gbGF6aWx5IChvbmx5IGlmIHNvbWUgaXRlbSBoYXMgYSBzZXBhcmF0ZSByYXcgY3JvcCkuXG4gICAgY29uc3QgYXNzZXRzRGlyID0gam9pbihzdGFnZURpciwgXCJhc3NldHNcIik7XG4gICAgY29uc3QgY3JvcHNEaXIgPSBqb2luKHN0YWdlRGlyLCBcImNyb3BzXCIpO1xuICAgIG1rZGlyU3luYyhhc3NldHNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gICAgY29uc3QgbWFuaWZlc3Q6IE1hbmlmZXN0QXNzZXRbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgZWwgb2YgZWxlbWVudHMpIHtcbiAgICAgIGNvbnN0IGNob3NlbiA9IGNob3NlblZlcnNpb24oZWwpO1xuICAgICAgaWYgKCFjaG9zZW4pIGNvbnRpbnVlO1xuICAgICAgY29uc3QgY2hvc2VuRmlsZSA9IGpvaW4ocy5maWxlc19kaXIsIGJhc2VuYW1lKGNob3Nlbi5wYXRoKSk7XG4gICAgICBpZiAoIWV4aXN0c1N5bmMoY2hvc2VuRmlsZSkpIHtcbiAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYG1hZ3BpZSBleHBvcnQ6IG1pc3NpbmcgZmlsZSBmb3IgJHtlbC5uYW1lfSAoJHtjaG9zZW4ubW9kZWx9KVxcbmApO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGZpbGVCYXNlID0gYCR7c2FuaXRpemUoZWwubmFtZSl9LnBuZ2A7XG4gICAgICBjb3B5RmlsZVN5bmMoY2hvc2VuRmlsZSwgam9pbihhc3NldHNEaXIsIGZpbGVCYXNlKSk7XG4gICAgICAvLyB0aGUgcmF3IGNyb3AgdG9vLCBidXQgb25seSB3aGVuIHRoZSBjaG9zZW4gaXMgYSByZW1vdmFsIChlbHNlIGl0J3MgdGhlXG4gICAgICAvLyBzYW1lIGltYWdlIGFzIHRoZSBhc3NldCkuIFNhbWUgYmFzZSBuYW1lLCBpbiBjcm9wcy8uXG4gICAgICBsZXQgY3JvcFBhdGg6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgICAgaWYgKGNob3Nlbi5tb2RlbCAhPT0gXCJjcm9wXCIpIHtcbiAgICAgICAgY29uc3QgY3JvcEZpbGUgPSBqb2luKHMuZmlsZXNfZGlyLCBjdXRvdXRGaWxlbmFtZShlbC5uYW1lLCBcImNyb3BcIikpO1xuICAgICAgICBpZiAoZXhpc3RzU3luYyhjcm9wRmlsZSkpIHtcbiAgICAgICAgICBta2RpclN5bmMoY3JvcHNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgICAgIGNvcHlGaWxlU3luYyhjcm9wRmlsZSwgam9pbihjcm9wc0RpciwgZmlsZUJhc2UpKTtcbiAgICAgICAgICBjcm9wUGF0aCA9IGBjcm9wcy8ke2ZpbGVCYXNlfWA7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIG1hbmlmZXN0LnB1c2goe1xuICAgICAgICBuYW1lOiBlbC5uYW1lLFxuICAgICAgICB0eXBlOiBlbC50eXBlLFxuICAgICAgICBtb2RlbDogY2hvc2VuLm1vZGVsLFxuICAgICAgICBraW5kOiBjaG9zZW4ua2luZCA/PyBudWxsLFxuICAgICAgICBiYm94OiBlbC5iYm94LFxuICAgICAgICBmaWxlOiBgYXNzZXRzLyR7ZmlsZUJhc2V9YCxcbiAgICAgICAgY3JvcDogY3JvcFBhdGgsXG4gICAgICB9KTtcbiAgICB9XG4gICAgaWYgKCFtYW5pZmVzdC5sZW5ndGgpIHRocm93IG5ldyBFcnJvcihcIm5vIGNob3NlbiBhc3NldHMgZm91bmQgdG8gZXhwb3J0IChmaWxlcyBtaXNzaW5nPylcIik7XG5cbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihzdGFnZURpciwgXCJtYW5pZmVzdC5qc29uXCIpLFxuICAgICAgSlNPTi5zdHJpbmdpZnkoeyB0aXRsZSwgY291bnQ6IG1hbmlmZXN0Lmxlbmd0aCwgYXNzZXRzOiBtYW5pZmVzdCB9LCBudWxsLCAyKSxcbiAgICApO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihzdGFnZURpciwgXCJnYWxsZXJ5Lmh0bWxcIiksIGJ1aWxkR2FsbGVyeUh0bWwodGl0bGUsIG1hbmlmZXN0KSk7XG5cbiAgICAvLyB6aXAgaW50byBmaWxlc19kaXIgKG91dHNpZGUgdGhlIHN0YWdlIHNvIHRoZSBhcmNoaXZlIGlzbid0IHNlbGYtaW5jbHVkZWQpLlxuICAgIGNvbnN0IHppcFBhdGggPSBqb2luKHMuZmlsZXNfZGlyLCB6aXBOYW1lKTtcbiAgICBybVN5bmMoemlwUGF0aCwgeyBmb3JjZTogdHJ1ZSB9KTtcbiAgICBjb25zdCBwcm9jID0gQnVuLnNwYXduKFtcInppcFwiLCBcIi1yXCIsIFwiLXFcIiwgemlwUGF0aCwgXCIuXCJdLCB7XG4gICAgICBjd2Q6IHN0YWdlRGlyLFxuICAgICAgc3Rkb3V0OiBcInBpcGVcIixcbiAgICAgIHN0ZGVycjogXCJwaXBlXCIsXG4gICAgfSk7XG4gICAgY29uc3QgW3plcnIsIHpjb2RlXSA9IGF3YWl0IFByb21pc2UuYWxsKFtuZXcgUmVzcG9uc2UocHJvYy5zdGRlcnIpLnRleHQoKSwgcHJvYy5leGl0ZWRdKTtcbiAgICBpZiAoemNvZGUgIT09IDApIHRocm93IG5ldyBFcnJvcihgemlwIGZhaWxlZCAoZXhpdCAke3pjb2RlfSk6ICR7emVyci50cmltKCl9YCk7XG5cbiAgICBhd2FpdCBhcGkocy5wb3J0LCBcIlBPU1RcIiwgXCIvY21kXCIsIHtcbiAgICAgIHR5cGU6IFwiYnVuZGxlLnNldFwiLFxuICAgICAgbmFtZTogemlwTmFtZSxcbiAgICAgIGNvdW50OiBtYW5pZmVzdC5sZW5ndGgsXG4gICAgfSk7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYG1hZ3BpZTogYnVuZGxlZCAke21hbmlmZXN0Lmxlbmd0aH0gYXNzZXQocykg4oaSICR7emlwUGF0aH1cXG5gKTtcbiAgICByZXN1bHQgPSB7IGNvdW50OiBtYW5pZmVzdC5sZW5ndGggfTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGZhaWx1cmUgPSBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSk7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKHN0YWdlRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgYXdhaXQgYXBpKHMucG9ydCwgXCJQT1NUXCIsIFwiL2NtZFwiLCB7IHR5cGU6IFwic3RhdHVzXCIsIGJ1c3k6IGZhbHNlIH0pO1xuICB9XG5cbiAgaWYgKGZhaWx1cmUgfHwgIXJlc3VsdCkgZGllKGBleHBvcnQgZmFpbGVkOiAke2ZhaWx1cmUgPz8gXCJ1bmtub3duXCJ9YCwgXCJpbnRlcm5hbFwiKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGJ1bmRsZTogemlwTmFtZSwgY291bnQ6IHJlc3VsdC5jb3VudCB9KTtcbn1cblxuY29uc3QgSEVMUCA9IGBtYWdwaWUg4oCUIGEgc3RhbmRpbmcgcmV2aWV3IHN1cmZhY2UgZm9yIGV4dHJhY3RpbmcgYXNzZXRzIGZyb20gYSBjb21wb3NpdGUgaW1hZ2UuXG5cbiAgb3BlbiAgIFstLXRpdGxlIC4uXSBbLS1pbnRlbnQgLi5dIFstLW5vLW9wZW5dIFstLXRpbWVvdXQgU10gWy0tcmVzdG9yZSA8aWR8cGF0aD5dXG4gIHNlc3Npb25zICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxpc3Qgc2F2ZWQgKHJlc3VtYWJsZSkgc2Vzc2lvbnNcbiAgdGFpbCAgIFstLXNpbmNlIE5dICAgICAgICAgICAgICAgICAgU1NFIHVzZXIgZXZlbnRzIOKGkiBKU09OTCAod3JhcCB3aXRoIE1vbml0b3IpXG4gIHN0YXRlICBbLS1mdWxsXSAgICAgICAgICAgICAgICAgICAgIGxlYW4gc3RhdGUgc25hcHNob3QgKGFkZCAtLWZ1bGwgZm9yIHJhdylcbiAgc2F5ICAgIFt0ZXh0Li4uXSBbLS1zdGRpbl0gICAgICAgICAgcG9zdCBhZ2VudCBkaWFsb2d1ZSAodGV4dCBhcmdzIE9SIHBpcGVkIHN0ZGluKVxuICBhc2sgICAgPHRleHQuLi4+IFstLW9wdGlvbnMgXCJhfGJ8Y1wiXSAgIGFzayB0aGUgdXNlciBhIHF1ZXN0aW9uIChpbi10aHJlYWQpXG4gIHN0YXR1cyBvbiBbdGV4dC4uLl0gfCBzdGF0dXMgb2ZmICAgIHNob3cvaGlkZSB0aGUgXCJtYWdwaWUgd29ya2luZ1wiIHNwaW5uZXJcbiAgc291cmNlIDxpbWFnZVBhdGg+ICAgICAgICAgICAgICAgICAgcmVnaXN0ZXIgdGhlIGNvbXBvc2l0ZSB1bmRlciByZXZpZXcgKGNvbXB1dGVzIHNoYSArIHNpemUpXG4gIGRpc2NvdmVyICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJ1biBkaXNjb3ZlciBvbiB0aGUgY3VycmVudCBzb3VyY2Ug4oaSIHBvc3QgdGhlIGJyZWFrZG93biAobmVlZHMgT1BFTlJPVVRFUl9BUElfS0VZKVxuICBleHRyYWN0IFstLWlkcyBhLGJdIFstLXJlbW92ZV0gWy0tYWxwaGEgYXV0b3xhbGx8bm9uZV0gWy0tcGFkIE5dIFstLW1vZGVsIDxtPl0gWy0tbGFiZWwgPG5hbWU+XVxuICAgICAgICAgIGN1dCBzbGljZXMgKGNyb3Atb25seTsgLS1yZW1vdmUgYWRkcyByZW1iZykuIC0tbW9kZWwgPSBhIHJlbWJnIG1vZGVsIG5hbWUgKGlzbmV0LWdlbmVyYWwtdXNlLFxuICAgICAgICAgIGJpcmVmbmV0LWdlbmVyYWwsIOKApikgT1IgYSBtZWRpYS1mb3JnZSBiZy1yZW1vdmUgbW9kZWwgaWQgKGEgcHJvdmlkZXIgcGF0aCBsaWtlXG4gICAgICAgICAgZmFsLWFpL2JyaWEvYmFja2dyb3VuZC9yZW1vdmUg4oCUIERJU0NPVkVSIHZpYSBcXGBtZWRpYS1mb3JnZSBtb2RlbHMgbGlzdFxcYCwgbmV2ZXIgaGFyZGNvZGUpO1xuICAgICAgICAgIC0tbGFiZWwgc2V0cyB0aGUgdmVyc2lvbidzIGZyaWVuZGx5IHN0cmlwIGxhYmVsIChkZWZhdWx0cyBzZW5zaWJseSlcbiAgZXhwb3J0IFstLWlkcyBhLGJdICAgICAgICAgICAgICAgICAgYnVpbGQgbWFncGllLWJ1bmRsZS56aXAg4oCUIGFzc2V0cy8gKGNob3NlbiBmaW5hbHMpICsgY3JvcHMvIChyYXcgY3JvcHMpICsgbWFuaWZlc3QuanNvbiArIGdhbGxlcnkuaHRtbCAoYmFja2Ryb3AgdG9nZ2xlICsgdHlwZSBmaWx0ZXJzKVxuICBlbGVtZW50LWFkZCAtLWJib3ggXCJ4MSx5MSx4Mix5MlwiIFstLW5hbWUgLi5dIFstLXR5cGUgLi5dICAgYm94IGEgcmVnaW9uIChzb3VyY2UgcHgpXG4gIGVsZW1lbnQtcmVtb3ZlIDxpZD4gICAgICAgICAgICAgICAgIHJldHJhY3QgYSBib3hlZCByZWdpb25cbiAgY21kICAgIFstLXN0ZGluXSAgICAgICAgICAgICAgICAgICAgUE9TVCBhIHJhdyBBZ2VudENvbW1hbmQgSlNPTiBib2R5IGZyb20gc3RkaW5cbiAgY2xvc2UgfCBpbmZvIHwgaGVscFxuICAtLXZlcnNpb24gICAgICAgICAgICAgICAgICAgICAgICAgICBwcmludCBtYWdwaWUncyB2ZXJzaW9uIGFzIEpTT05cblxuICBBZGQgLS1zZXNzaW9uIDxpZD4gdG8gdGFyZ2V0IGEgc3BlY2lmaWMgc2Vzc2lvbiAoZGVmYXVsdDogbW9zdCByZWNlbnQpLiBJdCBpc1xuICBhY2NlcHRlZCBieSBldmVyeSB2ZXJiIHRoYXQgYWN0cyBvbiBhIHNlc3Npb24g4oCUIG5vdCBieSBvcGVuLCBzZXNzaW9ucyBvciBoZWxwLFxuICB3aGljaCBkbyBub3QgaGF2ZSBvbmUgdG8gdGFyZ2V0LlxuXG4gIEZsYWdzIGFyZSBzY29wZWQgdG8gdGhlaXIgdmVyYjogZXh0cmFjdCdzIC0tcGFkIGlzIG5vdCBhY2NlcHRlZCBieSBzYXkuIEFcbiAgcmVqZWN0aW9uIGxpc3RzIHdoYXQgdGhlIHZlcmIgaXQgbmFtZXMgZG9lcyBhY2NlcHQuXG5cbiAgT3V0cHV0OiBtYWdwaWUgcHJpbnRzIEpTT04gYnkgZGVmYXVsdCBvbiBzdGRvdXQuIEV2ZXJ5IHZlcmIgd3JpdGVzIE9ORSBKU09OXG4gIGRvY3VtZW50IHRoZXJlIOKAlCBleGNlcHQgXFxgdGFpbFxcYCwgd2hpY2ggaXMgYSBzdHJlYW0gYW5kIHdyaXRlcyBvbmUgcGVyIGxpbmVcbiAgKEpTT05MKS4gUHJvc2UsIGxpdmVuZXNzIGFuZCBkaWFnbm9zdGljcyBnbyB0byBzdGRlcnIuIFxcYC0tZnVsbFxcYFxuICB3aWRlbnMgdGhlIHN0YXRlIHBheWxvYWQ7IGl0IGRvZXMgbm90IHN3aXRjaCBmb3JtYXRzLmA7XG5cbmFzeW5jIGZ1bmN0aW9uIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBbdmVyYiwgLi4ucmVzdF0gPSBhcmd2O1xuICBDVVJSRU5UX0NPTU1BTkQgPSB2ZXJiID8/IG51bGw7XG5cbiAgLy8gUk9PVCBUT0tFTlMgRklSU1QsIGJlZm9yZSBhbnkgZmxhZyBwYXJzaW5nLiBUaGVzZSBhcmUgbm90IHZlcmJzIGFuZCB0aGV5XG4gIC8vIGNhcnJ5IG5vIGZsYWdzLCBzbyByZXNvbHZpbmcgdGhlbSBoZXJlIGtlZXBzIHRoZW0gb3V0IG9mIGV2ZXJ5IHZlcmIncyBzZXQuXG4gIGlmICh2ZXJiID09PSBcIi0taGVscFwiIHx8IHZlcmIgPT09IFwiLWhcIikge1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0hFTFB9XFxuYCk7XG4gICAgcmV0dXJuIDA7XG4gIH1cbiAgaWYgKHZlcmIgPT09IFwiLS12ZXJzaW9uXCIgfHwgdmVyYiA9PT0gXCItVlwiKSB7XG4gICAgcHJpbnRKc29uKHsgbmFtZTogXCJtYWdwaWVcIiwgdmVyc2lvbjogUExVR0lOX1ZFUlNJT04gfSk7XG4gICAgcmV0dXJuIDA7XG4gIH1cbiAgaWYgKHZlcmIgPT09IHVuZGVmaW5lZCkge1xuICAgIC8vIEEgYmFyZSBpbnZvY2F0aW9uIGlzIGEgdXNhZ2UgZXJyb3IsIG5vdCBhIGhlbHAgcGF0aCDigJQgbWFncGllIGlzIGRyaXZlbiBieVxuICAgIC8vIGFuIGFnZW50LCBhbmQgYW4gZW1wdHkgYXJndiBpcyBhbiBhZ2VudCB0aGF0IGZhaWxlZCB0byBuYW1lIHdoYXQgaXRcbiAgICAvLyB3YW50ZWQuIHN0ZG91dCBzdGF5cyBlbXB0eTsgaXQgY2FycmllcyBkYXRhIGFuZCB0aGlzIGhhcyBub25lLlxuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgZXJyb3JFbnZlbG9wZShcInVzYWdlXCIsIFwibm8gdmVyYiBnaXZlblwiLCB7IGhpbnQ6IFwicnVuOiBjbGkudHMgaGVscFwiLCBjaG9pY2VzOiBWRVJCUyB9KSxcbiAgICApO1xuICAgIHJldHVybiAyO1xuICB9XG4gIC8vIFRIRSBWRVJCIElTIFJFSkVDVEVEIEJFRk9SRSBJVFMgRkxBR1MgQVJFIFJFQUQuIEl0IGhhcyB0byBiZTogd2hpY2ggZmxhZ3NcbiAgLy8gYXJlIGxlZ2FsIGlzIGEgcXVlc3Rpb24gYWJvdXQgdGhlIHZlcmIsIHNvIHRoZXJlIGlzIG5vIHNldCB0byBjaGVjayBhZ2FpbnN0XG4gIC8vIHVudGlsIHdlIGtub3cgaXQgaXMgYSByZWFsIG9uZS5cbiAgaWYgKCFpc1ZlcmIodmVyYikpIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgIGVycm9yRW52ZWxvcGUoXCJ1c2FnZVwiLCBgdW5rbm93biB2ZXJiIFwiJHt2ZXJifVwiYCwge1xuICAgICAgICBoaW50OiBcInJ1bjogY2xpLnRzIGhlbHBcIixcbiAgICAgICAgY2hvaWNlczogVkVSQlMsXG4gICAgICB9KSxcbiAgICApO1xuICAgIHJldHVybiAyO1xuICB9XG5cbiAgbGV0IHBvczogc3RyaW5nW107XG4gIGxldCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj47XG4gIHRyeSB7XG4gICAgKHsgcG9zLCBmbGFncyB9ID0gcGFyc2VBcmdzKHJlc3QsIHZlcmIpKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGlmICghKGUgaW5zdGFuY2VvZiBVc2FnZUVycm9yKSkgdGhyb3cgZTtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgIGVycm9yRW52ZWxvcGUoXCJ1c2FnZVwiLCBlLm1lc3NhZ2UsIHtcbiAgICAgICAgaGludDogYGZsYWdzIGFyZSBzY29wZWQgdG8gdGhlIHZlcmIg4oCUIGNob2ljZXMgbGlzdHMgd2hhdCBcXGAke3ZlcmJ9XFxgIGFjY2VwdHM7IGZvciBmcmVlIHRleHQgY29udGFpbmluZyBkYXNoZXMgdXNlIC0tc3RkaW4sIG9yIHB1dCBpdCBhZnRlciBhIGJhcmUgLS1gLFxuICAgICAgICBjaG9pY2VzOiBmbGFnc0Zvcih2ZXJiKSxcbiAgICAgIH0pLFxuICAgICk7XG4gICAgcmV0dXJuIDI7XG4gIH1cbiAgY29uc3Qgc2Vzc2lvbiA9IHR5cGVvZiBmbGFncy5zZXNzaW9uID09PSBcInN0cmluZ1wiID8gZmxhZ3Muc2Vzc2lvbiA6IHVuZGVmaW5lZDtcblxuICBzd2l0Y2ggKHZlcmIpIHtcbiAgICBjYXNlIFwib3BlblwiOlxuICAgICAgYXdhaXQgY21kT3BlbihmbGFncyk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwidGFpbFwiOlxuICAgICAgYXdhaXQgY21kVGFpbChzZXNzaW9uLCB0eXBlb2YgZmxhZ3Muc2luY2UgPT09IFwic3RyaW5nXCIgPyBwYXJzZUludChmbGFncy5zaW5jZSwgMTApIDogLTEpO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcInN0YXRlXCI6XG4gICAgICBhd2FpdCBjbWRTdGF0ZShzZXNzaW9uLCBmbGFncy5mdWxsID09PSB0cnVlKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJzYXlcIjoge1xuICAgICAgY29uc3QgdGV4dCA9IGZsYWdzLnN0ZGluID09PSB0cnVlID8gYXdhaXQgcmVhZFN0ZGluKCkgOiBwb3Muam9pbihcIiBcIik7XG4gICAgICBpZiAoIXRleHQpIGRpZShcInVzYWdlOiBzYXkgPHRleHQuLi4+IHwgc2F5IC0tc3RkaW5cIik7XG4gICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJzYXlcIiwgdGV4dCB9KTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBjYXNlIFwiYXNrXCI6IHtcbiAgICAgIGlmICghcG9zLmxlbmd0aCkgZGllKCd1c2FnZTogYXNrIDx0ZXh0Li4uPiBbLS1vcHRpb25zIFwiYXxifGNcIl0nKTtcbiAgICAgIGNvbnN0IG1zZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IHR5cGU6IFwiYXNrXCIsIHRleHQ6IHBvcy5qb2luKFwiIFwiKSB9O1xuICAgICAgaWYgKHR5cGVvZiBmbGFncy5vcHRpb25zID09PSBcInN0cmluZ1wiKSB7XG4gICAgICAgIG1zZy5vcHRpb25zID0gZmxhZ3Mub3B0aW9uc1xuICAgICAgICAgIC5zcGxpdChcInxcIilcbiAgICAgICAgICAubWFwKChzKSA9PiBzLnRyaW0oKSlcbiAgICAgICAgICAuZmlsdGVyKEJvb2xlYW4pO1xuICAgICAgfVxuICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCBtc2cpO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGNhc2UgXCJzdGF0dXNcIjpcbiAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgICAgICB0eXBlOiBcInN0YXR1c1wiLFxuICAgICAgICBidXN5OiBwb3NbMF0gPT09IFwib25cIixcbiAgICAgICAgdGV4dDogcG9zLnNsaWNlKDEpLmpvaW4oXCIgXCIpLFxuICAgICAgfSk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwic291cmNlXCI6XG4gICAgICBpZiAoIXBvcy5sZW5ndGgpIGRpZShcInVzYWdlOiBzb3VyY2UgPGltYWdlUGF0aD5cIik7XG4gICAgICBhd2FpdCBjbWRTb3VyY2Uoc2Vzc2lvbiwgcG9zWzBdKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJkaXNjb3ZlclwiOlxuICAgICAgYXdhaXQgY21kRGlzY292ZXIoc2Vzc2lvbik7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiZXh0cmFjdFwiOlxuICAgICAgYXdhaXQgY21kRXh0cmFjdChzZXNzaW9uLCBmbGFncyk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiZXhwb3J0XCI6XG4gICAgICBhd2FpdCBjbWRFeHBvcnQoc2Vzc2lvbiwgZmxhZ3MpO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcImVsZW1lbnQtYWRkXCI6XG4gICAgICBhd2FpdCBjbWRFbGVtZW50QWRkKHNlc3Npb24sIGZsYWdzKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJlbGVtZW50LXJlbW92ZVwiOlxuICAgICAgaWYgKCFwb3MubGVuZ3RoKSBkaWUoXCJ1c2FnZTogZWxlbWVudC1yZW1vdmUgPGlkPlwiKTtcbiAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcImVsZW1lbnQucmVtb3ZlXCIsIGlkOiBwb3NbMF0gfSk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiY21kXCI6IHtcbiAgICAgIC8vIFBPU1QgYSByYXcgQWdlbnRDb21tYW5kIEpTT04gYm9keSAoZnJvbSBzdGRpbikg4oCUIHRoZSBlc2NhcGUgaGF0Y2ggZm9yXG4gICAgICAvLyBjb21tYW5kcyBjYXJyeWluZyBOTCB0ZXh0IG9yIHJpY2ggcGF5bG9hZHMgKGUuZy4gZWxlbWVudHMuc2V0KS5cbiAgICAgIGNvbnN0IHJhdyA9IGZsYWdzLnN0ZGluID09PSB0cnVlID8gYXdhaXQgcmVhZFN0ZGluKCkgOiBwb3Muam9pbihcIiBcIik7XG4gICAgICBpZiAoIXJhdykgZGllKFwidXNhZ2U6IGNtZCAtLXN0ZGluICAocGlwZSBhIEpTT04gQWdlbnRDb21tYW5kIGJvZHkpXCIpO1xuICAgICAgbGV0IGJvZHk6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgICAgdHJ5IHtcbiAgICAgICAgYm9keSA9IEpTT04ucGFyc2UocmF3KTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICBkaWUoXCJjbWQ6IGJvZHkgaXMgbm90IHZhbGlkIEpTT05cIik7XG4gICAgICB9XG4gICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIGJvZHkpO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGNhc2UgXCJjbG9zZVwiOlxuICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwiY2xvc2VcIiB9KTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJpbmZvXCI6XG4gICAgICBjbWRJbmZvKHNlc3Npb24pO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcInNlc3Npb25zXCI6XG4gICAgICBjbWRTZXNzaW9ucygpO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcImhlbHBcIjpcbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0hFTFB9XFxuYCk7XG4gICAgICBicmVhaztcbiAgICBkZWZhdWx0OlxuICAgICAgLy8gVU5SRUFDSEFCTEUgQlkgQ09OU1RSVUNUSU9OIOKAlCBgdmVyYmAgaXMgbmFycm93ZWQgdG8gVmVyYiBhYm92ZSwgYW5kIGFcbiAgICAgIC8vIHRlc3QgYmluZHMgVkVSQl9TUEVDJ3Mga2V5cyB0byB0aGlzIHN3aXRjaCdzIGNhc2UgbGFiZWxzLiBLZXB0IGFueXdheTpcbiAgICAgIC8vIGlmIHRoYXQgYmluZGluZyBldmVyIGJyZWFrcywgdGhlIGFsdGVybmF0aXZlIGlzIGZhbGxpbmcgdGhyb3VnaCB0b1xuICAgICAgLy8gYHJldHVybiAwYCB3aXRoIGVtcHR5IHN0ZG91dCwgd2hpY2ggcmVwb3J0cyBzdWNjZXNzIGZvciB3b3JrIG5ldmVyIGRvbmUuXG4gICAgICAvLyBUaGF0IGlzIHRoZSBmYWlsdXJlIHRoaXMgYnJhbmNoIGV4aXN0cyB0byByZW1vdmUsIGFuZCBpdCB3b3VsZCBiZSBzaWxlbnQuXG4gICAgICBkaWUoYG5vIGhhbmRsZXIgZm9yIHZlcmIgXCIke3ZlcmJ9XCJgLCBcImludGVybmFsXCIpO1xuICB9XG5cbiAgcmV0dXJuIDA7XG59XG5cbmlmIChpbXBvcnQubWV0YS5tYWluKSB7XG4gIC8vIGBwcm9jZXNzLmV4aXRDb2RlYCArIGEgbmF0dXJhbCByZXR1cm4sIE5FVkVSIGBwcm9jZXNzLmV4aXQoY29kZSlgOiBCdW4nc1xuICAvLyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGEgcGlwZSAoc3luY2hyb25vdXMgb24gYSBUVFkgb3IgZmlsZSksIHNvIGFuXG4gIC8vIGV4cGxpY2l0IGV4aXQgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlCBtZWFzdXJlZCBhdCBleGFjdGx5XG4gIC8vIDY1LDUzNiBieXRlcy4gVGhlIHBheWxvYWQgaXMgY29tcGxldGUgYW5kIG9ubHkgdGhlIHdyaXRlIGlzIGxvc3QsIHNvIHRoZVxuICAvLyBjYWxsZXIgZ2V0cyB3ZWxsLWZvcm1lZC1sb29raW5nIEpTT04gdGhhdCBzdG9wcyBtaWQtc3RyaW5nLiBSZXByb2R1Y2VkLFxuICAvLyBmaXhlZCBhbmQgZ2F0ZWQgaW4gYm91bnR5IGZpcnN0IChQMCwgIzc3LyM3OCk7IHNhbWUgc2hhcGUsIHNhbWUgcmVhc29uLlxuICAvLyBEbyBub3QgdGlkeSB0aGlzIGJhY2sgaW50byBhbiBleHBsaWNpdCBleGl0LlxuICBwcm9jZXNzLmV4aXRDb2RlID0gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuXG5leHBvcnQgeyBtYWluIH07XG5cbi8qKlxuICogVGhlIFNISVBQRUQgRU5UUlkgUE9JTlQsIGNhbGxlZCBieSBgcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL21hZ3BpZS9zY3JpcHRzL2NsaS50c2BcbiAqIGFmdGVyIHRoZSBidW5kbGUgaXMgaW1wb3J0ZWQuXG4gKlxuICog4puUIElUIFRBS0VTIE5PIEFSR1VNRU5UUywgQU5EIFRIQVQgSVMgVEhFIFBPSU5ULiBhcmd2IGJlbG9uZ3MgdG8gd2hpY2hldmVyIGZpbGVcbiAqIFBBUlNFUyBpdCwgYW5kIHRoYXQgaXMgdGhpcyBvbmUuIEFuIGVhcmxpZXIgbGF1bmNoZXIgcmVhZFxuICogYHByb2Nlc3MuYXJndi5zbGljZSgyKWAgaXRzZWxmIGFuZCBwYXNzZWQgaXQgaW4g4oCUIHdoaWNoIG1hZGUgdGhlIGxhdW5jaGVyIG1hdGNoXG4gKiBgZ3JpbW9pcmUvbGliL2VudHJ5LXBvaW50cy50c2AncyBQQVJTRVNfQVJHUyBwcmVkaWNhdGUgKGBwcm9jZXNzLmFyZ3ZgKSwgc28gdGhlXG4gKiByb3N0ZXIgY291bnRlZCBhIDMtbGluZSBmb3J3YXJkZXIgYXMgYW4gYXJnLXBhcnNpbmcgZW50cnkgcG9pbnQgYW5kIHRoZW5cbiAqIHJlcG9ydGVkIHRoZSBzcGVsbCdzIGRvY3VtZW50ZWQgZmxhZ3MgYXMgVU5SRVNPTFZFRCBhZ2FpbnN0IGEgZmlsZSB0aGF0XG4gKiByZWNvZ25pc2VzIG5vbmUuIEtlZXBpbmcgYXJndiBvbiB0aGlzIHNpZGUgbWFrZXMgdGhlIGVudW1lcmF0b3IncyBhbnN3ZXIgdHJ1ZVxuICogaW5zdGVhZCBvZiBtYWtpbmcgaXRzIHJlZ2V4IGxvb3Nlci5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bigpOiBQcm9taXNlPG51bWJlcj4ge1xuICByZXR1cm4gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuIiwKICAgICIvLyBzY3JpcHRzL2JhY2tlbmQudHNcbi8vIFJlbW92YWwtYmFja2VuZCByZWdpc3RyeS4gVGhlIHJlYnVpbHQgbWFncGllIGNvbXBhcmVzIGJhY2tncm91bmQtcmVtb3ZhbFxuLy8gcmVzdWx0cyBmcm9tIG11bHRpcGxlIGJhY2tlbmRzIHBlciBlbGVtZW50OyB0aGUgdXNlciBwaWNrcyB0aGUgd2lubmVyLiBUaGlzXG4vLyBmaWxlIGRlZmluZXMgdGhlIGNvbnRyYWN0LCB0aGUgKGxpdmUpIHJlbWJnIGltcGwsIGEgbWVkaWEtZm9yZ2Ugc3R1YiBmb3IgdGhlXG4vLyBuZXh0IHN1Yi1waGFzZSwgYW5kIGEgcmVnaXN0cnkuXG4vL1xuLy8gSU1BR0UgT1BTIE5PVEU6IGNyb3BwaW5nIHRoZSBlbGVtZW50J3MgYmJveCBvdXQgb2YgdGhlIHNvdXJjZSBpcyBOT1QgZG9uZSB3aXRoXG4vLyBCdW4uSW1hZ2UgKGl0IGhhcyByZXNpemUvZW5jb2RlL21ldGFkYXRhIGJ1dCBOTyBjcm9wL2V4dHJhY3QpLiByZW1iZ0JhY2tlbmRcbi8vIHNoZWxscyBvdXQgdG8gc2NyaXB0cy9yZW1vdmUucHkgKFBpbGxvdyBjcm9wICsgcmVtYmcpIOKAlCB0aGUgY2FsbGVyIG93bnMgdGhlXG4vLyBvdXRwdXQgcGF0aCAodGhlIHNlc3Npb24gZmlsZXMgZGlyKS5cblxuaW1wb3J0IHsgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbi8vIOKUgOKUgCBhbHBoYSBwb2xpY3kg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vLyBUaGUgdHlwZS1kcml2ZW4gYWxwaGEgcG9saWN5IGxpdmVzIGluIHN1cmZhY2Uvc3RhdGUvYWxwaGEudHMgKGJyb3dzZXItc2FmZSwgc29cbi8vIHRoZSBzdXJmYWNlIHNoYXJlcyBvbmUgc291cmNlIG9mIHRydXRoKS4gUmUtZXhwb3J0ZWQgaGVyZSBmb3IgdGhlIGFnZW50LXNpZGVcbi8vIGNvbnN1bWVycyAoY2xpLnRzLCBiYWNrZW5kIHRlc3RzKSB0aGF0IGltcG9ydCBpdCBmcm9tIHRoaXMgbW9kdWxlLlxuaW1wb3J0IHR5cGUgeyBBbHBoYVBvbGljeSB9IGZyb20gXCIuLi9zdXJmYWNlL3N0YXRlL2FscGhhXCI7XG5pbXBvcnQgdHlwZSB7IEJib3ggfSBmcm9tIFwiLi4vc3VyZmFjZS9zdGF0ZS90eXBlc1wiO1xuXG5leHBvcnQge1xuICBBTFBIQV9BVVRPX1RZUEVTLFxuICBBTFBIQV9GT1JCSURERU5fVFlQRVMsXG4gIHR5cGUgQWxwaGFQb2xpY3ksXG4gIHNob3VsZFJlbW92ZSxcbn0gZnJvbSBcIi4uL3N1cmZhY2Uvc3RhdGUvYWxwaGFcIjtcblxuLy8gQSByZWdpb24gb2YgdGhlIHNvdXJjZSB0byBjdXQgYSB0cmFuc3BhcmVudCBhc3NldCBmcm9tLlxuZXhwb3J0IHR5cGUgQ3JvcCA9IHtcbiAgLy8gb24tZGlzayBwYXRoIHRvIHRoZSBzb3VyY2UgY29tcG9zaXRlIChvciBhIHByZS1jcm9wcGVkIHJlZ2lvbiDigJQgc2VlIGNyb3Agbm90ZSlcbiAgc291cmNlUGF0aDogc3RyaW5nO1xuICAvLyB0aGUgZWxlbWVudCdzIHBpeGVsIGJib3ggW3gxLCB5MSwgeDIsIHkyXSB3aXRoaW4gdGhlIHNvdXJjZVxuICBiYm94OiBCYm94O1xuICAvLyBlbGVtZW50IHR5cGUgZHJpdmVzIHdoZXRoZXIgcmVtb3ZhbCBldmVuIG1ha2VzIHNlbnNlIChwYWxldHRlcy9zY3JlZW5zaG90c1xuICAvLyBnZXQgZGVzdHJveWVkIGJ5IHJlbWJnIOKAlCBzZWUgbWFncGllJ3MgQWxwaGEgUG9saWN5KVxuICB0eXBlOiBzdHJpbmc7XG59O1xuXG4vLyBUaGUgcmVzdWx0IG9mIGEgcmVtb3ZhbCBwYXNzIOKAlCBhIGN1dG91dCBQTkcgKHdpdGggYWxwaGEpIHRoZSBzdXJmYWNlIGRpc3BsYXlzLlxuZXhwb3J0IHR5cGUgQ3V0b3V0ID0ge1xuICBpZDogc3RyaW5nO1xuICBiYWNrZW5kOiBzdHJpbmc7IC8vIHdoaWNoIFJlbW92YWxCYWNrZW5kIHByb2R1Y2VkIGl0XG4gIHBhdGg6IHN0cmluZzsgLy8gb24tZGlzayBQTkcgdGhlIGFnZW50IHJlYWRzIC8gdGhlIHN1cmZhY2Ugc2VydmVzXG4gIC8vIFRPRE8obW9jayk6IHdpZHRoL2hlaWdodCwgYSBwcmV2aWV3IHNyYywgdGltaW5nL2Nvc3QsIGEgcXVhbGl0eSBzaWduYWxcbn07XG5cbi8vIE9wdGlvbmFsIGtub2JzIHRocmVhZGVkIHRocm91Z2ggdG8gcmVtb3ZlLnB5ICh0aGUgZXh0cmFjdCBsb29wIGhvbm9ycyAtLWFscGhhXG4vLyAvIC0tcGFkIC8gLS1tb2RlbCBmcm9tIHRoZSBDTEkgdmVyYikuIEFsbCBoYXZlIHNlbnNpYmxlIGRlZmF1bHRzIGluc2lkZVxuLy8gcmVtb3ZlLnB5LiBgbW9kZWxgIG5hbWVzIGEgc3BlY2lmaWMgcmVtYmcgbW9kZWwgZm9yIHRoZSBtb2RlbC1hZ25vc3RpYyByZXRyeVxuLy8gKG9taXQg4oaSIHJlbWJnJ3MgZGVmYXVsdCB1Mm5ldCkuXG5leHBvcnQgdHlwZSBDdXRPcHRpb25zID0geyBhbHBoYT86IEFscGhhUG9saWN5OyBwYWQ/OiBudW1iZXI7IG1vZGVsPzogc3RyaW5nIH07XG5cbmV4cG9ydCBpbnRlcmZhY2UgUmVtb3ZhbEJhY2tlbmQge1xuICBuYW1lOiBzdHJpbmc7XG4gIC8vIEN1dCB0aGUgYmJveCByZWdpb24gb3V0IG9mIHRoZSBzb3VyY2UgaW50byBgb3V0UGF0aGAgYW5kIHJldHVybiB0aGUgY3V0b3V0LlxuICAvLyBUaGUgY2FsbGVyIG93bnMgYG91dFBhdGhgICh0aGUgc2Vzc2lvbiBmaWxlcyBkaXIpLiBgb3B0c2AgY2FycmllcyB0aGVcbiAgLy8gYWxwaGEtcG9saWN5IC8gcGFkZGluZyB0aGUgQ0xJIGV4dHJhY3QgdmVyYiBwYXNzZXMgdGhyb3VnaC5cbiAgY3V0KGNyb3A6IENyb3AsIG91dFBhdGg6IHN0cmluZywgb3B0cz86IEN1dE9wdGlvbnMpOiBQcm9taXNlPEN1dG91dD47XG59XG5cbi8vIFJlc29sdmUgc2NyaXB0cy9yZW1vdmUucHkgcmVsYXRpdmUgdG8gdGhpcyBtb2R1bGUgKG5vdCBjd2QpLlxuY29uc3QgUkVNT1ZFX1BZID0gam9pbihpbXBvcnQubWV0YS5kaXIsIFwicmVtb3ZlLnB5XCIpO1xuXG5mdW5jdGlvbiBzaG9ydElkKHByZWZpeDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgYnVmID0gbmV3IFVpbnQ4QXJyYXkoNCk7XG4gIGNyeXB0by5nZXRSYW5kb21WYWx1ZXMoYnVmKTtcbiAgY29uc3QgaGV4ID0gQXJyYXkuZnJvbShidWYsIChiKSA9PiBiLnRvU3RyaW5nKDE2KS5wYWRTdGFydCgyLCBcIjBcIikpLmpvaW4oXCJcIik7XG4gIHJldHVybiBgJHtwcmVmaXh9LSR7aGV4fWA7XG59XG5cbi8vIHJlbWJnIGJhY2tlbmQg4oCUIHNoZWxscyBvdXQgdG8gc2NyaXB0cy9yZW1vdmUucHkgKFBpbGxvdyBjcm9wICsgcmVtYmcpLiBUaGVcbi8vIGNhbGxlciBwYXNzZXMgdGhlIG91dHB1dCBsb2NhdGlvbjsgd2UgcGFyc2UgcmVtb3ZlLnB5J3Mgb25lIEpTT04gbGluZSBhbmRcbi8vIHJldHVybiB0aGUgY3V0b3V0LlxuZXhwb3J0IGNvbnN0IHJlbWJnQmFja2VuZDogUmVtb3ZhbEJhY2tlbmQgPSB7XG4gIG5hbWU6IFwicmVtYmdcIixcbiAgYXN5bmMgY3V0KGNyb3A6IENyb3AsIG91dFBhdGg6IHN0cmluZywgb3B0czogQ3V0T3B0aW9ucyA9IHt9KTogUHJvbWlzZTxDdXRvdXQ+IHtcbiAgICBjb25zdCBbeDEsIHkxLCB4MiwgeTJdID0gY3JvcC5iYm94O1xuICAgIGNvbnN0IGFyZ3MgPSBbXG4gICAgICBcInB5dGhvbjNcIixcbiAgICAgIFJFTU9WRV9QWSxcbiAgICAgIFwiLS1zb3VyY2VcIixcbiAgICAgIGNyb3Auc291cmNlUGF0aCxcbiAgICAgIFwiLS1iYm94XCIsXG4gICAgICBgJHt4MX0sJHt5MX0sJHt4Mn0sJHt5Mn1gLFxuICAgICAgXCItLXR5cGVcIixcbiAgICAgIGNyb3AudHlwZSxcbiAgICAgIFwiLS1vdXRcIixcbiAgICAgIG91dFBhdGgsXG4gICAgXTtcbiAgICBpZiAob3B0cy5hbHBoYSkgYXJncy5wdXNoKFwiLS1hbHBoYVwiLCBvcHRzLmFscGhhKTtcbiAgICBpZiAodHlwZW9mIG9wdHMucGFkID09PSBcIm51bWJlclwiKSBhcmdzLnB1c2goXCItLXBhZFwiLCBTdHJpbmcob3B0cy5wYWQpKTtcbiAgICBpZiAob3B0cy5tb2RlbCkgYXJncy5wdXNoKFwiLS1tb2RlbFwiLCBvcHRzLm1vZGVsKTtcblxuICAgIGNvbnN0IHByb2MgPSBCdW4uc3Bhd24oYXJncywgeyBzdGRvdXQ6IFwicGlwZVwiLCBzdGRlcnI6IFwicGlwZVwiIH0pO1xuICAgIGNvbnN0IFtzdGRvdXQsIHN0ZGVyciwgZXhpdENvZGVdID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgICAgbmV3IFJlc3BvbnNlKHByb2Muc3Rkb3V0KS50ZXh0KCksXG4gICAgICBuZXcgUmVzcG9uc2UocHJvYy5zdGRlcnIpLnRleHQoKSxcbiAgICAgIHByb2MuZXhpdGVkLFxuICAgIF0pO1xuICAgIGlmIChleGl0Q29kZSAhPT0gMCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgcmVtYmcgcmVtb3ZlLnB5IGZhaWxlZCAoZXhpdCAke2V4aXRDb2RlfSk6ICR7c3RkZXJyLnRyaW0oKSB8fCBzdGRvdXQudHJpbSgpfWAsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBsaW5lID0gc3Rkb3V0LnRyaW0oKS5zcGxpdChcIlxcblwiKS5maWx0ZXIoQm9vbGVhbikucG9wKCkgPz8gXCJcIjtcbiAgICBsZXQgcGFyc2VkOiB7IG91dD86IHN0cmluZzsgcmVtb3ZlZD86IGJvb2xlYW4gfTtcbiAgICB0cnkge1xuICAgICAgcGFyc2VkID0gSlNPTi5wYXJzZShsaW5lKSBhcyB7IG91dD86IHN0cmluZzsgcmVtb3ZlZD86IGJvb2xlYW4gfTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgcmVtYmcgcmVtb3ZlLnB5IHByb2R1Y2VkIG5vIHBhcnNlYWJsZSBKU09OIGxpbmU6ICR7c3Rkb3V0LnRyaW0oKX1gKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgaWQ6IHNob3J0SWQoXCJjdXRcIiksIGJhY2tlbmQ6IFwicmVtYmdcIiwgcGF0aDogcGFyc2VkLm91dCA/PyBvdXRQYXRoIH07XG4gIH0sXG59O1xuXG4vLyBtZWRpYS1mb3JnZSBiYWNrZW5kIOKAlCBjbG91ZCBiYWNrZ3JvdW5kIHJlbW92YWwgdmlhIHRoZSBtZWRpYS1mb3JnZSBDTEkgKHRoZVxuLy8gc2FtZSBvdXQtb2YtYmFuZCB0b29sIGltYWdvIHVzZXMpLiBgbWVkaWEtZm9yZ2UgZ2VuZXJhdGUgYmctcmVtb3ZlYCBpcyBhXG4vLyBzaW5nbGUtaW1hZ2UgdHJhbnNmb3JtIChwcm9tcHQtbGVzcyk6IGl0IHRha2VzIE9ORSBpbWFnZSBhbmQgcmV0dXJucyBhXG4vLyB0cmFuc3BhcmVudCBQTkcuIFNvIGBjcm9wLnNvdXJjZVBhdGhgIGhlcmUgaXMgdGhlIGVsZW1lbnQncyBBTFJFQURZLUNST1BQRURcbi8vIGltYWdlICh0aGUgc3VyZmFjZSdzIGNyb3AgdmVyc2lvbiksIE5PVCB0aGUgZnVsbCBib2FyZCDigJQgdGhlIGNhbGxlciBwYXNzZXMgaXQuXG4vLyBgb3B0cy5tb2RlbGAgaXMgdGhlIG1lZGlhLWZvcmdlIG1vZGVsIGlkIChlLmcuIGZhbC1haS9icmlhL2JhY2tncm91bmQvcmVtb3ZlKS5cbi8vIFdlIHBhcnNlIHRoZSBqb2IncyBwcmVzaWduZWQgb3V0cHV0IFVSTCBhbmQgc3RyZWFtIGl0IHRvIG91dFBhdGguXG5leHBvcnQgY29uc3QgbWVkaWFGb3JnZUJhY2tlbmQ6IFJlbW92YWxCYWNrZW5kID0ge1xuICBuYW1lOiBcIm1lZGlhLWZvcmdlXCIsXG4gIGFzeW5jIGN1dChjcm9wOiBDcm9wLCBvdXRQYXRoOiBzdHJpbmcsIG9wdHM6IEN1dE9wdGlvbnMgPSB7fSk6IFByb21pc2U8Q3V0b3V0PiB7XG4gICAgY29uc3QgbW9kZWwgPSBvcHRzLm1vZGVsO1xuICAgIGlmICghbW9kZWwpIHRocm93IG5ldyBFcnJvcihcIm1lZGlhRm9yZ2VCYWNrZW5kLmN1dCByZXF1aXJlcyBvcHRzLm1vZGVsIChhIGJnLXJlbW92ZSBtb2RlbCBpZClcIik7XG4gICAgY29uc3QgYXJncyA9IFtcbiAgICAgIFwibWVkaWEtZm9yZ2VcIixcbiAgICAgIFwiZ2VuZXJhdGVcIixcbiAgICAgIFwiYmctcmVtb3ZlXCIsXG4gICAgICBgLS1tb2RlbD0ke21vZGVsfWAsXG4gICAgICBgLS1yZWY9JHtjcm9wLnNvdXJjZVBhdGh9YCxcbiAgICAgIFwiLS1mb3JtYXRcIixcbiAgICAgIFwianNvblwiLFxuICAgIF07XG4gICAgY29uc3QgcHJvYyA9IEJ1bi5zcGF3bihhcmdzLCB7IHN0ZG91dDogXCJwaXBlXCIsIHN0ZGVycjogXCJwaXBlXCIgfSk7XG4gICAgY29uc3QgW3N0ZG91dCwgc3RkZXJyLCBleGl0Q29kZV0gPSBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgICBuZXcgUmVzcG9uc2UocHJvYy5zdGRvdXQpLnRleHQoKSxcbiAgICAgIG5ldyBSZXNwb25zZShwcm9jLnN0ZGVycikudGV4dCgpLFxuICAgICAgcHJvYy5leGl0ZWQsXG4gICAgXSk7XG4gICAgaWYgKGV4aXRDb2RlICE9PSAwKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBtZWRpYS1mb3JnZSBiZy1yZW1vdmUgZmFpbGVkIChleGl0ICR7ZXhpdENvZGV9KTogJHtzdGRlcnIudHJpbSgpIHx8IHN0ZG91dC50cmltKCl9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIGxldCBwYXJzZWQ6IHsgb2s/OiBib29sZWFuOyBkYXRhPzogeyBvdXRwdXRzPzogQXJyYXk8eyBwcmVzaWduZWRVcmw/OiBzdHJpbmcgfT4gfSB9O1xuICAgIHRyeSB7XG4gICAgICBwYXJzZWQgPSBKU09OLnBhcnNlKHN0ZG91dC50cmltKCkuc3BsaXQoXCJcXG5cIikuZmlsdGVyKEJvb2xlYW4pLnBvcCgpID8/IFwiXCIpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBtZWRpYS1mb3JnZSBwcm9kdWNlZCBubyBwYXJzZWFibGUgSlNPTiBsaW5lOiAke3N0ZG91dC50cmltKCl9YCk7XG4gICAgfVxuICAgIGNvbnN0IHVybCA9IHBhcnNlZD8uZGF0YT8ub3V0cHV0cz8uWzBdPy5wcmVzaWduZWRVcmw7XG4gICAgaWYgKCF1cmwpIHRocm93IG5ldyBFcnJvcihgbWVkaWEtZm9yZ2UgcmV0dXJuZWQgbm8gb3V0cHV0IHVybDogJHtzdGRvdXQudHJpbSgpfWApO1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKHVybCk7XG4gICAgaWYgKCFyZXMub2spIHRocm93IG5ldyBFcnJvcihgbWVkaWEtZm9yZ2Ugb3V0cHV0IGRvd25sb2FkIGZhaWxlZCAoSFRUUCAke3Jlcy5zdGF0dXN9KWApO1xuICAgIGF3YWl0IEJ1bi53cml0ZShvdXRQYXRoLCByZXMpO1xuICAgIHJldHVybiB7IGlkOiBzaG9ydElkKFwiY3V0XCIpLCBiYWNrZW5kOiBcIm1lZGlhLWZvcmdlXCIsIHBhdGg6IG91dFBhdGggfTtcbiAgfSxcbn07XG5cbi8vIElzIHRoaXMgYSBtZWRpYS1mb3JnZSBtb2RlbCBpZCAoYSBwcm92aWRlciBwYXRoIGxpa2UgXCJmYWwtYWkvYnJpYS9iYWNrZ3JvdW5kL1xuLy8gcmVtb3ZlXCIpIHZzIGEgYmFyZSByZW1iZyBtb2RlbCBuYW1lIChlLmcuIFwiaXNuZXQtZ2VuZXJhbC11c2VcIik/IFdlIHJvdXRlIGJ5XG4vLyBTSEFQRSwgbmV2ZXIgYSBoYXJkY29kZWQgbW9kZWwgbGlzdCDigJQgbWVkaWEtZm9yZ2UncyBjYXRhbG9nIGRyaWZ0cywgc28gdGhlIGFnZW50XG4vLyBESVNDT1ZFUlMgYmctcmVtb3ZlIG1vZGVsIGlkcyB2aWEgYG1lZGlhLWZvcmdlIG1vZGVscyBsaXN0YCAob3BlcmF0aW9uc1xuLy8gW1wiYmctcmVtb3ZlXCJdKSBhbmQgcGFzc2VzIHRoZSBpZCB0aHJvdWdoLiBUaGUgbWFncGllIENMSSBhYnN0cmFjdHMgdGhlXG4vLyBvcmNoZXN0cmF0aW9uLCBub3QgdGhlIG1vZGVsIGlkZW50aXR5LlxuZXhwb3J0IGZ1bmN0aW9uIGlzTWVkaWFGb3JnZU1vZGVsKG1vZGVsOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIG1vZGVsLmluY2x1ZGVzKFwiL1wiKTtcbn1cblxuLy8gVGhlIHJlZ2lzdHJ5IHRoZSBkYWVtb24vc3VyZmFjZSBwaWNrcyBiYWNrZW5kcyBmcm9tLlxuZXhwb3J0IGNvbnN0IFJFTU9WQUxfQkFDS0VORFM6IFJlY29yZDxzdHJpbmcsIFJlbW92YWxCYWNrZW5kPiA9IHtcbiAgW3JlbWJnQmFja2VuZC5uYW1lXTogcmVtYmdCYWNrZW5kLFxuICBbbWVkaWFGb3JnZUJhY2tlbmQubmFtZV06IG1lZGlhRm9yZ2VCYWNrZW5kLFxufTtcblxuZXhwb3J0IGZ1bmN0aW9uIGdldEJhY2tlbmQobmFtZTogc3RyaW5nKTogUmVtb3ZhbEJhY2tlbmQgfCB1bmRlZmluZWQge1xuICByZXR1cm4gUkVNT1ZBTF9CQUNLRU5EU1tuYW1lXTtcbn1cbiIsCiAgICAiLy8gc3VyZmFjZS9zdGF0ZS9hbHBoYS50c1xuLy8gVGhlIHR5cGUtZHJpdmVuIGFscGhhIHBvbGljeSDigJQgd2hpY2ggRUxFTUVOVCBUWVBFUyBnZXQgYmFja2dyb3VuZCByZW1vdmFsLlxuLy8gQnJvd3Nlci1zYWZlIChubyBub2RlOiosIG5vIEJ1bik6IHRoZSBzdXJmYWNlIHJlYWRzIGl0IHRvIHNob3cgXCJSZW1vdmUgYmdcIiB2cyBhXG4vLyBcImtlcHQgd2hvbGVcIiBub3RlOyBzY3JpcHRzL2JhY2tlbmQudHMgKyByZW1vdmUucHkgbWlycm9yIHRoZSBzYW1lIHJ1bGUuIFRoaXMgaXNcbi8vIGFib3V0IGVsZW1lbnQgVFlQRVMgKHdoaWNoIGxpdmUgaW4gdGhlIFVJKSwgTk9UIG1vZGVscyAod2hpY2ggbmV2ZXIgZG8pLlxuaW1wb3J0IHR5cGUgeyBFbGVtZW50VHlwZSB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbmV4cG9ydCB0eXBlIEFscGhhUG9saWN5ID0gXCJhdXRvXCIgfCBcImFsbFwiIHwgXCJub25lXCI7XG5cbi8vIHJlbWJnIHJlbGlhYmx5IHByb2R1Y2VzIHVzYWJsZSBhbHBoYSBmb3IgdGhlc2UgKHVuZGVyIGBhdXRvYCkuXG5leHBvcnQgY29uc3QgQUxQSEFfQVVUT19UWVBFUzogUmVhZG9ubHlTZXQ8RWxlbWVudFR5cGU+ID0gbmV3IFNldChbXG4gIFwiaWxsdXN0cmF0aW9uXCIsXG4gIFwic3RpY2tlclwiLFxuICBcImljb25cIixcbiAgXCJ3b3JkbWFya1wiLFxuXSk7XG5cbi8vIHJlbWJnIGRlc3Ryb3lzIHRoZXNlIChmbGF0LWNvbG9yIGNvbnRlbnQpIOKAlCBuZXZlciBhbHBoYSB0aGVtLCBldmVuIHVuZGVyIGBhbGxgLlxuZXhwb3J0IGNvbnN0IEFMUEhBX0ZPUkJJRERFTl9UWVBFUzogUmVhZG9ubHlTZXQ8RWxlbWVudFR5cGU+ID0gbmV3IFNldChbXG4gIFwicGFsZXR0ZVwiLFxuICBcInNjcmVlbnNob3RcIixcbiAgXCJ0eXBvZ3JhcGh5XCIsXG5dKTtcblxuLy8gU2hvdWxkIGFuIGVsZW1lbnQgb2YgYHR5cGVgIGdldCBiYWNrZ3JvdW5kIHJlbW92YWwgdW5kZXIgYHBvbGljeWA/IE1pcnJvcnNcbi8vIHJlbW92ZS5weSdzIHNob3VsZF9yZW1vdmUgZXhhY3RseS5cbmV4cG9ydCBmdW5jdGlvbiBzaG91bGRSZW1vdmUodHlwZTogc3RyaW5nLCBwb2xpY3k6IEFscGhhUG9saWN5KTogYm9vbGVhbiB7XG4gIGlmIChwb2xpY3kgPT09IFwibm9uZVwiKSByZXR1cm4gZmFsc2U7XG4gIGlmIChwb2xpY3kgPT09IFwiYWxsXCIpIHJldHVybiAhQUxQSEFfRk9SQklEREVOX1RZUEVTLmhhcyh0eXBlIGFzIEVsZW1lbnRUeXBlKTtcbiAgcmV0dXJuIEFMUEhBX0FVVE9fVFlQRVMuaGFzKHR5cGUgYXMgRWxlbWVudFR5cGUpOyAvLyBhdXRvIChkZWZhdWx0KVxufVxuXG4vLyBTdXJmYWNlIGhlbHBlcjogaXMgdGhpcyBlbGVtZW50IHR5cGUgYSBjYW5kaWRhdGUgZm9yIHJlbW92YWwgdW5kZXIgdGhlIGRlZmF1bHRcbi8vIGBhdXRvYCBwb2xpY3k/IERyaXZlcyB0aGUgXCJSZW1vdmUgYmdcIiBhY3Rpb24gdnMgdGhlIFwia2VwdCB3aG9sZVwiIGV4cGxhaW5lci5cbmV4cG9ydCBmdW5jdGlvbiBpc0FscGhhRWxpZ2libGUodHlwZTogRWxlbWVudFR5cGUpOiBib29sZWFuIHtcbiAgcmV0dXJuIEFMUEhBX0FVVE9fVFlQRVMuaGFzKHR5cGUpO1xufVxuXG4vLyBJcyB0aGlzIHR5cGUgZXhwbGljaXRseSBrZXB0IHdob2xlIChmbGF0IGNvbG9yIHJlbWJnIHdvdWxkIGRlc3Ryb3kpP1xuZXhwb3J0IGZ1bmN0aW9uIGlzS2VwdFdob2xlKHR5cGU6IEVsZW1lbnRUeXBlKTogYm9vbGVhbiB7XG4gIHJldHVybiBBTFBIQV9GT1JCSURERU5fVFlQRVMuaGFzKHR5cGUpO1xufVxuIiwKICAgICIjIS91c3IvYmluL2VudiBidW5cbi8vIG1hZ3BpZSDigJQgZGlzY292ZXIgcGhhc2UuIFRoZSBjYW5vbmljYWwgZWxlbWVudC1kaXNjb3ZlcnkgaW1wbGVtZW50YXRpb24uXG4vL1xuLy8gQ2FsbHMgR2VtaW5pIDMuNSBGbGFzaCB2aWEgT3BlblJvdXRlciBvbiBhIG1vb2Rib2FyZCAvIGJyYW5kaW5nIGJvYXJkIGltYWdlLFxuLy8gYXNrcyB0aGUgbW9kZWwgdG8gaWRlbnRpZnkgZXZlcnkgZGlzdGluY3QgZXh0cmFjdGFibGUgdmlzdWFsIGVsZW1lbnQsIGFuZFxuLy8gcmV0dXJucyBhIG1hbmlmZXN0IChuYW1lICsgdHlwZSArIHNvdXJjZS1waXhlbCBiYm94IHBlciBlbGVtZW50LCArIGNvc3QvdG9rZW5zKS5cbi8vIEEgcGxhaW4gZnVuY3Rpb24gbW9kdWxlIHRoZSBkYWVtb24vY2xpIGNhbGw7IGEgc21hbGwgQ0xJIGVudHJ5IGxpdmVzIGF0IHRoZVxuLy8gYm90dG9tLiAoUG9ydGVkIGZyb20gYW4gZWFybGllciBQeXRob24gb3JpZ2luYWwsIHNpbmNlIHJlbW92ZWQuKVxuXG5pbXBvcnQgeyBkaXJuYW1lLCBleHRuYW1lLCBqb2luLCByZXNvbHZlIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuaW1wb3J0IHR5cGUgeyBCYm94LCBFbGVtZW50VHlwZSB9IGZyb20gXCIuLi9zdXJmYWNlL3N0YXRlL3R5cGVzXCI7XG5cbmV4cG9ydCBjb25zdCBPUEVOUk9VVEVSX1VSTCA9IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MS9jaGF0L2NvbXBsZXRpb25zXCI7XG5leHBvcnQgY29uc3QgREVGQVVMVF9NT0RFTCA9IFwiZ29vZ2xlL2dlbWluaS0zLjUtZmxhc2hcIjtcblxuLy8gQ29waWVkIHZlcmJhdGltIGZyb20gdGhlIFB5dGhvbiBvcmlnaW5hbCdzIFBST01QVCAodGhlIGRpc2NvdmVyeSBpbnN0cnVjdGlvbikuXG5leHBvcnQgY29uc3QgUFJPTVBUID0gYElkZW50aWZ5IGV2ZXJ5IGRpc3RpbmN0IGV4dHJhY3RhYmxlIHZpc3VhbCBlbGVtZW50IGluIHRoaXMgaW1hZ2UuIFwiRGlzdGluY3QgZXh0cmFjdGFibGVcIiBtZWFuczogYSBzaW5nbGUgdmlzdWFsbHktY29oZXJlbnQgYXNzZXQgYSBkZXNpZ25lciB3b3VsZCB3YW50IHRvIHB1bGwgb3V0IGFzIGl0cyBvd24gZmlsZSDigJQgYSBsb2dvLCBhbiBpY29uLCBhIHN0aWNrZXIsIGEgY29sb3Igc3dhdGNoIHJvdywgYSBwaWVjZSBvZiBjb3ZlciBhcnQsIGEgVUkgc2NyZWVuc2hvdC4gRG8gTk9UIGluY2x1ZGUgYmFja2dyb3VuZCwgdGV4dHVyZSwgb3Igc3Vycm91bmRpbmcgY2FudmFzLlxuXG5Gb3IgZWFjaCBlbGVtZW50LCByZXR1cm4gYSBib3VuZGluZyBib3ggdXNpbmcgR29vZ2xlJ3Mgbm9ybWFsaXplZCBjb29yZGluYXRlIHN5c3RlbSAoaW1hZ2UgaXMgWzAsIDEwMDBdIG9uIGJvdGggYXhlcywgMCwwIHRvcC1sZWZ0KSBpbiB0aGUgZG9jdW1lbnRlZCBvcmRlcjogW3lfbWluLCB4X21pbiwgeV9tYXgsIHhfbWF4XS5cblxuUmV0dXJuIE9OTFkgYSBKU09OIGFycmF5LCBubyBwcm9zZSwgaW4gdGhpcyBleGFjdCBzaGFwZTpcbltcbiAge1wibmFtZVwiOiBcIjxzaG9ydF9zbmFrZV9jYXNlX25hbWU+XCIsIFwidHlwZVwiOiBcIjxvbmUgb2Y6IHdvcmRtYXJrLCB0YWdsaW5lLCBpY29uLCBpbGx1c3RyYXRpb24sIHN0aWNrZXIsIHBhbGV0dGUsIHR5cG9ncmFwaHksIHNjcmVlbnNob3QsIG90aGVyPlwiLCBcImJveF8yZFwiOiBbeV9taW4sIHhfbWluLCB5X21heCwgeF9tYXhdfVxuXVxuXG5OYW1pbmcgcnVsZXM6XG4tIFVzZSBkaXN0aW5jdGl2ZSBzbmFrZV9jYXNlIG5hbWVzOyBpZiB0aGVyZSBhcmUgbXVsdGlwbGUgb2YgdGhlIHNhbWUga2luZCwgZGlmZmVyZW50aWF0ZSBkZXNjcmlwdGl2ZWx5IChpY29uX21hbW1vdGgsIGljb25fZ2Vhciwgc3RpY2tlcl9jb2ZmZWUsIHN0aWNrZXJfc2thdGVib2FyZCkuXG4tIFRoZSBcXGB0eXBlXFxgIGZpZWxkIGlzIGNyaXRpY2FsIOKAlCB0aGUgZXh0cmFjdCBzdGVwIHVzZXMgaXQgdG8gZGVjaWRlIHdoZXRoZXIgdG8gcnVuIGJhY2tncm91bmQgcmVtb3ZhbC5cbmA7XG5cbi8vIE9wZW5Sb3V0ZXIgdmlzaW9uIGVuZHBvaW50cyByZWplY3QgdmVyeSBsYXJnZSBwYXlsb2FkcyB3aXRoIGEgbm9uLWFjdGlvbmFibGVcbi8vIDR4eDsgYmFpbCB3aXRoIGEgY2xlYXJlciBlcnJvciBmaXJzdCAobWF0Y2hlcyB0aGUgUHl0aG9uIG9yaWdpbmFsKS5cbmV4cG9ydCBjb25zdCBNQVhfSU1BR0VfQllURVMgPSAzMCAqIDEwMjQgKiAxMDI0O1xuZXhwb3J0IGNvbnN0IFdBUk5fSU1BR0VfQllURVMgPSAxNSAqIDEwMjQgKiAxMDI0O1xuXG5jb25zdCBNSU1FX0JZX0VYVDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgXCIuanBnXCI6IFwiaW1hZ2UvanBlZ1wiLFxuICBcIi5qcGVnXCI6IFwiaW1hZ2UvanBlZ1wiLFxuICBcIi5wbmdcIjogXCJpbWFnZS9wbmdcIixcbiAgXCIud2VicFwiOiBcImltYWdlL3dlYnBcIixcbiAgXCIuZ2lmXCI6IFwiaW1hZ2UvZ2lmXCIsXG59O1xuXG4vLyDilIDilIAgbWFuaWZlc3Qgc2NoZW1hIChtaXJyb3JzIHRoZSBQeXRob24gbWFuaWZlc3QpIOKUgOKUgFxuZXhwb3J0IHR5cGUgTWFuaWZlc3RFbGVtZW50ID0ge1xuICBuYW1lOiBzdHJpbmc7XG4gIHR5cGU6IEVsZW1lbnRUeXBlO1xuICBib3hfMmQ6IG51bWJlcltdOyAvLyBHZW1pbmkncyBub3JtYWxpemVkIFt5X21pbiwgeF9taW4sIHlfbWF4LCB4X21heF0sIDAuLjEwMDBcbiAgYmJveF9waXhlbDogQmJveDsgLy8gW3gxLCB5MSwgeDIsIHkyXSBpbiBzb3VyY2UgcGl4ZWxzICh1c2VkIGJ5IGV4dHJhY3QpXG59O1xuZXhwb3J0IHR5cGUgTWFuaWZlc3QgPSB7XG4gIHNvdXJjZTogc3RyaW5nO1xuICBzb3VyY2Vfc2l6ZTogW251bWJlciwgbnVtYmVyXTtcbiAgc291cmNlX3NoYTI1Nl8xNjogc3RyaW5nO1xuICBtb2RlbDogc3RyaW5nO1xuICBjb3N0X3VzZDogbnVtYmVyO1xuICB0b2tlbnM6IHsgcHJvbXB0OiBudW1iZXI7IGNvbXBsZXRpb246IG51bWJlcjsgcmVhc29uaW5nOiBudW1iZXIgfTtcbiAgZWxlbWVudHM6IE1hbmlmZXN0RWxlbWVudFtdO1xufTtcblxuLy8gUmFpc2VkIGZvciBhY3Rpb25hYmxlIHVzZXItZmFjaW5nIGZhaWx1cmVzIChiYWQgaW1hZ2Ugc2l6ZSwgbWlzc2luZyBrZXksIEhUVFBcbi8vIGVycm9yKS4gVGhlIENMSSBlbnRyeSBtYXBzIGl0IHRvIGEgY2xlYW4gc3RkZXJyIGxpbmUgKyBleGl0IGNvZGUuXG5leHBvcnQgY2xhc3MgRGlzY292ZXJFcnJvciBleHRlbmRzIEVycm9yIHt9XG5cbi8vIOKUgOKUgCBwdXJlIGhlbHBlcnMgKHVuaXQtdGVzdGVkOyBubyBuZXR3b3JrL2Rpc2spIOKUgOKUgFxuXG4vLyBTdHJpcCBvcHRpb25hbCBgYGBqc29uIGZlbmNlcyBhbmQgcGFyc2UgdGhlIEpTT04gYXJyYXkuIE1pcnJvcnNcbi8vIHRoZSBQeXRob24gb3JpZ2luYWwncyBwYXJzZV9iYm94ZXMuXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VCYm94ZXMoY29udGVudDogc3RyaW5nKTogdW5rbm93bltdIHtcbiAgbGV0IHMgPSBjb250ZW50LnRyaW0oKTtcbiAgY29uc3QgZmVuY2UgPSAvYGBgKD86anNvbik/XFxzKihbXFxzXFxTXSo/KVxccypgYGAvLmV4ZWMocyk7XG4gIGlmIChmZW5jZSkgcyA9IGZlbmNlWzFdO1xuICByZXR1cm4gSlNPTi5wYXJzZShzKTtcbn1cblxuLy8gQ29udmVydCBHZW1pbmkncyBbeV9taW4sIHhfbWluLCB5X21heCwgeF9tYXhdICgwLi4xMDAwKSB0byBzb3VyY2UgcGl4ZWxzXG4vLyBbeDEsIHkxLCB4MiwgeTJdLCBjbGFtcGVkIHRvIGltYWdlIGJvdW5kcy4gUmVwbGljYXRlcyB0aGUgUHl0aG9uIG9yaWdpbmFsJ3Ncbi8vIG5vcm1hbGl6ZWRfdG9fcGl4ZWwgZm9ybXVsYSBleGFjdGx5LlxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZWRUb1BpeGVsKGJveDogbnVtYmVyW10sIHdpZHRoOiBudW1iZXIsIGhlaWdodDogbnVtYmVyKTogQmJveCB7XG4gIGNvbnN0IFt5MSwgeDEsIHkyLCB4Ml0gPSBib3g7XG4gIGNvbnN0IHB4MSA9IE1hdGgubWF4KDAsIE1hdGgucm91bmQoKHgxIC8gMTAwMCkgKiB3aWR0aCkpO1xuICBjb25zdCBweTEgPSBNYXRoLm1heCgwLCBNYXRoLnJvdW5kKCh5MSAvIDEwMDApICogaGVpZ2h0KSk7XG4gIGNvbnN0IHB4MiA9IE1hdGgubWluKHdpZHRoLCBNYXRoLnJvdW5kKCh4MiAvIDEwMDApICogd2lkdGgpKTtcbiAgY29uc3QgcHkyID0gTWF0aC5taW4oaGVpZ2h0LCBNYXRoLnJvdW5kKCh5MiAvIDEwMDApICogaGVpZ2h0KSk7XG4gIHJldHVybiBbcHgxLCBweTEsIHB4MiwgcHkyXTtcbn1cblxuLy8gQnVpbGQgdGhlIG1hbmlmZXN0IGBlbGVtZW50c1tdYCBmcm9tIHRoZSBtb2RlbCdzIHBhcnNlZCBhcnJheSArIGltYWdlIHNpemUuXG4vLyBTa2lwcyBlbnRyaWVzIG1pc3NpbmcgYSBuYW1lIG9yIGJveCAobWF0Y2hlcyB0aGUgUHl0aG9uIG9yaWdpbmFsJ3MgZmlsdGVyKS5cbmV4cG9ydCBmdW5jdGlvbiBlbGVtZW50c0Zyb21SYXcocmF3OiB1bmtub3duW10sIHdpZHRoOiBudW1iZXIsIGhlaWdodDogbnVtYmVyKTogTWFuaWZlc3RFbGVtZW50W10ge1xuICBjb25zdCBlbGVtZW50czogTWFuaWZlc3RFbGVtZW50W10gPSBbXTtcbiAgZm9yIChjb25zdCBlbnRyeSBvZiByYXcpIHtcbiAgICBpZiAoIWVudHJ5IHx8IHR5cGVvZiBlbnRyeSAhPT0gXCJvYmplY3RcIikgY29udGludWU7XG4gICAgY29uc3QgZSA9IGVudHJ5IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIGNvbnN0IG5hbWUgPSBlLm5hbWU7XG4gICAgY29uc3Qga2luZCA9ICh0eXBlb2YgZS50eXBlID09PSBcInN0cmluZ1wiID8gZS50eXBlIDogXCJvdGhlclwiKSBhcyBFbGVtZW50VHlwZTtcbiAgICBjb25zdCBib3ggPSBlLmJveF8yZDtcbiAgICBpZiAoIW5hbWUgfHwgdHlwZW9mIG5hbWUgIT09IFwic3RyaW5nXCIgfHwgIUFycmF5LmlzQXJyYXkoYm94KSkgY29udGludWU7XG4gICAgZWxlbWVudHMucHVzaCh7XG4gICAgICBuYW1lLFxuICAgICAgdHlwZToga2luZCxcbiAgICAgIGJveF8yZDogYm94IGFzIG51bWJlcltdLFxuICAgICAgYmJveF9waXhlbDogbm9ybWFsaXplZFRvUGl4ZWwoYm94IGFzIG51bWJlcltdLCB3aWR0aCwgaGVpZ2h0KSxcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gZWxlbWVudHM7XG59XG5cbi8vIOKUgOKUgCBpbWFnZSByZWFkICsgZW5jb2RlIOKUgOKUgFxuXG5leHBvcnQgZnVuY3Rpb24gbWltZUZvclBhdGgocGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIE1JTUVfQllfRVhUW2V4dG5hbWUocGF0aCkudG9Mb3dlckNhc2UoKV0gPz8gXCJpbWFnZS9wbmdcIjtcbn1cblxuLy8gUmVhZCBhbiBpbWFnZSBmaWxlIOKGkiBhIGJhc2U2NCBkYXRhIFVSTCwgZW5mb3JjaW5nIHRoZSBzaXplIGd1YXJkLiBUaHJvd3Ncbi8vIERpc2NvdmVyRXJyb3IgYWJvdmUgTUFYX0lNQUdFX0JZVEVTOyB3YXJucyAoc3RkZXJyKSBhYm92ZSBXQVJOX0lNQUdFX0JZVEVTLlxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGVuY29kZUltYWdlRGF0YVVybChwYXRoOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCBmaWxlID0gQnVuLmZpbGUocGF0aCk7XG4gIGNvbnN0IHNpemUgPSBmaWxlLnNpemU7XG4gIGlmIChzaXplID4gTUFYX0lNQUdFX0JZVEVTKSB7XG4gICAgY29uc3QgbWIgPSAoc2l6ZSAvIDFfMDQ4XzU3NikudG9GaXhlZCgxKTtcbiAgICBjb25zdCBsaW1pdCA9IE1hdGguZmxvb3IoTUFYX0lNQUdFX0JZVEVTIC8gMV8wNDhfNTc2KTtcbiAgICB0aHJvdyBuZXcgRGlzY292ZXJFcnJvcihcbiAgICAgIGAke3BhdGh9IGlzICR7bWJ9IE1CLCBhYm92ZSB0aGUgJHtsaW1pdH0gTUIgbGltaXQuIFJlc2l6ZSBiZWZvcmUgcmV0cnlpbmcgYCArXG4gICAgICAgIGAoZS5nLiBJbWFnZU1hZ2ljazogXFxgbWFnaWNrIGluLnBuZyAtcmVzaXplIDIwMDB4MjAwMFxcXFw+IG91dC5wbmdcXGApLmAsXG4gICAgKTtcbiAgfVxuICBpZiAoc2l6ZSA+IFdBUk5fSU1BR0VfQllURVMpIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgIGBXQVJOOiAke3BhdGh9IGlzICR7KHNpemUgLyAxXzA0OF81NzYpLnRvRml4ZWQoMSl9IE1COyBsYXJnZSByZXF1ZXN0cyBzb21ldGltZXMgaGl0IE9wZW5Sb3V0ZXIncyBwYXlsb2FkIGxpbWl0cy5cXG5gLFxuICAgICk7XG4gIH1cbiAgY29uc3QgYnl0ZXMgPSBuZXcgVWludDhBcnJheShhd2FpdCBmaWxlLmFycmF5QnVmZmVyKCkpO1xuICBjb25zdCBiNjQgPSBCdWZmZXIuZnJvbShieXRlcykudG9TdHJpbmcoXCJiYXNlNjRcIik7XG4gIHJldHVybiBgZGF0YToke21pbWVGb3JQYXRoKHBhdGgpfTtiYXNlNjQsJHtiNjR9YDtcbn1cblxuLy8gSW1hZ2UgcGl4ZWwgc2l6ZSB2aWEgQnVuLkltYWdlIG1ldGFkYXRhIChyZXBsYWNlcyB0aGUgUHl0aG9uIG9yaWdpbmFsJ3MgUGlsbG93IHJlYWQpLlxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGltYWdlU2l6ZShwYXRoOiBzdHJpbmcpOiBQcm9taXNlPFtudW1iZXIsIG51bWJlcl0+IHtcbiAgY29uc3QgYnl0ZXMgPSBuZXcgVWludDhBcnJheShhd2FpdCBCdW4uZmlsZShwYXRoKS5hcnJheUJ1ZmZlcigpKTtcbiAgY29uc3QgbWV0YSA9IGF3YWl0IG5ldyBCdW4uSW1hZ2UoYnl0ZXMpLm1ldGFkYXRhKCk7XG4gIHJldHVybiBbbWV0YS53aWR0aCA/PyAwLCBtZXRhLmhlaWdodCA/PyAwXTtcbn1cblxuLy8gRmlyc3QgMTYgY2hhcnMgb2YgdGhlIGZpbGUncyBzaGEyNTYgKG1hdGNoZXMgdGhlIFB5dGhvbiBvcmlnaW5hbCkuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc291cmNlU2hhMjU2XzE2KHBhdGg6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IGJ5dGVzID0gbmV3IFVpbnQ4QXJyYXkoYXdhaXQgQnVuLmZpbGUocGF0aCkuYXJyYXlCdWZmZXIoKSk7XG4gIHJldHVybiBuZXcgQnVuLkNyeXB0b0hhc2hlcihcInNoYTI1NlwiKS51cGRhdGUoYnl0ZXMpLmRpZ2VzdChcImhleFwiKS5zbGljZSgwLCAxNik7XG59XG5cbi8vIOKUgOKUgCBPcGVuUm91dGVyIGNhbGwg4pSA4pSAXG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjYWxsT3BlblJvdXRlcihcbiAgYXBpS2V5OiBzdHJpbmcsXG4gIG1vZGVsOiBzdHJpbmcsXG4gIGltYWdlRGF0YVVybDogc3RyaW5nLFxuICBwcm9tcHQ6IHN0cmluZyxcbik6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgY29uc3QgYm9keSA9IHtcbiAgICBtb2RlbCxcbiAgICBtZXNzYWdlczogW1xuICAgICAge1xuICAgICAgICByb2xlOiBcInVzZXJcIixcbiAgICAgICAgY29udGVudDogW1xuICAgICAgICAgIHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IHByb21wdCB9LFxuICAgICAgICAgIHsgdHlwZTogXCJpbWFnZV91cmxcIiwgaW1hZ2VfdXJsOiB7IHVybDogaW1hZ2VEYXRhVXJsIH0gfSxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgXSxcbiAgICB0ZW1wZXJhdHVyZTogMCxcbiAgfTtcbiAgY29uc3QgY3RybCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IGN0cmwuYWJvcnQoKSwgMTgwXzAwMCk7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goT1BFTlJPVVRFUl9VUkwsIHtcbiAgICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgICBoZWFkZXJzOiB7XG4gICAgICAgIEF1dGhvcml6YXRpb246IGBCZWFyZXIgJHthcGlLZXl9YCxcbiAgICAgICAgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIsXG4gICAgICAgIFwiSFRUUC1SZWZlcmVyXCI6IFwiaHR0cHM6Ly9naXRodWIuY29tL2ljaGFib2Rjb2xlL3NwZWxsYm9va1wiLFxuICAgICAgICBcIlgtVGl0bGVcIjogXCJtYWdwaWVcIixcbiAgICAgIH0sXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSxcbiAgICAgIHNpZ25hbDogY3RybC5zaWduYWwsXG4gICAgfSk7XG4gICAgaWYgKCFyZXMub2spIHtcbiAgICAgIGNvbnN0IHRleHQgPSBhd2FpdCByZXMudGV4dCgpLmNhdGNoKCgpID0+IFwiXCIpO1xuICAgICAgdGhyb3cgbmV3IERpc2NvdmVyRXJyb3IoYE9wZW5Sb3V0ZXIgSFRUUCAke3Jlcy5zdGF0dXN9OiAke3RleHR9YCk7XG4gICAgfVxuICAgIHJldHVybiAoYXdhaXQgcmVzLmpzb24oKSkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgfVxufVxuXG4vLyDilIDilIAgb3JjaGVzdHJhdGlvbiDilIDilIBcblxuZXhwb3J0IHR5cGUgRGlzY292ZXJPcHRpb25zID0geyBtb2RlbD86IHN0cmluZzsgYXBpS2V5Pzogc3RyaW5nIH07XG5cbi8vIEZ1bGwgZGlzY292ZXI6IHJlYWQgaW1hZ2UsIGNhbGwgdGhlIG1vZGVsLCBwYXJzZSwgYnVpbGQgdGhlIG1hbmlmZXN0LiBUaHJvd3Ncbi8vIERpc2NvdmVyRXJyb3Igb24gYWN0aW9uYWJsZSBmYWlsdXJlcyAobWlzc2luZyBrZXksIG92ZXJzaXplZCBpbWFnZSwgSFRUUCAvXG4vLyBwYXJzZSBlcnJvcnMpLiBUaGUgT1BFTlJPVVRFUl9BUElfS0VZIG11c3QgYmUgaW4gdGhlIGVudmlyb25tZW50IOKAlCB3ZSBuZXZlclxuLy8gaW5zdGFsbCBhIGtleS5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBkaXNjb3ZlcihpbWFnZVBhdGg6IHN0cmluZywgb3B0czogRGlzY292ZXJPcHRpb25zID0ge30pOiBQcm9taXNlPE1hbmlmZXN0PiB7XG4gIGNvbnN0IG1vZGVsID0gb3B0cy5tb2RlbCA/PyBERUZBVUxUX01PREVMO1xuICBjb25zdCBhcGlLZXkgPSBvcHRzLmFwaUtleSA/PyBwcm9jZXNzLmVudi5PUEVOUk9VVEVSX0FQSV9LRVk7XG4gIGlmICghYXBpS2V5KSB7XG4gICAgdGhyb3cgbmV3IERpc2NvdmVyRXJyb3IoXCJPUEVOUk9VVEVSX0FQSV9LRVkgZW52IHZhciBub3Qgc2V0XCIpO1xuICB9XG4gIGlmICghKGF3YWl0IEJ1bi5maWxlKGltYWdlUGF0aCkuZXhpc3RzKCkpKSB7XG4gICAgdGhyb3cgbmV3IERpc2NvdmVyRXJyb3IoYGltYWdlIG5vdCBmb3VuZDogJHtpbWFnZVBhdGh9YCk7XG4gIH1cblxuICBjb25zdCBbc2l6ZSwgZGF0YVVybCwgc2hhXSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICBpbWFnZVNpemUoaW1hZ2VQYXRoKSxcbiAgICBlbmNvZGVJbWFnZURhdGFVcmwoaW1hZ2VQYXRoKSxcbiAgICBzb3VyY2VTaGEyNTZfMTYoaW1hZ2VQYXRoKSxcbiAgXSk7XG4gIGNvbnN0IFt3aWR0aCwgaGVpZ2h0XSA9IHNpemU7XG5cbiAgY29uc3QgcmVzcCA9IGF3YWl0IGNhbGxPcGVuUm91dGVyKGFwaUtleSwgbW9kZWwsIGRhdGFVcmwsIFBST01QVCk7XG5cbiAgY29uc3QgY2hvaWNlcyA9IHJlc3AuY2hvaWNlcyBhcyBBcnJheTx7IG1lc3NhZ2U/OiB7IGNvbnRlbnQ/OiB1bmtub3duIH0gfT4gfCB1bmRlZmluZWQ7XG4gIGNvbnN0IGNvbnRlbnQgPSBjaG9pY2VzPy5bMF0/Lm1lc3NhZ2U/LmNvbnRlbnQ7XG4gIGlmICh0eXBlb2YgY29udGVudCAhPT0gXCJzdHJpbmdcIikge1xuICAgIHRocm93IG5ldyBEaXNjb3ZlckVycm9yKFxuICAgICAgYHVuZXhwZWN0ZWQgcmVzcG9uc2Ugc2hhcGUgZnJvbSBPcGVuUm91dGVyIChubyBjaG9pY2VzWzBdLm1lc3NhZ2UuY29udGVudCk6XFxuJHtKU09OLnN0cmluZ2lmeShyZXNwKS5zbGljZSgwLCAyMDAwKX1gLFxuICAgICk7XG4gIH1cblxuICBjb25zdCB1c2FnZSA9IChyZXNwLnVzYWdlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA/PyB7fTtcbiAgY29uc3QgY29zdCA9IHR5cGVvZiB1c2FnZS5jb3N0ID09PSBcIm51bWJlclwiID8gdXNhZ2UuY29zdCA6IDA7XG4gIGNvbnN0IHByb21wdFRva2VucyA9IHR5cGVvZiB1c2FnZS5wcm9tcHRfdG9rZW5zID09PSBcIm51bWJlclwiID8gdXNhZ2UucHJvbXB0X3Rva2VucyA6IDA7XG4gIGNvbnN0IGNvbXBsZXRpb25Ub2tlbnMgPVxuICAgIHR5cGVvZiB1c2FnZS5jb21wbGV0aW9uX3Rva2VucyA9PT0gXCJudW1iZXJcIiA/IHVzYWdlLmNvbXBsZXRpb25fdG9rZW5zIDogMDtcbiAgY29uc3QgZGV0YWlscyA9ICh1c2FnZS5jb21wbGV0aW9uX3Rva2Vuc19kZXRhaWxzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA/PyB7fTtcbiAgY29uc3QgcmVhc29uaW5nVG9rZW5zID1cbiAgICB0eXBlb2YgZGV0YWlscy5yZWFzb25pbmdfdG9rZW5zID09PSBcIm51bWJlclwiID8gZGV0YWlscy5yZWFzb25pbmdfdG9rZW5zIDogMDtcblxuICBsZXQgcmF3OiB1bmtub3duW107XG4gIHRyeSB7XG4gICAgcmF3ID0gcGFyc2VCYm94ZXMoY29udGVudCk7XG4gIH0gY2F0Y2ggKGV4KSB7XG4gICAgdGhyb3cgbmV3IERpc2NvdmVyRXJyb3IoXG4gICAgICBgbW9kZWwgcmV0dXJuZWQgbm9uLUpTT04gb3V0cHV0OlxcbiR7Y29udGVudH1cXG5cXG5QYXJzZSBlcnJvcjogJHtleCBpbnN0YW5jZW9mIEVycm9yID8gZXgubWVzc2FnZSA6IFN0cmluZyhleCl9YCxcbiAgICApO1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBzb3VyY2U6IHJlc29sdmUoaW1hZ2VQYXRoKSxcbiAgICBzb3VyY2Vfc2l6ZTogW3dpZHRoLCBoZWlnaHRdLFxuICAgIHNvdXJjZV9zaGEyNTZfMTY6IHNoYSxcbiAgICBtb2RlbCxcbiAgICBjb3N0X3VzZDogY29zdCxcbiAgICB0b2tlbnM6IHsgcHJvbXB0OiBwcm9tcHRUb2tlbnMsIGNvbXBsZXRpb246IGNvbXBsZXRpb25Ub2tlbnMsIHJlYXNvbmluZzogcmVhc29uaW5nVG9rZW5zIH0sXG4gICAgZWxlbWVudHM6IGVsZW1lbnRzRnJvbVJhdyhyYXcsIHdpZHRoLCBoZWlnaHQpLFxuICB9O1xufVxuXG4vLyDilIDilIAgQ0xJIGVudHJ5IChwYXJpdHkgd2l0aCB0aGUgUHl0aG9uIG9yaWdpbmFsKSDilIDilIBcbmFzeW5jIGZ1bmN0aW9uIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCB7IHBhcnNlQXJncyB9ID0gYXdhaXQgaW1wb3J0KFwibm9kZTp1dGlsXCIpO1xuICBsZXQgcGFyc2VkOiBSZXR1cm5UeXBlPHR5cGVvZiBwYXJzZUFyZ3M+O1xuICB0cnkge1xuICAgIHBhcnNlZCA9IHBhcnNlQXJncyh7XG4gICAgICBhcmdzOiBhcmd2LFxuICAgICAgb3B0aW9uczoge1xuICAgICAgICBvdXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICAgICAgICBtb2RlbDogeyB0eXBlOiBcInN0cmluZ1wiLCBkZWZhdWx0OiBERUZBVUxUX01PREVMIH0sXG4gICAgICB9LFxuICAgICAgYWxsb3dQb3NpdGlvbmFsczogdHJ1ZSxcbiAgICAgIHN0cmljdDogdHJ1ZSxcbiAgICB9KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBlcnJvcjogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9XFxuYCk7XG4gICAgcmV0dXJuIDI7XG4gIH1cbiAgY29uc3QgaW1hZ2VQYXRoID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdO1xuICBpZiAoIWltYWdlUGF0aCkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFwidXNhZ2U6IGRpc2NvdmVyLnRzIDxpbWFnZT4gWy0tb3V0IDxtYW5pZmVzdC5qc29uPl0gWy0tbW9kZWwgPG1vZGVsPl1cXG5cIik7XG4gICAgcmV0dXJuIDI7XG4gIH1cbiAgdHJ5IHtcbiAgICBjb25zdCBtYW5pZmVzdCA9IGF3YWl0IGRpc2NvdmVyKGltYWdlUGF0aCwgeyBtb2RlbDogcGFyc2VkLnZhbHVlcy5tb2RlbCBhcyBzdHJpbmcgfSk7XG4gICAgY29uc3Qgb3V0ID1cbiAgICAgIChwYXJzZWQudmFsdWVzLm91dCBhcyBzdHJpbmcgfCB1bmRlZmluZWQpID8/XG4gICAgICBqb2luKGRpcm5hbWUocmVzb2x2ZShpbWFnZVBhdGgpKSwgYCR7YmFzZVN0ZW0oaW1hZ2VQYXRoKX0tbWFuaWZlc3QuanNvbmApO1xuICAgIGF3YWl0IEJ1bi53cml0ZShvdXQsIEpTT04uc3RyaW5naWZ5KG1hbmlmZXN0LCBudWxsLCAyKSk7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgICBgRGlzY292ZXJlZCAke21hbmlmZXN0LmVsZW1lbnRzLmxlbmd0aH0gZWxlbWVudChzKSDigJQgY29zdCAkJHttYW5pZmVzdC5jb3N0X3VzZC50b0ZpeGVkKDQpfVxcbmAsXG4gICAgKTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgbWFuaWZlc3QuZWxlbWVudHMpIHtcbiAgICAgIGNvbnN0IFt4MSwgeTEsIHgyLCB5Ml0gPSBlLmJib3hfcGl4ZWw7XG4gICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgICAke2UudHlwZX0gICR7ZS5uYW1lfSAgc3JjPSgke3gxfSwke3kxfSwke3gyfSwke3kyfSlcXG5gKTtcbiAgICB9XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYE1hbmlmZXN0IHdyaXR0ZW46ICR7b3V0fVxcbmApO1xuICAgIHJldHVybiAwO1xuICB9IGNhdGNoIChlKSB7XG4gICAgaWYgKGUgaW5zdGFuY2VvZiBEaXNjb3ZlckVycm9yKSB7XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgRVJST1I6ICR7ZS5tZXNzYWdlfVxcbmApO1xuICAgICAgcmV0dXJuIDE7XG4gICAgfVxuICAgIHRocm93IGU7XG4gIH1cbn1cblxuZnVuY3Rpb24gYmFzZVN0ZW0ocGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgYmFzZSA9IHBhdGguc3BsaXQoXCIvXCIpLnBvcCgpID8/IHBhdGg7XG4gIGNvbnN0IGRvdCA9IGJhc2UubGFzdEluZGV4T2YoXCIuXCIpO1xuICByZXR1cm4gZG90ID4gMCA/IGJhc2Uuc2xpY2UoMCwgZG90KSA6IGJhc2U7XG59XG5cbmlmIChpbXBvcnQubWV0YS5tYWluKSB7XG4gIC8vIGBwcm9jZXNzLmV4aXRDb2RlYCArIGEgbmF0dXJhbCByZXR1cm4sIE5FVkVSIGBwcm9jZXNzLmV4aXQoY29kZSlgOiBCdW4nc1xuICAvLyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGEgcGlwZSAoc3luY2hyb25vdXMgb24gYSBUVFkgb3IgZmlsZSksIHNvIGFuXG4gIC8vIGV4cGxpY2l0IGV4aXQgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlCBtZWFzdXJlZCBhdCBleGFjdGx5XG4gIC8vIDY1LDUzNiBieXRlcy4gVGhlIHBheWxvYWQgaXMgY29tcGxldGUgYW5kIG9ubHkgdGhlIHdyaXRlIGlzIGxvc3QsIHNvIHRoZVxuICAvLyBjYWxsZXIgZ2V0cyB3ZWxsLWZvcm1lZC1sb29raW5nIEpTT04gdGhhdCBzdG9wcyBtaWQtc3RyaW5nLiBSZXByb2R1Y2VkLFxuICAvLyBmaXhlZCBhbmQgZ2F0ZWQgaW4gYm91bnR5IGZpcnN0IChQMCwgIzc3LyM3OCk7IHNhbWUgc2hhcGUsIHNhbWUgcmVhc29uLlxuICAvLyBEbyBub3QgdGlkeSB0aGlzIGJhY2sgaW50byBhbiBleHBsaWNpdCBleGl0LlxuICBwcm9jZXNzLmV4aXRDb2RlID0gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuIiwKICAgICIvLyBzdXJmYWNlL3N0YXRlL3R5cGVzLnRzXG4vLyBUaGUgc2luZ2xlIHNoYXJlZCBjb250cmFjdCBmb3IgbWFncGllJ3MgY29uanVyYXRpb24uIEltcG9ydGVkIGJ5IHNlcnZlci50cyxcbi8vIHJlZHVjZS50cywgY2xpLnRzLCBBTkQgdGhlIFJlYWN0IGNsaWVudC5cbi8vXG4vLyBtYWdwaWUgKHJlYnVpbHQpIGlzIGEgU1RBTkRJTkcgUkVWSUVXIFNVUkZBQ0Ugb3ZlciBhIGNvbXBvc2l0ZSBpbWFnZTogdGhlXG4vLyBkYWVtb24gaG9sZHMgdGhlIGV4dHJhY3Rpb24gc3RhdGUsIHRoZSBSZWFjdCBzdXJmYWNlIHNob3dzIHRoZSBlbGVtZW50XG4vLyBicmVha2Rvd24sIGFuZCB0aGUgdXNlciBqdWRnZXMgZWFjaCBjdXRvdXQsIGNvbXBhcmVzIHJlbW92YWwtbW9kZWwgcmVzdWx0cyxcbi8vIGFuZCBzZWxlY3RpdmVseSByZXRyaWVzLiBUaGUgYWdlbnQgZHJpdmVzIGRpc2NvdmVyeSArIGV4dHJhY3Rpb247IHRoZSBzdXJmYWNlXG4vLyBpcyB3aGVyZSB0aGUgdXNlciBzdGVlcnMuXG4vL1xuLy8gUFJPVklTSU9OQUwg4oCUIHRoaXMgc3RhdGUgc2hhcGUgaXMgYSBkZXNpZ24taW5kZXBlbmRlbnQgc2tlbGV0b24uIFRoZVxuLy8gbWFncGllLXNwZWNpZmljIHN1cmZhY2UgKyB0aGUgZmluYWwgc2V0dGxlZCBzaGFwZSBhcmUgYmVpbmcgZGVzaWduZWQgaW5cbi8vIHBhcmFsbGVsLiBFdmVyeXRoaW5nIG1hcmtlZCBgLy8gVE9ETyhtb2NrKTog4oCmYCBpcyBhIGRlbGliZXJhdGUgcGxhY2Vob2xkZXIgdGhlXG4vLyBtb2NrIHRyYWNrIHdpbGwgcmVwbGFjZTsga2VlcCBtdXRhdG9ycyAocmVkdWNlLnRzKSB0aGluIGFyb3VuZCBpdC5cblxuLy8gVGhlIGVsZW1lbnQgdHlwZSB0YXhvbm9teSBwb3J0ZWQgZnJvbSB0aGUgUHl0aG9uIG9yaWdpbmFsIOKAlCBkcml2ZXMgdGhlIChmdXR1cmUpXG4vLyBiYWNrZ3JvdW5kLXJlbW92YWwgZGVjaXNpb24gaW4gZXh0cmFjdC5cbmV4cG9ydCB0eXBlIEVsZW1lbnRUeXBlID1cbiAgfCBcIndvcmRtYXJrXCJcbiAgfCBcInRhZ2xpbmVcIlxuICB8IFwiaWNvblwiXG4gIHwgXCJpbGx1c3RyYXRpb25cIlxuICB8IFwic3RpY2tlclwiXG4gIHwgXCJwYWxldHRlXCJcbiAgfCBcInR5cG9ncmFwaHlcIlxuICB8IFwic2NyZWVuc2hvdFwiXG4gIHwgXCJvdGhlclwiO1xuXG5leHBvcnQgY29uc3QgRUxFTUVOVF9UWVBFUzogcmVhZG9ubHkgRWxlbWVudFR5cGVbXSA9IFtcbiAgXCJ3b3JkbWFya1wiLFxuICBcInRhZ2xpbmVcIixcbiAgXCJpY29uXCIsXG4gIFwiaWxsdXN0cmF0aW9uXCIsXG4gIFwic3RpY2tlclwiLFxuICBcInBhbGV0dGVcIixcbiAgXCJ0eXBvZ3JhcGh5XCIsXG4gIFwic2NyZWVuc2hvdFwiLFxuICBcIm90aGVyXCIsXG5dIGFzIGNvbnN0O1xuXG4vLyBUaGUgbGluZWFyIHByb2Nlc3Mgc3BpbmUgKHRoZSB0b3AtYmFyIHN0ZXBwZXIpLiBPbmUgYWN0aXZlIHBoYXNlIGF0IGEgdGltZTtcbi8vIHRoZSBjdXJzb3IgYWR2YW5jZXMgd2hlbiB0aGUgdXNlciBzZWFscyBhIHBoYXNlLiBTdGF0dXMgaXMgREVSSVZFRCBmcm9tIHRoZVxuLy8gY3Vyc29yIOKAlCBwaGFzZXMgYmVmb3JlIGl0IGFyZSBzZWFsZWQsIHRoZSBjdXJzb3IgaXMgYWN0aXZlLCBhZnRlciBpcyB1cGNvbWluZy5cbmV4cG9ydCB0eXBlIFBoYXNlS2V5ID0gXCJpbnRha2VcIiB8IFwic2xpY2VcIiB8IFwicmVtb3ZlXCIgfCBcImV4cG9ydFwiO1xuZXhwb3J0IGNvbnN0IFBIQVNFUzogcmVhZG9ubHkgUGhhc2VLZXlbXSA9IFtcImludGFrZVwiLCBcInNsaWNlXCIsIFwicmVtb3ZlXCIsIFwiZXhwb3J0XCJdIGFzIGNvbnN0O1xuXG4vLyBBIHBpeGVsIGJvdW5kaW5nIGJveCBbeDEsIHkxLCB4MiwgeTJdIGluIHNvdXJjZS1pbWFnZSBjb29yZGluYXRlcyAobWF0Y2hlc1xuLy8gdGhlIFB5dGhvbiBvcmlnaW5hbCdzIGBiYm94X3BpeGVsYCkuXG5leHBvcnQgdHlwZSBCYm94ID0gW251bWJlciwgbnVtYmVyLCBudW1iZXIsIG51bWJlcl07XG5cbi8vIFRoZSBiYWNrZHJvcCB0aGUgc3VyZmFjZSBwcmV2aWV3cyBjdXRvdXRzIGFnYWluc3QgKGEgY2hlY2tlciBmb3IgdHJhbnNwYXJlbnQpLlxuZXhwb3J0IHR5cGUgQmFja2Ryb3AgPSBcIndoaXRlXCIgfCBcImdyYXlcIiB8IFwiYmxhY2tcIiB8IFwidHJhbnNwYXJlbnRcIjtcblxuLy8gT25lIGV4dHJhY3RhYmxlIGVsZW1lbnQuIE1JTklNQUwgcHJvdmlzaW9uYWwgc2hhcGUg4oCUIHRoZSByZXZpZXcvanVkZ21lbnRcbi8vIG1hY2hpbmVyeSBpcyBtb2NrZWQgb3V0IGZvciBub3cuIGBiYm94YCBpcyBjYW5vbmljYWwgaW4gU09VUkNFIFBJWEVMUyAod2hhdFxuLy8gZGlzY292ZXIgcHJvZHVjZXMgYW5kIGNyb3AgY29uc3VtZXMpOyB0aGUgY2FudmFzIGNvbnZlcnRzIHB44oaUZnJhY3Rpb24gdmlhXG4vLyBgc291cmNlLnNpemVgIGZvciByZW5kZXJpbmcvZWRpdGluZy5cbmV4cG9ydCB0eXBlIEVsZW1lbnRTdGF0dXMgPSBcInByb3Bvc2VkXCIgfCBcImNvbmZpcm1lZFwiIHwgXCJkcm9wcGVkXCI7XG5cbi8vIEEgcHJvZHVjZWQgYXNzZXQgZm9yIG9uZSBlbGVtZW50OiB0aGUgcmF3IGNyb3AgKG1vZGVsOlwiY3JvcFwiKSBvciBhIHJlbW92YWxcbi8vIHJlc3VsdC4gYHBhdGhgIGlzIHRoZSBvbi1kaXNrIFBORyBzZXJ2ZWQgdmlhIC9hc3NldHM7IGByZXZgIGJ1bXBzIG9uIGV2ZXJ5XG4vLyAocmUtKXJ1biBvZiB0aGUgU0FNRSBtb2RlbCDigJQgdGhlIGZpbGUgaXMgb3ZlcndyaXR0ZW4gaW4gcGxhY2UsIHNvIHRoZSBzdXJmYWNlXG4vLyBhcHBlbmRzID92PTxyZXY+IHRvIGJ1c3QgdGhlIGJyb3dzZXIgY2FjaGUuIGBraW5kYCBpcyBhIGxhYmVsLWNoaXAgaGludCB0aGVcbi8vIGFnZW50IHN1cHBsaWVzOyBuZXZlciBpbmZlcnJlZCBpbiB0aGUgVUkuXG5leHBvcnQgdHlwZSBFbGVtZW50VmVyc2lvbiA9IHtcbiAgaWQ6IHN0cmluZztcbiAgbW9kZWw6IHN0cmluZzsgLy8gXCJjcm9wXCIgfCBcInJlbWJnXCIgfCBcImJyaWFcIiB8IFwiaWRlb2dyYW1cIiB8IOKApiAoYWdlbnQtZGVmaW5lZClcbiAga2luZD86IFwicmF3XCIgfCBcImxvY2FsXCIgfCBcImNsb3VkXCI7XG4gIHBhdGg6IHN0cmluZztcbiAgcmV2OiBudW1iZXI7XG4gIG5vdGU/OiBzdHJpbmc7XG59O1xuXG5leHBvcnQgdHlwZSBFbGVtZW50ID0ge1xuICBpZDogc3RyaW5nO1xuICBuYW1lOiBzdHJpbmc7XG4gIHR5cGU6IEVsZW1lbnRUeXBlO1xuICBiYm94OiBCYm94O1xuICBzdGF0dXM6IEVsZW1lbnRTdGF0dXM7XG4gIC8vIOKUgOKUgCBleHRyYWN0aW9uIOKUgOKUgFxuICAvLyBQcm9kdWNlZCBhc3NldHMsIG9uZSByb3cgcGVyIG1vZGVsLiBjcm9wID0gdmVyc2lvbnNbMF0gKG1vZGVsOlwiY3JvcFwiKS5cbiAgLy8gQWJzZW50IHVudGlsIHRoZSBmaXJzdCBjdXQ7IHRyZWF0IHVuZGVmaW5lZCBhcyBbXS4gVGhlIGNob3NlbiB2ZXJzaW9uIGlzXG4gIC8vIHdoYXQgdGhlIHJhaWwvZ2FsbGVyeSByZW5kZXIgKGNob3NlblZlcnNpb24oKSBmYWxscyBiYWNrIHRvIHZlcnNpb25zWzBdKS5cbiAgdmVyc2lvbnM/OiBFbGVtZW50VmVyc2lvbltdO1xuICBjaG9zZW5WZXJzaW9uSWQ/OiBzdHJpbmc7XG4gIC8vIFRoZSBzb2xlIHJldmlldyBzaWduYWw6IHRoZSB1c2VyIGZsYWdnZWQgdGhpcyBlbGVtZW50IHRvIGJlIHJlLXJ1biAocmUtc2xpY2VcbiAgLy8gaW4gdGhlIHNsaWNlcyBwaGFzZSwgcmUtcmVtb3ZlIGluIHRoZSBiZyBwaGFzZSkuIEFwcHJvdmFsIGlzIHRoZSBBQlNFTkNFIG9mIGFcbiAgLy8gZmxhZzsgZGlzY2FyZGluZyBpcyBzdGF0dXM6XCJkcm9wcGVkXCIuIENsZWFyZWQgd2hlbiBhIGZyZXNoIHZlcnNpb24gbGFuZHMuXG4gIGZsYWdnZWQ/OiBib29sZWFuO1xufTtcblxuLy8g4pSA4pSAIHRoZSBjb252ZXJzYXRpb24gKHRoZSBzcGluZSwgcG9ydGVkIHNldHRsZWQgZnJvbSBpbWFnbykg4pSA4pSAXG5leHBvcnQgdHlwZSBNZXNzYWdlS2luZCA9XG4gIHwgXCJ0ZXh0XCIgLy8gcGxhaW4gZGlhbG9ndWUgKGVpdGhlciByb2xlKVxuICB8IFwiZ2VzdHVyZVwiIC8vIGEgc3VyZmFjZSBhY3Rpb24gc3VyZmFjZWQgYXMgYSBtZXNzYWdlICh1c2VyIGp1ZGdlZC9yZXRyaWVkL+KApilcbiAgfCBcInF1ZXN0aW9uXCI7IC8vIGFnZW50IG5lZWRzIHRoZSB1c2VyIChhbiB1bmFuc3dlcmVkIG9uZSDihpIgXCJhc2tpbmdcIiBwcmVzZW5jZSlcblxuZXhwb3J0IHR5cGUgTWVzc2FnZSA9IHtcbiAgaWQ6IHN0cmluZztcbiAgcm9sZTogXCJ1c2VyXCIgfCBcImFnZW50XCI7XG4gIGtpbmQ6IE1lc3NhZ2VLaW5kO1xuICB0ZXh0OiBzdHJpbmc7XG4gIHRzOiBudW1iZXI7XG4gIC8vIGtpbmQ6IFwicXVlc3Rpb25cIiDigJQgb3B0aW9uYWwgcXVpY2sgcmVwbGllcyAodGhlIGZ1bGwgYW5zd2VyIGNhbiBiZSBmcmVlIHRleHQpXG4gIG9wdGlvbnM/OiBzdHJpbmdbXTtcbiAgLy8ga2luZDogXCJnZXN0dXJlXCIg4oCUIHdoYXQgdGhlIHVzZXIgZGlkLCBhbmQgdG8gd2hhdFxuICBnZXN0dXJlPzogeyBraW5kOiBzdHJpbmc7IHRhcmdldElkPzogc3RyaW5nIH07XG4gIC8vIEFuIG9wdGlvbmFsIG9uZS1jbGljayBDVEEgdGhlIGFnZW50IGF0dGFjaGVzIHRvIGEgbWVzc2FnZSDigJQgYSBTSE9SVENVVCBmb3IgYVxuICAvLyBjb252ZXJzYXRpb25hbCBhY3QgKHRoZSB1c2VyIGNvdWxkIGhhdmUganVzdCBzYWlkIGl0KS4gQ2xpY2tpbmcgZGlzcGF0Y2hlc1xuICAvLyBgY29tbWFuZGAgKGUuZy4geyB0eXBlOiBcInBoYXNlLmFkdmFuY2VcIiB9KS4gQ29udmVyc2F0aW9uIHN0YXlzIHRoZSBwcmltYXJ5XG4gIC8vIGNhcGFiaWxpdHk7IHRoaXMgaXMgc3VnYXIgb24gdG9wLCBzdXJmYWNlZCBieSB0aGUgYWdlbnQgYXQgaXRzIGRpc2NyZXRpb24uXG4gIGFjdGlvbj86IHsgbGFiZWw6IHN0cmluZzsgY29tbWFuZDogQ2xpZW50VG9TZXJ2ZXIgfTtcbn07XG5cbi8vIEEgYm94IGJlZm9yZSB0aGUgZGFlbW9uIGFzc2lnbnMgaXQgYW4gaWQg4oCUIGRyYXduIGJ5IHRoZSB1c2VyIChcIm1hcmsgYSBtaXNzZWRcbi8vIHJlZ2lvblwiKSBvciBieSB0aGUgYWdlbnQgYm94aW5nIGluY3JlbWVudGFsbHkuIFRoZSBkYWVtb24gZmlsbHMgYGlkYCBhbmRcbi8vIGRlZmF1bHRzIG5hbWUvdHlwZS9zdGF0dXMgb24gZWxlbWVudC5hZGQuXG5leHBvcnQgdHlwZSBOZXdFbGVtZW50ID0ge1xuICBiYm94OiBCYm94O1xuICBuYW1lPzogc3RyaW5nO1xuICB0eXBlPzogRWxlbWVudFR5cGU7XG4gIHN0YXR1cz86IEVsZW1lbnRTdGF0dXM7XG59O1xuXG4vLyBUaGUgc291cmNlIGNvbXBvc2l0ZSBpbWFnZSB1bmRlciByZXZpZXcuIGBwYXRoYCBpcyB0aGUgb24tZGlzayBmaWxlIHRoZSBhZ2VudFxuLy8gcmVhZHM7IGBzaXplYCBpcyBbdywgaF0gaW4gcHg7IGBzaGFgIGlzIHRoZSBmaXJzdC0xNiBvZiB0aGUgc2hhMjU2IChtYXRjaGVzXG4vLyB0aGUgUHl0aG9uIG9yaWdpbmFsJ3MgYHNvdXJjZV9zaGEyNTZfMTZgKS5cbmV4cG9ydCB0eXBlIFNvdXJjZSA9IHtcbiAgcGF0aDogc3RyaW5nO1xuICBzaXplOiBbbnVtYmVyLCBudW1iZXJdO1xuICBzaGE6IHN0cmluZztcbn07XG5cbi8vIOKUgOKUgCB0aGUgd2hvbGUgc3RhdGUgKFBST1ZJU0lPTkFMKSDilIDilIBcbmV4cG9ydCB0eXBlIE1hZ3BpZVN0YXRlID0ge1xuICB0aXRsZTogc3RyaW5nO1xuICBpbnRlbnQ6IHN0cmluZzsgLy8gd2hhdCB0aGUgdXNlciB3YW50cyBvdXQgb2YgdGhpcyBib2FyZCAoZnJlZSB0ZXh0IHRoZSBhZ2VudCBzZXRzKVxuICBwaGFzZTogUGhhc2VLZXk7IC8vIHRoZSBsaW5lYXIgcHJvY2VzcyBjdXJzb3IgKEludGFrZSDihpIgU2xpY2Ug4oaSIFJlbW92ZSDihpIgRXhwb3J0KVxuICBzb3VyY2U6IFNvdXJjZSB8IG51bGw7XG4gIGVsZW1lbnRzOiBFbGVtZW50W107XG4gIGNvbnZlcnNhdGlvbjogTWVzc2FnZVtdO1xuICBiYWNrZHJvcDogQmFja2Ryb3A7XG4gIHN0YXR1czogeyBidXN5OiBib29sZWFuOyB0ZXh0OiBzdHJpbmcgfTtcbiAgLy8gVGhlIGJ1aWx0IGV4cG9ydCBidW5kbGUgKEV4cG9ydCBwaGFzZSksIGlmIGFueSDigJQgc2VydmVkIHZpYSAvYXNzZXRzLzxuYW1lPi5cbiAgYnVuZGxlPzogeyBuYW1lOiBzdHJpbmc7IGNvdW50OiBudW1iZXIgfTtcbiAgLy8gVGhlIGN1cnJlbnQgc2Vzc2lvbiBpZCAocnVudGltZTsgdGhlIGRhZW1vbiBzZXRzIGl0IGF0IHN0YXJ0LCBOT1QgcGVyc2lzdGVkLVxuICAvLyBtZWFuaW5nZnVsIHNpbmNlIHJlc3RvcmUgbWludHMgYSBuZXcgb25lKSDigJQgc2hvd24gaW4gRXhwb3J0J3MgcmVvcGVuIGhpbnQuXG4gIHNlc3Npb25JZD86IHN0cmluZztcbn07XG5cbmV4cG9ydCBmdW5jdGlvbiBkZWZhdWx0U3RhdGUodGl0bGU6IHN0cmluZyk6IE1hZ3BpZVN0YXRlIHtcbiAgcmV0dXJuIHtcbiAgICB0aXRsZSxcbiAgICBpbnRlbnQ6IFwiXCIsXG4gICAgcGhhc2U6IFwiaW50YWtlXCIsXG4gICAgc291cmNlOiBudWxsLFxuICAgIGVsZW1lbnRzOiBbXSxcbiAgICBjb252ZXJzYXRpb246IFtdLFxuICAgIGJhY2tkcm9wOiBcInRyYW5zcGFyZW50XCIsXG4gICAgc3RhdHVzOiB7IGJ1c3k6IGZhbHNlLCB0ZXh0OiBcIlwiIH0sXG4gIH07XG59XG5cbi8vIOKUgOKUgCBTZXJ2ZXIg4oaSIGJyb3dzZXIgKFdlYlNvY2tldCkuIFRoZSBicm93c2VyIGhhbmRsZXMgZXhhY3RseSB0aGVzZS4g4pSA4pSAXG5leHBvcnQgdHlwZSBTZXJ2ZXJUb0NsaWVudCA9XG4gIHwgeyB0eXBlOiBcInN0YXRlXCI7IHN0YXRlOiBNYWdwaWVTdGF0ZSB9XG4gIHwgeyB0eXBlOiBcIm1lc3NhZ2VcIjsgdGV4dDogc3RyaW5nIH1cbiAgLy8gYWdlbnQgcHJlc2VuY2Ug4oCUIGlzIGF0IGxlYXN0IG9uZSBhZ2VudCB0YWlsaW5nIC9ldmVudHMgKHdhdGNoaW5nIHRoZSBib2FyZCk/XG4gIC8vIHB1c2hlZCBvbiBjaGFuZ2UgKyBvbiBicm93c2VyIGNvbm5lY3Q7IHJ1bnRpbWUtb25seSwgbmV2ZXIgcGVyc2lzdGVkIGluIHN0YXRlLlxuICB8IHsgdHlwZTogXCJwcmVzZW5jZVwiOyBhZ2VudDogYm9vbGVhbiB9XG4gIHwgeyB0eXBlOiBcInN1Ym1pdFwiIH1cbiAgfCB7IHR5cGU6IFwiY2FuY2VsXCIgfTtcblxuLy8g4pSA4pSAIEJyb3dzZXIg4oaSIHNlcnZlciAoV2ViU29ja2V0KS4gVGhlIGNsaWVudCBzZW5kcyBleGFjdGx5IHRoZXNlLiDilIDilIBcbi8vIEVhY2ggZWl0aGVyIG11dGF0ZXMgc3RhdGUgKHJlLWJyb2FkY2FzdCkgYW5kL29yIGVtaXRzIGFuIFNTRSBldmVudCB0aGUgYWdlbnRcbi8vIHJlYWN0cyB0by5cbmV4cG9ydCB0eXBlIENsaWVudFRvU2VydmVyID1cbiAgfCB7IHR5cGU6IFwic2F5XCI7IHRleHQ6IHN0cmluZyB9IC8vIHVzZXIgcG9zdHMgYSBtZXNzYWdlIC8gaW5zdHJ1Y3Rpb25cbiAgfCB7IHR5cGU6IFwic291cmNlLmltcG9ydFwiOyBuYW1lOiBzdHJpbmc7IGRhdGFVcmw6IHN0cmluZyB9IC8vIHVzZXIgZHJvcHBlZCBhIGNvbXBvc2l0ZSDihpIgZGFlbW9uIG1hdGVyaWFsaXplcyBpdFxuICB8IHsgdHlwZTogXCJlbGVtZW50LmFkZFwiOyBlbGVtZW50OiBOZXdFbGVtZW50IH0gLy8gdXNlciBkcmV3IGEgbWlzc2VkIHJlZ2lvbiBvbiB0aGUgY2FudmFzXG4gIHwgeyB0eXBlOiBcImVsZW1lbnQudXBkYXRlXCI7IGlkOiBzdHJpbmc7IHBhdGNoOiBQYXJ0aWFsPEVsZW1lbnQ+IH0gLy8gbW92ZSAvIHJlc2l6ZSAvIHJlbmFtZSAvIHJldHlwZVxuICB8IHsgdHlwZTogXCJlbGVtZW50LnJlbW92ZVwiOyBpZDogc3RyaW5nIH0gLy8gaGFyZC1kZWxldGUgYSBib3ggKHVzdWFsbHkgYSB1c2VyLWRyYXduIG9uZSlcbiAgfCB7IHR5cGU6IFwiZWxlbWVudC5qdWRnZVwiOyBpZDogc3RyaW5nOyBzdGF0dXM6IEVsZW1lbnRTdGF0dXMgfSAvLyBzb2Z0IGNvbmZpcm0vZHJvcCBhIGRpc2NvdmVyZWQgZWxlbWVudFxuICB8IHsgdHlwZTogXCJleHRyYWN0XCI7IGlkcz86IHN0cmluZ1tdIH0gLy8gY3V0IHNsaWNlcyBmb3IgYWxsIGNvbmZpcm1lZCBlbGVtZW50cywgb3IgYSBzdWJzZXQgKHJlLWN1dClcbiAgfCB7IHR5cGU6IFwiZWxlbWVudC5mbGFnXCI7IGlkOiBzdHJpbmc7IGZsYWdnZWQ6IGJvb2xlYW4gfSAvLyBmbGFnL3VuZmxhZyBmb3IgcmUtcnVuIChyZS1zbGljZSBvciByZS1yZW1vdmUpXG4gIHwgeyB0eXBlOiBcInZlcnNpb24uY2hvb3NlXCI7IGlkOiBzdHJpbmc7IHZlcnNpb25JZDogc3RyaW5nIH0gLy8gdXNlciBwaWNrZWQgYSB2ZXJzaW9uIOKGkiBpdCBiZWNvbWVzIGNob3NlbiAoYW1iaWVudClcbiAgfCB7IHR5cGU6IFwicmVtb3ZlQmdcIjsgaWRzPzogc3RyaW5nW10gfSAvLyByZW1vdmUgYmFja2dyb3VuZHMgZm9yIHRoZXNlIGFscGhhLWVsaWdpYmxlIGVsZW1lbnRzIChhYnNlbnQg4oaSIGFsbCBlbGlnaWJsZSlcbiAgfCB7IHR5cGU6IFwicmV0cnlSZW1vdmFsXCI7IGlkczogc3RyaW5nW10gfSAvLyBcInRyeSBhIGRpZmZlcmVudCByZW1vdmFsXCIg4oCUIGFnZW50IHBpY2tzIGFuIFVOVVNFRCBtb2RlbDsgcGF5bG9hZCBpcyBpZHMgb25seVxuICB8IHsgdHlwZTogXCJiYWNrZHJvcC5zZXRcIjsgYmFja2Ryb3A6IEJhY2tkcm9wIH0gLy8gYW1iaWVudCBwcmV2aWV3IGJhY2tkcm9wXG4gIHwgeyB0eXBlOiBcInBoYXNlLmFkdmFuY2VcIiB9IC8vIHNlYWwgdGhlIGFjdGl2ZSBwaGFzZSwgbW92ZSB0aGUgY3Vyc29yIHRvIHRoZSBuZXh0IChpbXBlcmF0aXZlIGhhbmQtb2ZmKVxuICB8IHsgdHlwZTogXCJwaGFzZS5zZXRcIjsgcGhhc2U6IFBoYXNlS2V5IH0gLy8gYmFjay1uYXYgLyBqdW1wIHRvIGEgcGhhc2UgKGFtYmllbnQpXG4gIHwgeyB0eXBlOiBcImV4cG9ydFwiOyBpZHM/OiBzdHJpbmdbXSB9IC8vIGJ1aWxkIHRoZSBkb3dubG9hZGFibGUgYXNzZXQgYnVuZGxlIChjaG9zZW4gdmVyc2lvbnMgb2YgdGhlc2UgLyBhbGwgbm9uLWRyb3BwZWQpXG4gIHwgeyB0eXBlOiBcInN1Ym1pdFwiIH1cbiAgfCB7IHR5cGU6IFwiY2FuY2VsXCIgfTtcblxuLy8g4pSA4pSAIEFnZW50IOKGkiBzZXJ2ZXIgKFBPU1QgL2NtZCkuIFRoZSBhZ2VudCBkcml2ZXMgdGhlIGRhZW1vbiB3aXRoIGV4YWN0bHkgdGhlc2UuIOKUgOKUgFxuZXhwb3J0IHR5cGUgQWdlbnRDb21tYW5kID1cbiAgfCB7IHR5cGU6IFwiaW5pdFwiOyB0aXRsZT86IHN0cmluZzsgaW50ZW50Pzogc3RyaW5nIH1cbiAgfCB7XG4gICAgICB0eXBlOiBcInNheVwiO1xuICAgICAgdGV4dDogc3RyaW5nO1xuICAgICAgYWN0aW9uPzogeyBsYWJlbDogc3RyaW5nOyBjb21tYW5kOiBDbGllbnRUb1NlcnZlciB9O1xuICAgIH0gLy8gcG9zdCBhZ2VudCBkaWFsb2d1ZSAoa2luZDpcInRleHRcIik7IG9wdGlvbmFsIGlubGluZSBDVEEgc2hvcnRjdXRcbiAgfCB7IHR5cGU6IFwiYXNrXCI7IHRleHQ6IHN0cmluZzsgb3B0aW9ucz86IHN0cmluZ1tdIH0gLy8gcG9zdCBhbiBpbi10aHJlYWQgcXVlc3Rpb25cbiAgfCB7IHR5cGU6IFwic291cmNlLnNldFwiOyBwYXRoOiBzdHJpbmc7IHNpemU6IFtudW1iZXIsIG51bWJlcl07IHNoYTogc3RyaW5nIH0gLy8gdGhlIGNvbXBvc2l0ZSB1bmRlciByZXZpZXdcbiAgfCB7IHR5cGU6IFwiZWxlbWVudHMuc2V0XCI7IGVsZW1lbnRzOiBFbGVtZW50W10gfSAvLyBwb3N0IHRoZSBkaXNjb3ZlcmVkIGJyZWFrZG93blxuICB8IHsgdHlwZTogXCJlbGVtZW50LmFkZFwiOyBlbGVtZW50OiBOZXdFbGVtZW50IH0gLy8gYWdlbnQgYm94ZXMgYSByZWdpb24gaW5jcmVtZW50YWxseVxuICB8IHsgdHlwZTogXCJlbGVtZW50LnVwZGF0ZVwiOyBpZDogc3RyaW5nOyBwYXRjaDogUGFydGlhbDxFbGVtZW50PiB9IC8vIG1vdmUvcmVzaXplL3JlbmFtZS9yZXR5cGUgKHZlcnNpb25zIGFwcGVuZCB2aWEgZWxlbWVudC5hZGRWZXJzaW9uKVxuICB8IHsgdHlwZTogXCJlbGVtZW50LnJlbW92ZVwiOyBpZDogc3RyaW5nIH0gLy8gYWdlbnQgcmV0cmFjdHMgYSBib3hcbiAgfCB7IHR5cGU6IFwiZWxlbWVudC5hZGRWZXJzaW9uXCI7IGlkOiBzdHJpbmc7IHZlcnNpb246IEVsZW1lbnRWZXJzaW9uOyBjaG9vc2U/OiBib29sZWFuIH0gLy8gYWdlbnQgYXBwZW5kcyBhIHByb2R1Y2VkIHZlcnNpb25cbiAgfCB7IHR5cGU6IFwicGhhc2Uuc2V0XCI7IHBoYXNlOiBQaGFzZUtleSB9IC8vIGFnZW50IGFkdmFuY2VzL21vdmVzIHRoZSBjdXJzb3Igb24gdGhlIHVzZXIncyBjb252ZXJzYXRpb25hbCByZXF1ZXN0XG4gIHwgeyB0eXBlOiBcImJ1bmRsZS5zZXRcIjsgbmFtZTogc3RyaW5nOyBjb3VudDogbnVtYmVyIH0gLy8gYWdlbnQgcG9zdHMgdGhlIGJ1aWx0IGV4cG9ydCBidW5kbGUgKHNlcnZlZCB2aWEgL2Fzc2V0cy88bmFtZT4pXG4gIHwgeyB0eXBlOiBcInN0YXR1c1wiOyBidXN5OiBib29sZWFuOyB0ZXh0Pzogc3RyaW5nIH1cbiAgfCB7IHR5cGU6IFwiY2xvc2VcIiB9O1xuXG4vLyBUaGUgYWdlbnQgZXZlbnQgc2V0IChzZXJ2ZXIg4oaSIGFnZW50IFNTRSkg4oCUIElNUEVSQVRJVkVTIE9OTFk6IHRoZSBtb3ZlcyB3aGVyZVxuLy8gdGhlIHVzZXIgKmhhbmRzIHdvcmsgdG8gdGhlIGFnZW50KiwgcGx1cyBsaWZlY3ljbGUuIEFtYmllbnQgZWRpdGluZyBvZiB0aGVcbi8vIGJyZWFrZG93biBpcyBkZWxpYmVyYXRlbHkgTk9UIGhlcmUg4oCUIGJveCBtb3ZlL3Jlc2l6ZS9yZW5hbWUvcmV0eXBlXG4vLyAoZWxlbWVudC51cGRhdGUpLCBkcmF3IChlbGVtZW50LmFkZCksIGRlbGV0ZSAoZWxlbWVudC5yZW1vdmUpLCBjb25maXJtL2Ryb3Bcbi8vIChlbGVtZW50Lmp1ZGdlKSwgcmUtcnVuIGZsYWcgKGVsZW1lbnQuZmxhZyksIHZlcnNpb24gcGljayAodmVyc2lvbi5jaG9vc2UpLCBhbmRcbi8vIGJhY2tkcm9wIGFyZSBhbGwgcmVhY2hhYmxlIGZyb20gL3N0YXRlLCB3aGljaCB0aGUgYWdlbnQgcmVhZHMgYXQgdGhlIG1vbWVudCBhblxuLy8gaW1wZXJhdGl2ZSBmaXJlcy4gUHVzaGluZyBlYWNoIGVkaXQgd291bGQganVzdCBuYXJyYXRlIHRoZSB1c2VyJ3MgYnVzeSB3b3JrLlxuLy8gVGhlIGltcGVyYXRpdmVzOiBgc2F5YCwgYHNvdXJjZS5hZGRlZGAgKOKGkiBkaXNjb3ZlciksIGBleHRyYWN0YCAo4oaSIGN1dCB0aGVcbi8vIGN1cnJlbnQgYm94ZXMpLCBgcmVtb3ZlQmdgICjihpIgcmVtb3ZlIGJhY2tncm91bmRzLCBhZ2VudCBwaWNrcyB0aGUgbW9kZWwpLFxuLy8gYHJldHJ5UmVtb3ZhbGAgKOKGkiB0cnkgYSBkaWZmZXJlbnQgcmVtb3ZhbCwgYWdlbnQgcGlja3MgYW4gdW51c2VkIG1vZGVsKSxcbi8vIGBwaGFzZS5hZHZhbmNlYCAo4oaSIHVzZXIgc2VhbGVkIGEgcGhhc2U7IGEgaGFuZC1vZmYgdG8gdGhlIG5leHQgbGVnKSxcbi8vIGBwaGFzZS5zZXRgICjihpIgdXNlciBzdGVwcGVkIEJBQ0sgdG8gYSBwaGFzZSDigJQgbm90IGFuIGFjdGlvbiB0byB0YWtlLCBidXRcbi8vIGNvbnRleHQgZm9yIHdoYXQncyBjb21pbmcsIGUuZy4gcmUtY3V0cyksIGBzdWJtaXRgLCArIGxpZmVjeWNsZS4gQSBwaGFzZSBzd2l0Y2hcbi8vIGlzIGEgZGVsaWJlcmF0ZSByZWxvY2F0aW9uLCBOT1QgYW1iaWVudCBlZGl0aW5nIOKAlCBzbyBib3RoIGRpcmVjdGlvbnMgYXJlIHB1c2hlZC5cbmV4cG9ydCBjb25zdCBBR0VOVF9FVkVOVF9UWVBFUyA9IE9iamVjdC5mcmVlemUoW1xuICBcInJlYWR5XCIsXG4gIFwiY29ubmVjdGVkXCIsXG4gIFwiZGlzY29ubmVjdGVkXCIsXG4gIFwic2F5XCIsXG4gIFwic291cmNlLmFkZGVkXCIsIC8vIHVzZXIgZHJvcHBlZCBhIGNvbXBvc2l0ZSDigJQgdGhlIGFnZW50IHJ1bnMgZGlzY292ZXIgb24gaXRcbiAgXCJleHRyYWN0XCIsIC8vIHVzZXIgYXNrZWQgdG8gKHJlLSljdXQg4oCUIHRoZSBhZ2VudCByZWFkcyB0aGUgYm94ZXMgZnJvbSAvc3RhdGVcbiAgXCJyZW1vdmVCZ1wiLCAvLyB1c2VyIGFza2VkIHRvIHJlbW92ZSBiYWNrZ3JvdW5kcyDigJQgdGhlIGFnZW50IHBpY2tzIHRoZSBtb2RlbFxuICBcInJldHJ5UmVtb3ZhbFwiLCAvLyB1c2VyIGFza2VkIHRvIHRyeSBhIGRpZmZlcmVudCByZW1vdmFsIOKAlCB0aGUgYWdlbnQgcGlja3MgYW4gVU5VU0VEIG1vZGVsXG4gIFwicGhhc2UuYWR2YW5jZVwiLCAvLyB1c2VyIHNlYWxlZCB0aGUgYWN0aXZlIHBoYXNlIOKAlCBhIGhhbmQtb2ZmIHRvIHRoZSBuZXh0IGxlZyBvZiB3b3JrXG4gIFwicGhhc2Uuc2V0XCIsIC8vIHVzZXIgc3RlcHBlZCBCQUNLIHRvIGEgcGhhc2Ug4oCUIGNvbnRleHQgKHJlLWN1dHMgbGlrZWx5KSwgbm8gYWN0aW9uIHJlcXVpcmVkXG4gIFwiZXhwb3J0XCIsIC8vIHVzZXIgYXNrZWQgdG8gYnVpbGQgdGhlIGRvd25sb2FkYWJsZSBhc3NldCBidW5kbGUg4oCUIHRoZSBhZ2VudCB6aXBzIGl0XG4gIFwic3VibWl0XCIsXG4gIFwiY2xvc2VkXCIsXG5dIGFzIGNvbnN0KTtcbmV4cG9ydCB0eXBlIEFnZW50RXZlbnRUeXBlID0gKHR5cGVvZiBBR0VOVF9FVkVOVF9UWVBFUylbbnVtYmVyXTtcblxuLy8gVHlwZWQgcGF5bG9hZHMgZm9yIHRoZSBldmVudHMgdGhhdCBjYXJyeSBkYXRhLlxuZXhwb3J0IHR5cGUgQWdlbnRFdmVudFBheWxvYWQgPSB7XG4gIHNheTogeyB0ZXh0OiBzdHJpbmcgfTtcbiAgXCJzb3VyY2UuYWRkZWRcIjogeyBwYXRoOiBzdHJpbmc7IHNpemU6IFtudW1iZXIsIG51bWJlcl07IHNoYTogc3RyaW5nIH07XG4gIGV4dHJhY3Q6IHsgaWRzPzogc3RyaW5nW10gfTsgLy8gd2hpY2ggZWxlbWVudHMgdG8gKHJlLSljdXQ7IGFic2VudCDihpIgYWxsIGNvbmZpcm1lZFxuICByZW1vdmVCZzogeyBpZHM/OiBzdHJpbmdbXSB9OyAvLyB3aGljaCBlbGVtZW50cyB0byByZW1vdmUgYmcgZm9yOyBhYnNlbnQg4oaSIGFsbCBlbGlnaWJsZVxuICByZXRyeVJlbW92YWw6IHsgaWRzOiBzdHJpbmdbXSB9OyAvLyB3aGljaCAoZmxhZ2dlZCkgZWxlbWVudHMgdG8gcmUtcmVtb3ZlOyBtb2RlbCBpcyB0aGUgYWdlbnQncyBjYWxsXG4gIFwicGhhc2UuYWR2YW5jZVwiOiB7IHBoYXNlOiBQaGFzZUtleSB9OyAvLyB0aGUgTkVXIHBoYXNlIHRoZSB1c2VyIGFkdmFuY2VkIHRvXG4gIFwicGhhc2Uuc2V0XCI6IHsgcGhhc2U6IFBoYXNlS2V5IH07IC8vIHRoZSBwaGFzZSB0aGUgdXNlciBzdGVwcGVkIGJhY2sgdG9cbiAgZXhwb3J0OiB7IGlkcz86IHN0cmluZ1tdIH07IC8vIHdoaWNoIGVsZW1lbnRzIHRvIGJ1bmRsZSAoYWJzZW50IOKGkiBhbGwgbm9uLWRyb3BwZWQpXG59O1xuIiwKICAgICIvLyBzdXJmYWNlL3N0YXRlL3JlZHVjZS50c1xuLy8gUHVyZSwgaW4tcGxhY2UgbXV0YXRvcnMgb3ZlciBNYWdwaWVTdGF0ZSArIHRoZSBsZWFuIHByb2plY3Rpb24uIFRoZSBkYWVtb25cbi8vIChzZXJ2ZXIudHMpIG9yY2hlc3RyYXRlcyB0aGVzZSAoaXQgb3ducyBpZHMsIGJyb2FkY2FzdCwgU1NFKTsgdGhlc2UgZnVuY3Rpb25zXG4vLyBqdXN0IG11dGF0ZSBjYW5vbmljYWwgc3RhdGUgYW5kIHJlcG9ydCB3aGV0aGVyIGFueXRoaW5nIGNoYW5nZWQsIHNvIHRoZXkncmVcbi8vIHVuaXQtdGVzdGFibGUgd2l0aCBubyBzdWJwcm9jZXNzLiBLZWVwIHRoZW0gVEhJTiDigJQgdGhlIG1hZ3BpZS1zcGVjaWZpYyByZXZpZXdcbi8vIG1hY2hpbmVyeSAoanVkZ21lbnQsIGN1dG91dHMpIGlzIG1vY2tlZCBvdXQgZm9yIG5vdzsgd2lkZW4gdGhlc2UgYXMgaXQgbGFuZHMuXG5cbmltcG9ydCB7XG4gIHR5cGUgQmFja2Ryb3AsXG4gIHR5cGUgRWxlbWVudCxcbiAgdHlwZSBFbGVtZW50U3RhdHVzLFxuICB0eXBlIEVsZW1lbnRWZXJzaW9uLFxuICB0eXBlIE1hZ3BpZVN0YXRlLFxuICB0eXBlIE1lc3NhZ2UsXG4gIHR5cGUgTmV3RWxlbWVudCxcbiAgUEhBU0VTLFxuICB0eXBlIFBoYXNlS2V5LFxuICB0eXBlIFNvdXJjZSxcbn0gZnJvbSBcIi4vdHlwZXNcIjtcblxuLy8g4pSA4pSAIGlkIGhlbHBlcnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5mdW5jdGlvbiByYW5kSGV4KGJ5dGVzOiBudW1iZXIpOiBzdHJpbmcge1xuICBjb25zdCBidWYgPSBuZXcgVWludDhBcnJheShieXRlcyk7XG4gIGNyeXB0by5nZXRSYW5kb21WYWx1ZXMoYnVmKTtcbiAgcmV0dXJuIEFycmF5LmZyb20oYnVmLCAoYikgPT4gYi50b1N0cmluZygxNikucGFkU3RhcnQoMiwgXCIwXCIpKS5qb2luKFwiXCIpO1xufVxuZXhwb3J0IGZ1bmN0aW9uIG5ld0lkKHByZWZpeDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke3ByZWZpeH0tJHtyYW5kSGV4KDQpfWA7XG59XG5cbi8vIOKUgOKUgCBtdXRhdG9ycyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuZXhwb3J0IGZ1bmN0aW9uIHB1c2hNZXNzYWdlKFxuICBzOiBNYWdwaWVTdGF0ZSxcbiAgbTogT21pdDxNZXNzYWdlLCBcImlkXCIgfCBcInRzXCI+ICYgeyBpZD86IHN0cmluZyB9LFxuKTogTWVzc2FnZSB7XG4gIGNvbnN0IG1zZzogTWVzc2FnZSA9IHsgaWQ6IG0uaWQgPz8gbmV3SWQoXCJtXCIpLCB0czogRGF0ZS5ub3coKSwgLi4ubSB9IGFzIE1lc3NhZ2U7XG4gIHMuY29udmVyc2F0aW9uLnB1c2gobXNnKTtcbiAgcmV0dXJuIG1zZztcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNldFN0YXR1cyhzOiBNYWdwaWVTdGF0ZSwgYnVzeTogYm9vbGVhbiwgdGV4dCA9IFwiXCIpOiB2b2lkIHtcbiAgcy5zdGF0dXMgPSB7IGJ1c3ksIHRleHQgfTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNldEludGVudChzOiBNYWdwaWVTdGF0ZSwgaW50ZW50OiBzdHJpbmcpOiB2b2lkIHtcbiAgcy5pbnRlbnQgPSBpbnRlbnQ7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRTb3VyY2UoczogTWFncGllU3RhdGUsIHNvdXJjZTogU291cmNlKTogdm9pZCB7XG4gIHMuc291cmNlID0gc291cmNlO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2V0RWxlbWVudHMoczogTWFncGllU3RhdGUsIGVsZW1lbnRzOiBFbGVtZW50W10pOiB2b2lkIHtcbiAgLy8gVHJ1c3QgdGhlIGFnZW50J3MgZGlzY292ZXJlZCBicmVha2Rvd24gd2hvbGVzYWxlOyBkZWZhdWx0IGFueSBtaXNzaW5nXG4gIC8vIHN0YXR1cyB0byBcInByb3Bvc2VkXCIgc28gdGhlIHN1cmZhY2UgYWx3YXlzIGhhcyBhIGp1ZGdlYWJsZSBlbGVtZW50LCBhbmRcbiAgLy8gKGRlZmVuc2l2ZWx5KSBtaW50IGFuIGlkIGZvciBhbnkgZWxlbWVudCBwb3N0ZWQgd2l0aG91dCBvbmUg4oCUIGRpc2NvdmVyXG4gIC8vIGFzc2lnbnMgaWRzLCBidXQgYSBoYW5kLXJvbGxlZCBgZWxlbWVudHMuc2V0YCBib2R5IG1pZ2h0IG5vdC5cbiAgcy5lbGVtZW50cyA9IGVsZW1lbnRzLm1hcCgoZSkgPT4gKHtcbiAgICAuLi5lLFxuICAgIGlkOiBlLmlkIHx8IG5ld0lkKFwiZVwiKSxcbiAgICBzdGF0dXM6IGUuc3RhdHVzID8/IFwicHJvcG9zZWRcIixcbiAgfSkpO1xufVxuXG4vLyBEZWZhdWx0IG5hbWUgZm9yIGFuIHVubmFtZWQgZHJhd24gcmVnaW9uOiByZWdpb25fPG4+LCB3aGVyZSBuIGlzIG9uZSBwYXN0IHRoZVxuLy8gY291bnQgb2YgZXhpc3RpbmcgcmVnaW9uX1xcZCsgbmFtZXMgKHNvIGEgZGVsZXRlLXRoZW4tZHJhdyBkb2Vzbid0IGNvbGxpZGUgd2l0aFxuLy8gYSBsaXZlIG9uZSDigJQgaXQgbnVtYmVycyBvZmYgdGhlIGN1cnJlbnQgcG9wdWxhdGlvbiwgdGhlIGNoZWFwIGhvdXNlIGhldXJpc3RpYykuXG5jb25zdCBSRUdJT05fUkUgPSAvXnJlZ2lvbl9cXGQrJC87XG5mdW5jdGlvbiBuZXh0UmVnaW9uTmFtZShzOiBNYWdwaWVTdGF0ZSk6IHN0cmluZyB7XG4gIGNvbnN0IG4gPSBzLmVsZW1lbnRzLmZpbHRlcigoZSkgPT4gUkVHSU9OX1JFLnRlc3QoZS5uYW1lKSkubGVuZ3RoICsgMTtcbiAgcmV0dXJuIGByZWdpb25fJHtufWA7XG59XG5cbi8vIEFkZCBhIHVzZXItZHJhd24gKG9yIGFnZW50LWJveGVkKSByZWdpb246IG1pbnQgYW4gaWQsIGRlZmF1bHQgbmFtZS90eXBlL3N0YXR1cy5cbi8vIFJldHVybnMgdGhlIG1hdGVyaWFsaXplZCBFbGVtZW50ICh0aGUgZGFlbW9uIGVtaXRzIGl0IG9uIHRoZSBTU0UvYnJvYWRjYXN0KS5cbmV4cG9ydCBmdW5jdGlvbiBhZGRFbGVtZW50KHM6IE1hZ3BpZVN0YXRlLCBkcmFmdDogTmV3RWxlbWVudCk6IEVsZW1lbnQge1xuICBjb25zdCBlbDogRWxlbWVudCA9IHtcbiAgICBpZDogbmV3SWQoXCJlXCIpLFxuICAgIG5hbWU6IGRyYWZ0Lm5hbWUgfHwgbmV4dFJlZ2lvbk5hbWUocyksXG4gICAgdHlwZTogZHJhZnQudHlwZSA/PyBcIm90aGVyXCIsXG4gICAgYmJveDogZHJhZnQuYmJveCxcbiAgICBzdGF0dXM6IGRyYWZ0LnN0YXR1cyA/PyBcImNvbmZpcm1lZFwiLFxuICB9O1xuICBzLmVsZW1lbnRzLnB1c2goZWwpO1xuICByZXR1cm4gZWw7XG59XG5cbi8vIEhhcmQtZGVsZXRlIGFuIGVsZW1lbnQgYnkgaWQgKGEgdXNlciByZXRyYWN0aW5nIGEgZHJhd24gYm94KS4gUmV0dXJucyB3aGV0aGVyXG4vLyBpdCBleGlzdGVkLlxuZXhwb3J0IGZ1bmN0aW9uIHJlbW92ZUVsZW1lbnQoczogTWFncGllU3RhdGUsIGlkOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgaSA9IHMuZWxlbWVudHMuZmluZEluZGV4KChlKSA9PiBlLmlkID09PSBpZCk7XG4gIGlmIChpIDwgMCkgcmV0dXJuIGZhbHNlO1xuICBzLmVsZW1lbnRzLnNwbGljZShpLCAxKTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbi8vIFBhcnRpYWwtbWVyZ2UgYW4gZWxlbWVudCAodGhlIGFnZW50IHBvc3RpbmcgbmFtZS90eXBlL2Jib3gvc3RhdHVzIGVkaXRzIGxhbmRzXG4vLyBoZXJlKS4gTmV2ZXIgbGV0cyBgaWRgIGJlIG92ZXJ3cml0dGVuLiBSZXR1cm5zIHRydWUgaWYgdGhlIGVsZW1lbnQgZXhpc3RlZC5cbi8vIFZlcnNpb24gcmVzdWx0cyBkbyBOT1QgZmxvdyB0aHJvdWdoIGhlcmUg4oCUIHRoZXkgYXBwZW5kIHZpYSBhZGRWZXJzaW9uIChhIGxpc3Rcbi8vIG9wLCBub3QgYSBmaWVsZCBtZXJnZSkuXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlRWxlbWVudChzOiBNYWdwaWVTdGF0ZSwgaWQ6IHN0cmluZywgcGF0Y2g6IFBhcnRpYWw8RWxlbWVudD4pOiBib29sZWFuIHtcbiAgY29uc3QgZWwgPSBzLmVsZW1lbnRzLmZpbmQoKGUpID0+IGUuaWQgPT09IGlkKTtcbiAgaWYgKCFlbCkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCB7IGlkOiBfZHJvcCwgLi4ucmVzdCB9ID0gcGF0Y2g7XG4gIE9iamVjdC5hc3NpZ24oZWwsIHJlc3QpO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuY29uc3QgRUxFTUVOVF9TVEFUVVNFUzogcmVhZG9ubHkgRWxlbWVudFN0YXR1c1tdID0gW1wicHJvcG9zZWRcIiwgXCJjb25maXJtZWRcIiwgXCJkcm9wcGVkXCJdO1xuXG5leHBvcnQgZnVuY3Rpb24ganVkZ2VFbGVtZW50KHM6IE1hZ3BpZVN0YXRlLCBpZDogc3RyaW5nLCBzdGF0dXM6IEVsZW1lbnRTdGF0dXMpOiBib29sZWFuIHtcbiAgaWYgKCFFTEVNRU5UX1NUQVRVU0VTLmluY2x1ZGVzKHN0YXR1cykpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgZWwgPSBzLmVsZW1lbnRzLmZpbmQoKGUpID0+IGUuaWQgPT09IGlkKTtcbiAgaWYgKCFlbCB8fCBlbC5zdGF0dXMgPT09IHN0YXR1cykgcmV0dXJuIGZhbHNlO1xuICBlbC5zdGF0dXMgPSBzdGF0dXM7XG4gIHJldHVybiB0cnVlO1xufVxuXG4vLyBGbGFnIChvciB1bmZsYWcpIGFuIGVsZW1lbnQgZm9yIGEgcmUtcnVuIOKAlCB0aGUgc29sZSByZXZpZXcgc2lnbmFsLiBBcHByb3ZhbCBpc1xuLy8gdGhlIGFic2VuY2Ugb2YgYSBmbGFnOyBkaXNjYXJkaW5nIGlzIHN0YXR1czpcImRyb3BwZWRcIi4gUmV0dXJucyB3aGV0aGVyIHRoZSBmbGFnXG4vLyBhY3R1YWxseSBjaGFuZ2VkICh0aGUgZGFlbW9uIG9ubHkgYnJvYWRjYXN0cyBvbiBhIGNoYW5nZSkuXG5leHBvcnQgZnVuY3Rpb24gZmxhZ0VsZW1lbnQoczogTWFncGllU3RhdGUsIGlkOiBzdHJpbmcsIGZsYWdnZWQ6IGJvb2xlYW4pOiBib29sZWFuIHtcbiAgY29uc3QgZWwgPSBzLmVsZW1lbnRzLmZpbmQoKGUpID0+IGUuaWQgPT09IGlkKTtcbiAgaWYgKCFlbCkgcmV0dXJuIGZhbHNlO1xuICBpZiAoKGVsLmZsYWdnZWQgPz8gZmFsc2UpID09PSBmbGFnZ2VkKSByZXR1cm4gZmFsc2U7XG4gIGVsLmZsYWdnZWQgPSBmbGFnZ2VkO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuLy8gQXBwZW5kIGEgcHJvZHVjZWQgdmVyc2lvbiwgVVBTRVJUSU5HIGJ5IG1vZGVsOiByZS1ydW5uaW5nIHRoZSBzYW1lIG1vZGVsXG4vLyBvdmVyd3JpdGVzIGl0cyBwYXRoICsgYnVtcHMgcmV2IChjYWNoZS1idXN0KSBhbmQga2VlcHMgdGhlIHN0YWJsZSBpZDsgYSBuZXdcbi8vIG1vZGVsIGFwcGVuZHMgYSByb3cuIEEgZnJlc2ggcmVzdWx0IGNsZWFycyBgZmxhZ2dlZGAgKHRoZSByZXF1ZXN0IGlzIGZ1bGZpbGxlZClcbi8vIGFuZCDigJQgdW5sZXNzIHsgY2hvb3NlOmZhbHNlIH0g4oCUIGJlY29tZXMgdGhlIGNob3NlbiB2ZXJzaW9uLiBSZXR1cm5zIHRoZSBzdG9yZWRcbi8vIHZlcnNpb24sIG9yIG51bGwgaWYgdGhlIGVsZW1lbnQgaXMgZ29uZS5cbmV4cG9ydCBmdW5jdGlvbiBhZGRWZXJzaW9uKFxuICBzOiBNYWdwaWVTdGF0ZSxcbiAgaWQ6IHN0cmluZyxcbiAgdjogRWxlbWVudFZlcnNpb24sXG4gIG9wdHM6IHsgY2hvb3NlPzogYm9vbGVhbiB9ID0ge30sXG4pOiBFbGVtZW50VmVyc2lvbiB8IG51bGwge1xuICBjb25zdCBlbCA9IHMuZWxlbWVudHMuZmluZCgoZSkgPT4gZS5pZCA9PT0gaWQpO1xuICBpZiAoIWVsKSByZXR1cm4gbnVsbDtcbiAgaWYgKCFlbC52ZXJzaW9ucykgZWwudmVyc2lvbnMgPSBbXTtcbiAgY29uc3QgZXhpc3RpbmcgPSBlbC52ZXJzaW9ucy5maW5kKCh4KSA9PiB4Lm1vZGVsID09PSB2Lm1vZGVsKTtcbiAgbGV0IHN0b3JlZDogRWxlbWVudFZlcnNpb247XG4gIGlmIChleGlzdGluZykge1xuICAgIGV4aXN0aW5nLnBhdGggPSB2LnBhdGg7XG4gICAgZXhpc3RpbmcucmV2ID0gKGV4aXN0aW5nLnJldiA/PyAwKSArIDE7XG4gICAgaWYgKHYua2luZCAhPT0gdW5kZWZpbmVkKSBleGlzdGluZy5raW5kID0gdi5raW5kO1xuICAgIGlmICh2Lm5vdGUgIT09IHVuZGVmaW5lZCkgZXhpc3Rpbmcubm90ZSA9IHYubm90ZTtcbiAgICBzdG9yZWQgPSBleGlzdGluZztcbiAgfSBlbHNlIHtcbiAgICBzdG9yZWQgPSB7IC4uLnYsIHJldjogdi5yZXYgPz8gMCB9O1xuICAgIGVsLnZlcnNpb25zLnB1c2goc3RvcmVkKTtcbiAgfVxuICBpZiAob3B0cy5jaG9vc2UgPz8gdHJ1ZSkgZWwuY2hvc2VuVmVyc2lvbklkID0gc3RvcmVkLmlkO1xuICBlbC5mbGFnZ2VkID0gZmFsc2U7XG4gIHJldHVybiBzdG9yZWQ7XG59XG5cbi8vIFRoZSB1c2VyIHNlbGVjdGluZyBhIHZlcnNpb24g4oaSIGl0IGJlY29tZXMgY2hvc2VuIChhbWJpZW50KS4gUmV0dXJucyB3aGV0aGVyIGl0XG4vLyBjaGFuZ2VkOyByZWplY3RzIGFuIHVua25vd24gZWxlbWVudCBvciBhIHZlcnNpb25JZCBub3QgcHJlc2VudCBvbiBpdC5cbmV4cG9ydCBmdW5jdGlvbiBjaG9vc2VWZXJzaW9uKHM6IE1hZ3BpZVN0YXRlLCBpZDogc3RyaW5nLCB2ZXJzaW9uSWQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBlbCA9IHMuZWxlbWVudHMuZmluZCgoZSkgPT4gZS5pZCA9PT0gaWQpO1xuICBpZiAoIWVsIHx8ICEoZWwudmVyc2lvbnMgPz8gW10pLnNvbWUoKHYpID0+IHYuaWQgPT09IHZlcnNpb25JZCkpIHJldHVybiBmYWxzZTtcbiAgaWYgKGVsLmNob3NlblZlcnNpb25JZCA9PT0gdmVyc2lvbklkKSByZXR1cm4gZmFsc2U7XG4gIGVsLmNob3NlblZlcnNpb25JZCA9IHZlcnNpb25JZDtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmNvbnN0IEJBQ0tEUk9QUzogcmVhZG9ubHkgQmFja2Ryb3BbXSA9IFtcIndoaXRlXCIsIFwiZ3JheVwiLCBcImJsYWNrXCIsIFwidHJhbnNwYXJlbnRcIl07XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRCYWNrZHJvcChzOiBNYWdwaWVTdGF0ZSwgYmFja2Ryb3A6IEJhY2tkcm9wKTogYm9vbGVhbiB7XG4gIGlmICghQkFDS0RST1BTLmluY2x1ZGVzKGJhY2tkcm9wKSB8fCBzLmJhY2tkcm9wID09PSBiYWNrZHJvcCkgcmV0dXJuIGZhbHNlO1xuICBzLmJhY2tkcm9wID0gYmFja2Ryb3A7XG4gIHJldHVybiB0cnVlO1xufVxuXG4vLyDilIDilIAgcGhhc2Ugc3BpbmUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbi8vIEFkdmFuY2UgdGhlIGxpbmVhciBwaGFzZSBjdXJzb3IgdG8gdGhlIG5leHQgcGhhc2Ug4oCUIHdoYXQgdGhlIHNlYWwtYW5kLWhhbmQtb2ZmXG4vLyBnYXRlIGZpcmVzLiBSZXR1cm5zIHRoZSBuZXcgcGhhc2UsIG9yIG51bGwgaWYgYWxyZWFkeSBhdCB0aGUgbGFzdCAobm8tb3ApLlxuZXhwb3J0IGZ1bmN0aW9uIGFkdmFuY2VQaGFzZShzOiBNYWdwaWVTdGF0ZSk6IFBoYXNlS2V5IHwgbnVsbCB7XG4gIGNvbnN0IGkgPSBQSEFTRVMuaW5kZXhPZihzLnBoYXNlKTtcbiAgaWYgKGkgPCAwIHx8IGkgPj0gUEhBU0VTLmxlbmd0aCAtIDEpIHJldHVybiBudWxsO1xuICBzLnBoYXNlID0gUEhBU0VTW2kgKyAxXTtcbiAgcmV0dXJuIHMucGhhc2U7XG59XG5cbi8vIFNldCB0aGUgcGhhc2UgY3Vyc29yIGRpcmVjdGx5IChiYWNrLW5hdiAvIGp1bXApLiBWYWxpZGF0ZXMgYWdhaW5zdCBQSEFTRVM7XG4vLyByZXBvcnRzIHdoZXRoZXIgaXQgY2hhbmdlZC5cbmV4cG9ydCBmdW5jdGlvbiBzZXRQaGFzZShzOiBNYWdwaWVTdGF0ZSwgcGhhc2U6IFBoYXNlS2V5KTogYm9vbGVhbiB7XG4gIGlmICghUEhBU0VTLmluY2x1ZGVzKHBoYXNlKSB8fCBzLnBoYXNlID09PSBwaGFzZSkgcmV0dXJuIGZhbHNlO1xuICBzLnBoYXNlID0gcGhhc2U7XG4gIHJldHVybiB0cnVlO1xufVxuXG4vLyBSZWNvcmQgdGhlIGJ1aWx0IGV4cG9ydCBidW5kbGUgKHRoZSBhZ2VudCBwb3N0cyBpdCBhZnRlciB6aXBwaW5nKS4gVGhlIHN1cmZhY2Vcbi8vIG9mZmVycyBpdCBhcyBhIGRvd25sb2FkIHZpYSAvYXNzZXRzLzxuYW1lPi5cbmV4cG9ydCBmdW5jdGlvbiBzZXRCdW5kbGUoczogTWFncGllU3RhdGUsIG5hbWU6IHN0cmluZywgY291bnQ6IG51bWJlcik6IHZvaWQge1xuICBzLmJ1bmRsZSA9IHsgbmFtZSwgY291bnQgfTtcbn1cblxuLy8g4pSA4pSAIGxlYW4gcHJvamVjdGlvbiDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vIFN0cmlwIGFueSAoZXZlbnR1YWxseSBoZWF2eSkgaW5saW5lZCBibG9icyBmcm9tIHRoZSBhZ2VudC1mYWNpbmcgL3N0YXRlIHNvIHRoZVxuLy8gc25hcHNob3Qgc3RheXMgc21hbGw7IHRoZSBhZ2VudCByZWFkcyBvbi1kaXNrIHZlcnNpb24gcGF0aHMgaW5zdGVhZC4gVmVyc2lvbnNcbi8vIGNhcnJ5IG9ubHkgYHBhdGhgIChub3QgaW5saW5lZCBpbWFnZSBkYXRhKSwgc28gdGhpcyBpcyBuZWFyLWlkZW50aXR5IOKAlCBidXQgaXRcbi8vIGRlZmVuc2l2ZWx5IGRyb3BzIGFueSBgc3JjYC9gY3V0b3V0c2AgZmllbGRzIGFuIGVsZW1lbnQgbWlnaHQgaW5saW5lLCBhbmQgbmV2ZXJcbi8vIG11dGF0ZXMgdGhlIHNvdXJjZSBzdGF0ZS5cbmV4cG9ydCBmdW5jdGlvbiBsZWFuU3RhdGUoczogTWFncGllU3RhdGUpOiBNYWdwaWVTdGF0ZSB7XG4gIHJldHVybiB7XG4gICAgLi4ucyxcbiAgICBlbGVtZW50czogcy5lbGVtZW50cy5tYXAoKGUpID0+IHtcbiAgICAgIGNvbnN0IGxlYW4gPSB7IC4uLmUgfSBhcyBFbGVtZW50ICYgeyBzcmM/OiB1bmtub3duOyBjdXRvdXRzPzogdW5rbm93biB9O1xuICAgICAgZGVsZXRlIGxlYW4uc3JjO1xuICAgICAgZGVsZXRlIGxlYW4uY3V0b3V0cztcbiAgICAgIHJldHVybiBsZWFuO1xuICAgIH0pLFxuICB9O1xufVxuIiwKICAgICIvLyBzdXJmYWNlL3N0YXRlL3ZlcnNpb25zLnRzXG4vLyBQdXJlIHZlcnNpb24gaGVscGVycyBzaGFyZWQgYnkgc2VydmVyLnRzIEFORCB0aGUgUmVhY3QgY2xpZW50LiBObyBub2RlOiog4oCUIGtlZXBcbi8vIGJyb3dzZXItc2FmZS4gQW4gZWxlbWVudCdzIHByb2R1Y2VkIGFzc2V0cyBhcmUgYSBtb2RlbC10YWdnZWQgbGlzdCAodmVyc2lvbnNbXSk7XG4vLyB0aGVzZSByZXNvbHZlIFwid2hpY2ggb25lIGlzIHNob3duXCIgYW5kIFwiaXRzIGNhY2hlLWJ1c3RlZCBVUkxcIi5cblxuaW1wb3J0IHR5cGUgeyBFbGVtZW50LCBFbGVtZW50VmVyc2lvbiB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbi8vIFRoZSB2ZXJzaW9uIHRoZSBzdXJmYWNlIHJlbmRlcnM6IHRoZSBleHBsaWNpdGx5IGNob3NlbiBvbmUsIGVsc2UgdGhlIGZpcnN0XG4vLyAodGhlIGNyb3ApLiBUb2xlcmF0ZXMgYW4gYWJzZW50L2VtcHR5IGxpc3QgYW5kIGEgc3RhbGUgY2hvc2VuVmVyc2lvbklkLlxuZXhwb3J0IGZ1bmN0aW9uIGNob3NlblZlcnNpb24oZWw6IEVsZW1lbnQpOiBFbGVtZW50VmVyc2lvbiB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IHZzID0gZWwudmVyc2lvbnMgPz8gW107XG4gIHJldHVybiB2cy5maW5kKCh2KSA9PiB2LmlkID09PSBlbC5jaG9zZW5WZXJzaW9uSWQpID8/IHZzWzBdO1xufVxuXG4vLyBUaGUgL2Fzc2V0cyBVUkwgZm9yIGEgdmVyc2lvbiwgY2FjaGUtYnVzdGVkIGJ5IGl0cyByZXYuIEEgcmUtcnVuIG92ZXJ3cml0ZXMgdGhlXG4vLyBmaWxlIGluIHBsYWNlLCBzbyB3aXRob3V0ID92PTxyZXY+IHRoZSBicm93c2VyIHNob3dzIHRoZSBzdGFsZSBjYWNoZWQgaW1hZ2UuXG5leHBvcnQgZnVuY3Rpb24gdmVyc2lvblVybCh2OiBFbGVtZW50VmVyc2lvbik6IHN0cmluZyB7XG4gIHJldHVybiBgL2Fzc2V0cy8ke3YucGF0aC5zcGxpdChcIi9cIikucG9wKCl9P3Y9JHt2LnJldiA/PyAwfWA7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3Mgb25lLWxpbmUgSlNPTiBlbWl0dGVyIOKAlCBPTkUgaW1wbGVtZW50YXRpb24sIGltcG9ydGVkIGJ5IGV2ZXJ5XG4gKiBzcGVsbCB0aGF0IHNwZWFrcyB0aGUgYWdlbnQgd2lyZS5cbiAqXG4gKiDim5QgVEhJUyBGSUxFIElTIGBzcmMva2l0L2AncyBGSVJTVCBJTkhBQklUQU5ULCBhbmQgdGhhdCBpcyBsb2FkLWJlYXJpbmcgYmV5b25kXG4gKiB0aGUgc2hhcmluZyBpdCBkb2VzLiBXYXJkIDIgKFwidGhlIGtpdCBpcyBhIGxlYWZcIikgaGFzIGJlZW4gZ3JlZW4gYnlcbiAqIENPTlNUUlVDVElPTiBzaW5jZSBQaGFzZSAwIOKAlCBpdCBoYWQgbm90aGluZyB0byB3YWxrLCBhbmQgc2FpZCBzbyBvbiBldmVyeVxuICogcnVuLiBUaGlzIG1vZHVsZSBpcyB0aGUgZmlyc3QgdGhpbmcgaXQgYWN0dWFsbHkgZ3VhcmRzLCB3aGljaCBpcyB3aHkgdGhlXG4gKiB3YXJkJ3MgemVyby1ndWFyZCBjZWxsIGRpc3Rpbmd1aXNoZXMgYW4gQUJTRU5UIGtpdCBmcm9tIGFuIEVNUFRZIG9uZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCBub3QgYSBzcGVsbCxcbiAqIG5vdCBhIHN1cmZhY2UsIG5vdCBhIGJhY2tlbmQuIFRoYXQgaXMgd2FyZCAyJ3MgYXNzZXJ0aW9uLCBub3QgYSBjb252ZW50aW9uLFxuICogYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhlIGtpdCBzYWZlIHRvIGlubGluZSBpbnRvIGFueSBzcGVsbCdzIGJ1bmRsZS5cbiAqXG4gKiBEZWxpYmVyYXRlbHkgZGVwZW5kZW5jeS1mcmVlIGFuZCBkZWxpYmVyYXRlbHkgZHVsbDogaXQgaXMgYnVuZGxlZCBJTlRPIGVhY2hcbiAqIHNwZWxsJ3MgZW1pdHRlZCBDTEkgKENvbnRyYWN0IDQncyBidWlsdC1iYWNrZW5kIGFtZW5kbWVudCksIHNvIGFueXRoaW5nIGl0XG4gKiByZWFjaGVkIGZvciB3b3VsZCBiZWNvbWUgYSBkZXBlbmRlbmN5IG9mIHR3byBzaGlwcGVkIGFydGlmYWN0cyBhdCBvbmNlLlxuICpcbiAqIFRoZSB3aXJlIGNvbnRyYWN0IGl0IGVuY29kZXM6IGV4YWN0bHkgb25lIEpTT04gZG9jdW1lbnQsIG9uZSB0cmFpbGluZ1xuICogbmV3bGluZSwgbm90aGluZyBlbHNlIG9uIHN0ZG91dC4gQSBjYWxsZXIgcmVhZGluZyBvdXIgc3Rkb3V0IHdpdGggYVxuICogbGluZS1kZWxpbWl0ZWQgcGFyc2VyIGRlcGVuZHMgb24gdGhhdCBuZXdsaW5lOyBhIGNhbGxlciByZWFkaW5nIHRvIEVPRlxuICogZGVwZW5kcyBvbiB0aGVyZSBiZWluZyBubyBzZWNvbmQgZG9jdW1lbnQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwcmludEpzb24oZGF0YTogdW5rbm93bik6IHZvaWQge1xuICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtKU09OLnN0cmluZ2lmeShkYXRhKX1cXG5gKTtcbn1cbiIKICBdLAogICJtYXBwaW5ncyI6ICI7Ozs7QUF3QkE7QUFDQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQVVBO0FBQ0EsOEJBQW1CLGtCQUFTO0FBQzVCO0FBQ0Esc0JBQVM7OztBQzNCVDs7O0FDRE8sSUFBTSxtQkFBNkMsSUFBSSxJQUFJO0FBQUEsRUFDaEU7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFDRixDQUFDO0FBR00sSUFBTSx3QkFBa0QsSUFBSSxJQUFJO0FBQUEsRUFDckU7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUNGLENBQUM7QUFJTSxTQUFTLFlBQVksQ0FBQyxNQUFjLFFBQThCO0FBQUEsRUFDdkUsSUFBSSxXQUFXO0FBQUEsSUFBUSxPQUFPO0FBQUEsRUFDOUIsSUFBSSxXQUFXO0FBQUEsSUFBTyxPQUFPLENBQUMsc0JBQXNCLElBQUksSUFBbUI7QUFBQSxFQUMzRSxPQUFPLGlCQUFpQixJQUFJLElBQW1CO0FBQUE7OztBRCtCakQsSUFBTSxZQUFZLEtBQUssWUFBWSxLQUFLLFdBQVc7QUFFbkQsU0FBUyxPQUFPLENBQUMsUUFBd0I7QUFBQSxFQUN2QyxNQUFNLE1BQU0sSUFBSSxXQUFXLENBQUM7QUFBQSxFQUM1QixPQUFPLGdCQUFnQixHQUFHO0FBQUEsRUFDMUIsTUFBTSxNQUFNLE1BQU0sS0FBSyxLQUFLLENBQUMsTUFBTSxFQUFFLFNBQVMsRUFBRSxFQUFFLFNBQVMsR0FBRyxHQUFHLENBQUMsRUFBRSxLQUFLLEVBQUU7QUFBQSxFQUMzRSxPQUFPLEdBQUcsVUFBVTtBQUFBO0FBTWYsSUFBTSxlQUErQjtBQUFBLEVBQzFDLE1BQU07QUFBQSxPQUNBLElBQUcsQ0FBQyxNQUFZLFNBQWlCLE9BQW1CLENBQUMsR0FBb0I7QUFBQSxJQUM3RSxPQUFPLElBQUksSUFBSSxJQUFJLE1BQU0sS0FBSztBQUFBLElBQzlCLE1BQU0sT0FBTztBQUFBLE1BQ1g7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0EsS0FBSztBQUFBLE1BQ0w7QUFBQSxNQUNBLEdBQUcsTUFBTSxNQUFNLE1BQU07QUFBQSxNQUNyQjtBQUFBLE1BQ0EsS0FBSztBQUFBLE1BQ0w7QUFBQSxNQUNBO0FBQUEsSUFDRjtBQUFBLElBQ0EsSUFBSSxLQUFLO0FBQUEsTUFBTyxLQUFLLEtBQUssV0FBVyxLQUFLLEtBQUs7QUFBQSxJQUMvQyxJQUFJLE9BQU8sS0FBSyxRQUFRO0FBQUEsTUFBVSxLQUFLLEtBQUssU0FBUyxPQUFPLEtBQUssR0FBRyxDQUFDO0FBQUEsSUFDckUsSUFBSSxLQUFLO0FBQUEsTUFBTyxLQUFLLEtBQUssV0FBVyxLQUFLLEtBQUs7QUFBQSxJQUUvQyxNQUFNLE9BQU8sSUFBSSxNQUFNLE1BQU0sRUFBRSxRQUFRLFFBQVEsUUFBUSxPQUFPLENBQUM7QUFBQSxJQUMvRCxPQUFPLFFBQVEsUUFBUSxZQUFZLE1BQU0sUUFBUSxJQUFJO0FBQUEsTUFDbkQsSUFBSSxTQUFTLEtBQUssTUFBTSxFQUFFLEtBQUs7QUFBQSxNQUMvQixJQUFJLFNBQVMsS0FBSyxNQUFNLEVBQUUsS0FBSztBQUFBLE1BQy9CLEtBQUs7QUFBQSxJQUNQLENBQUM7QUFBQSxJQUNELElBQUksYUFBYSxHQUFHO0FBQUEsTUFDbEIsTUFBTSxJQUFJLE1BQ1IsZ0NBQWdDLGNBQWMsT0FBTyxLQUFLLEtBQUssT0FBTyxLQUFLLEdBQzdFO0FBQUEsSUFDRjtBQUFBLElBQ0EsTUFBTSxPQUFPLE9BQU8sS0FBSyxFQUFFLE1BQU07QUFBQSxDQUFJLEVBQUUsT0FBTyxPQUFPLEVBQUUsSUFBSSxLQUFLO0FBQUEsSUFDaEUsSUFBSTtBQUFBLElBQ0osSUFBSTtBQUFBLE1BQ0YsU0FBUyxLQUFLLE1BQU0sSUFBSTtBQUFBLE1BQ3hCLE1BQU07QUFBQSxNQUNOLE1BQU0sSUFBSSxNQUFNLG9EQUFvRCxPQUFPLEtBQUssR0FBRztBQUFBO0FBQUEsSUFFckYsT0FBTyxFQUFFLElBQUksUUFBUSxLQUFLLEdBQUcsU0FBUyxTQUFTLE1BQU0sT0FBTyxPQUFPLFFBQVE7QUFBQTtBQUUvRTtBQVNPLElBQU0sb0JBQW9DO0FBQUEsRUFDL0MsTUFBTTtBQUFBLE9BQ0EsSUFBRyxDQUFDLE1BQVksU0FBaUIsT0FBbUIsQ0FBQyxHQUFvQjtBQUFBLElBQzdFLE1BQU0sUUFBUSxLQUFLO0FBQUEsSUFDbkIsSUFBSSxDQUFDO0FBQUEsTUFBTyxNQUFNLElBQUksTUFBTSxrRUFBa0U7QUFBQSxJQUM5RixNQUFNLE9BQU87QUFBQSxNQUNYO0FBQUEsTUFDQTtBQUFBLE1BQ0E7QUFBQSxNQUNBLFdBQVc7QUFBQSxNQUNYLFNBQVMsS0FBSztBQUFBLE1BQ2Q7QUFBQSxNQUNBO0FBQUEsSUFDRjtBQUFBLElBQ0EsTUFBTSxPQUFPLElBQUksTUFBTSxNQUFNLEVBQUUsUUFBUSxRQUFRLFFBQVEsT0FBTyxDQUFDO0FBQUEsSUFDL0QsT0FBTyxRQUFRLFFBQVEsWUFBWSxNQUFNLFFBQVEsSUFBSTtBQUFBLE1BQ25ELElBQUksU0FBUyxLQUFLLE1BQU0sRUFBRSxLQUFLO0FBQUEsTUFDL0IsSUFBSSxTQUFTLEtBQUssTUFBTSxFQUFFLEtBQUs7QUFBQSxNQUMvQixLQUFLO0FBQUEsSUFDUCxDQUFDO0FBQUEsSUFDRCxJQUFJLGFBQWEsR0FBRztBQUFBLE1BQ2xCLE1BQU0sSUFBSSxNQUNSLHNDQUFzQyxjQUFjLE9BQU8sS0FBSyxLQUFLLE9BQU8sS0FBSyxHQUNuRjtBQUFBLElBQ0Y7QUFBQSxJQUNBLElBQUk7QUFBQSxJQUNKLElBQUk7QUFBQSxNQUNGLFNBQVMsS0FBSyxNQUFNLE9BQU8sS0FBSyxFQUFFLE1BQU07QUFBQSxDQUFJLEVBQUUsT0FBTyxPQUFPLEVBQUUsSUFBSSxLQUFLLEVBQUU7QUFBQSxNQUN6RSxNQUFNO0FBQUEsTUFDTixNQUFNLElBQUksTUFBTSxnREFBZ0QsT0FBTyxLQUFLLEdBQUc7QUFBQTtBQUFBLElBRWpGLE1BQU0sTUFBTSxRQUFRLE1BQU0sVUFBVSxJQUFJO0FBQUEsSUFDeEMsSUFBSSxDQUFDO0FBQUEsTUFBSyxNQUFNLElBQUksTUFBTSx1Q0FBdUMsT0FBTyxLQUFLLEdBQUc7QUFBQSxJQUNoRixNQUFNLE1BQU0sTUFBTSxNQUFNLEdBQUc7QUFBQSxJQUMzQixJQUFJLENBQUMsSUFBSTtBQUFBLE1BQUksTUFBTSxJQUFJLE1BQU0sNENBQTRDLElBQUksU0FBUztBQUFBLElBQ3RGLE1BQU0sSUFBSSxNQUFNLFNBQVMsR0FBRztBQUFBLElBQzVCLE9BQU8sRUFBRSxJQUFJLFFBQVEsS0FBSyxHQUFHLFNBQVMsZUFBZSxNQUFNLFFBQVE7QUFBQTtBQUV2RTtBQVFPLFNBQVMsaUJBQWlCLENBQUMsT0FBd0I7QUFBQSxFQUN4RCxPQUFPLE1BQU0sU0FBUyxHQUFHO0FBQUE7QUFJcEIsSUFBTSxtQkFBbUQ7QUFBQSxHQUM3RCxhQUFhLE9BQU87QUFBQSxHQUNwQixrQkFBa0IsT0FBTztBQUM1Qjs7O0FFdEtBLG1DQUEyQjtBQUdwQixJQUFNLGlCQUFpQjtBQUN2QixJQUFNLGdCQUFnQjtBQUd0QixJQUFNLFNBQVM7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFnQmYsSUFBTSxrQkFBa0IsS0FBSyxPQUFPO0FBQ3BDLElBQU0sbUJBQW1CLEtBQUssT0FBTztBQUU1QyxJQUFNLGNBQXNDO0FBQUEsRUFDMUMsUUFBUTtBQUFBLEVBQ1IsU0FBUztBQUFBLEVBQ1QsUUFBUTtBQUFBLEVBQ1IsU0FBUztBQUFBLEVBQ1QsUUFBUTtBQUNWO0FBQUE7QUFxQk8sTUFBTSxzQkFBc0IsTUFBTTtBQUFDO0FBTW5DLFNBQVMsV0FBVyxDQUFDLFNBQTRCO0FBQUEsRUFDdEQsSUFBSSxJQUFJLFFBQVEsS0FBSztBQUFBLEVBQ3JCLE1BQU0sUUFBUSxrQ0FBa0MsS0FBSyxDQUFDO0FBQUEsRUFDdEQsSUFBSTtBQUFBLElBQU8sSUFBSSxNQUFNO0FBQUEsRUFDckIsT0FBTyxLQUFLLE1BQU0sQ0FBQztBQUFBO0FBTWQsU0FBUyxpQkFBaUIsQ0FBQyxLQUFlLE9BQWUsUUFBc0I7QUFBQSxFQUNwRixPQUFPLElBQUksSUFBSSxJQUFJLE1BQU07QUFBQSxFQUN6QixNQUFNLE1BQU0sS0FBSyxJQUFJLEdBQUcsS0FBSyxNQUFPLEtBQUssT0FBUSxLQUFLLENBQUM7QUFBQSxFQUN2RCxNQUFNLE1BQU0sS0FBSyxJQUFJLEdBQUcsS0FBSyxNQUFPLEtBQUssT0FBUSxNQUFNLENBQUM7QUFBQSxFQUN4RCxNQUFNLE1BQU0sS0FBSyxJQUFJLE9BQU8sS0FBSyxNQUFPLEtBQUssT0FBUSxLQUFLLENBQUM7QUFBQSxFQUMzRCxNQUFNLE1BQU0sS0FBSyxJQUFJLFFBQVEsS0FBSyxNQUFPLEtBQUssT0FBUSxNQUFNLENBQUM7QUFBQSxFQUM3RCxPQUFPLENBQUMsS0FBSyxLQUFLLEtBQUssR0FBRztBQUFBO0FBS3JCLFNBQVMsZUFBZSxDQUFDLEtBQWdCLE9BQWUsUUFBbUM7QUFBQSxFQUNoRyxNQUFNLFdBQThCLENBQUM7QUFBQSxFQUNyQyxXQUFXLFNBQVMsS0FBSztBQUFBLElBQ3ZCLElBQUksQ0FBQyxTQUFTLE9BQU8sVUFBVTtBQUFBLE1BQVU7QUFBQSxJQUN6QyxNQUFNLElBQUk7QUFBQSxJQUNWLE1BQU0sT0FBTyxFQUFFO0FBQUEsSUFDZixNQUFNLE9BQVEsT0FBTyxFQUFFLFNBQVMsV0FBVyxFQUFFLE9BQU87QUFBQSxJQUNwRCxNQUFNLE1BQU0sRUFBRTtBQUFBLElBQ2QsSUFBSSxDQUFDLFFBQVEsT0FBTyxTQUFTLFlBQVksQ0FBQyxNQUFNLFFBQVEsR0FBRztBQUFBLE1BQUc7QUFBQSxJQUM5RCxTQUFTLEtBQUs7QUFBQSxNQUNaO0FBQUEsTUFDQSxNQUFNO0FBQUEsTUFDTixRQUFRO0FBQUEsTUFDUixZQUFZLGtCQUFrQixLQUFpQixPQUFPLE1BQU07QUFBQSxJQUM5RCxDQUFDO0FBQUEsRUFDSDtBQUFBLEVBQ0EsT0FBTztBQUFBO0FBS0YsU0FBUyxXQUFXLENBQUMsTUFBc0I7QUFBQSxFQUNoRCxPQUFPLFlBQVksUUFBUSxJQUFJLEVBQUUsWUFBWSxNQUFNO0FBQUE7QUFLckQsZUFBc0Isa0JBQWtCLENBQUMsTUFBK0I7QUFBQSxFQUN0RSxNQUFNLE9BQU8sSUFBSSxLQUFLLElBQUk7QUFBQSxFQUMxQixNQUFNLE9BQU8sS0FBSztBQUFBLEVBQ2xCLElBQUksT0FBTyxpQkFBaUI7QUFBQSxJQUMxQixNQUFNLE1BQU0sT0FBTyxTQUFXLFFBQVEsQ0FBQztBQUFBLElBQ3ZDLE1BQU0sUUFBUSxLQUFLLE1BQU0sa0JBQWtCLE9BQVM7QUFBQSxJQUNwRCxNQUFNLElBQUksY0FDUixHQUFHLFdBQVcsb0JBQW9CLDRDQUNoQyxxRUFDSjtBQUFBLEVBQ0Y7QUFBQSxFQUNBLElBQUksT0FBTyxrQkFBa0I7QUFBQSxJQUMzQixRQUFRLE9BQU8sTUFDYixTQUFTLFlBQVksT0FBTyxTQUFXLFFBQVEsQ0FBQztBQUFBLENBQ2xEO0FBQUEsRUFDRjtBQUFBLEVBQ0EsTUFBTSxRQUFRLElBQUksV0FBVyxNQUFNLEtBQUssWUFBWSxDQUFDO0FBQUEsRUFDckQsTUFBTSxNQUFNLE9BQU8sS0FBSyxLQUFLLEVBQUUsU0FBUyxRQUFRO0FBQUEsRUFDaEQsT0FBTyxRQUFRLFlBQVksSUFBSSxZQUFZO0FBQUE7QUFJN0MsZUFBc0IsU0FBUyxDQUFDLE1BQXlDO0FBQUEsRUFDdkUsTUFBTSxRQUFRLElBQUksV0FBVyxNQUFNLElBQUksS0FBSyxJQUFJLEVBQUUsWUFBWSxDQUFDO0FBQUEsRUFDL0QsTUFBTSxPQUFPLE1BQU0sSUFBSSxJQUFJLE1BQU0sS0FBSyxFQUFFLFNBQVM7QUFBQSxFQUNqRCxPQUFPLENBQUMsS0FBSyxTQUFTLEdBQUcsS0FBSyxVQUFVLENBQUM7QUFBQTtBQUkzQyxlQUFzQixlQUFlLENBQUMsTUFBK0I7QUFBQSxFQUNuRSxNQUFNLFFBQVEsSUFBSSxXQUFXLE1BQU0sSUFBSSxLQUFLLElBQUksRUFBRSxZQUFZLENBQUM7QUFBQSxFQUMvRCxPQUFPLElBQUksSUFBSSxhQUFhLFFBQVEsRUFBRSxPQUFPLEtBQUssRUFBRSxPQUFPLEtBQUssRUFBRSxNQUFNLEdBQUcsRUFBRTtBQUFBO0FBSy9FLGVBQXNCLGNBQWMsQ0FDbEMsUUFDQSxPQUNBLGNBQ0EsUUFDa0M7QUFBQSxFQUNsQyxNQUFNLE9BQU87QUFBQSxJQUNYO0FBQUEsSUFDQSxVQUFVO0FBQUEsTUFDUjtBQUFBLFFBQ0UsTUFBTTtBQUFBLFFBQ04sU0FBUztBQUFBLFVBQ1AsRUFBRSxNQUFNLFFBQVEsTUFBTSxPQUFPO0FBQUEsVUFDN0IsRUFBRSxNQUFNLGFBQWEsV0FBVyxFQUFFLEtBQUssYUFBYSxFQUFFO0FBQUEsUUFDeEQ7QUFBQSxNQUNGO0FBQUEsSUFDRjtBQUFBLElBQ0EsYUFBYTtBQUFBLEVBQ2Y7QUFBQSxFQUNBLE1BQU0sT0FBTyxJQUFJO0FBQUEsRUFDakIsTUFBTSxRQUFRLFdBQVcsTUFBTSxLQUFLLE1BQU0sR0FBRyxNQUFPO0FBQUEsRUFDcEQsSUFBSTtBQUFBLElBQ0YsTUFBTSxNQUFNLE1BQU0sTUFBTSxnQkFBZ0I7QUFBQSxNQUN0QyxRQUFRO0FBQUEsTUFDUixTQUFTO0FBQUEsUUFDUCxlQUFlLFVBQVU7QUFBQSxRQUN6QixnQkFBZ0I7QUFBQSxRQUNoQixnQkFBZ0I7QUFBQSxRQUNoQixXQUFXO0FBQUEsTUFDYjtBQUFBLE1BQ0EsTUFBTSxLQUFLLFVBQVUsSUFBSTtBQUFBLE1BQ3pCLFFBQVEsS0FBSztBQUFBLElBQ2YsQ0FBQztBQUFBLElBQ0QsSUFBSSxDQUFDLElBQUksSUFBSTtBQUFBLE1BQ1gsTUFBTSxPQUFPLE1BQU0sSUFBSSxLQUFLLEVBQUUsTUFBTSxNQUFNLEVBQUU7QUFBQSxNQUM1QyxNQUFNLElBQUksY0FBYyxtQkFBbUIsSUFBSSxXQUFXLE1BQU07QUFBQSxJQUNsRTtBQUFBLElBQ0EsT0FBUSxNQUFNLElBQUksS0FBSztBQUFBLFlBQ3ZCO0FBQUEsSUFDQSxhQUFhLEtBQUs7QUFBQTtBQUFBO0FBWXRCLGVBQXNCLFFBQVEsQ0FBQyxXQUFtQixPQUF3QixDQUFDLEdBQXNCO0FBQUEsRUFDL0YsTUFBTSxRQUFRLEtBQUssU0FBUztBQUFBLEVBQzVCLE1BQU0sU0FBUyxLQUFLLFVBQVUsUUFBUSxJQUFJO0FBQUEsRUFDMUMsSUFBSSxDQUFDLFFBQVE7QUFBQSxJQUNYLE1BQU0sSUFBSSxjQUFjLG9DQUFvQztBQUFBLEVBQzlEO0FBQUEsRUFDQSxJQUFJLENBQUUsTUFBTSxJQUFJLEtBQUssU0FBUyxFQUFFLE9BQU8sR0FBSTtBQUFBLElBQ3pDLE1BQU0sSUFBSSxjQUFjLG9CQUFvQixXQUFXO0FBQUEsRUFDekQ7QUFBQSxFQUVBLE9BQU8sTUFBTSxTQUFTLE9BQU8sTUFBTSxRQUFRLElBQUk7QUFBQSxJQUM3QyxVQUFVLFNBQVM7QUFBQSxJQUNuQixtQkFBbUIsU0FBUztBQUFBLElBQzVCLGdCQUFnQixTQUFTO0FBQUEsRUFDM0IsQ0FBQztBQUFBLEVBQ0QsT0FBTyxPQUFPLFVBQVU7QUFBQSxFQUV4QixNQUFNLE9BQU8sTUFBTSxlQUFlLFFBQVEsT0FBTyxTQUFTLE1BQU07QUFBQSxFQUVoRSxNQUFNLFVBQVUsS0FBSztBQUFBLEVBQ3JCLE1BQU0sVUFBVSxVQUFVLElBQUksU0FBUztBQUFBLEVBQ3ZDLElBQUksT0FBTyxZQUFZLFVBQVU7QUFBQSxJQUMvQixNQUFNLElBQUksY0FDUjtBQUFBLEVBQStFLEtBQUssVUFBVSxJQUFJLEVBQUUsTUFBTSxHQUFHLElBQUksR0FDbkg7QUFBQSxFQUNGO0FBQUEsRUFFQSxNQUFNLFFBQVMsS0FBSyxTQUFxQyxDQUFDO0FBQUEsRUFDMUQsTUFBTSxPQUFPLE9BQU8sTUFBTSxTQUFTLFdBQVcsTUFBTSxPQUFPO0FBQUEsRUFDM0QsTUFBTSxlQUFlLE9BQU8sTUFBTSxrQkFBa0IsV0FBVyxNQUFNLGdCQUFnQjtBQUFBLEVBQ3JGLE1BQU0sbUJBQ0osT0FBTyxNQUFNLHNCQUFzQixXQUFXLE1BQU0sb0JBQW9CO0FBQUEsRUFDMUUsTUFBTSxVQUFXLE1BQU0sNkJBQXlELENBQUM7QUFBQSxFQUNqRixNQUFNLGtCQUNKLE9BQU8sUUFBUSxxQkFBcUIsV0FBVyxRQUFRLG1CQUFtQjtBQUFBLEVBRTVFLElBQUk7QUFBQSxFQUNKLElBQUk7QUFBQSxJQUNGLE1BQU0sWUFBWSxPQUFPO0FBQUEsSUFDekIsT0FBTyxJQUFJO0FBQUEsSUFDWCxNQUFNLElBQUksY0FDUjtBQUFBLEVBQW9DO0FBQUE7QUFBQSxlQUEyQixjQUFjLFFBQVEsR0FBRyxVQUFVLE9BQU8sRUFBRSxHQUM3RztBQUFBO0FBQUEsRUFHRixPQUFPO0FBQUEsSUFDTCxRQUFRLFFBQVEsU0FBUztBQUFBLElBQ3pCLGFBQWEsQ0FBQyxPQUFPLE1BQU07QUFBQSxJQUMzQixrQkFBa0I7QUFBQSxJQUNsQjtBQUFBLElBQ0EsVUFBVTtBQUFBLElBQ1YsUUFBUSxFQUFFLFFBQVEsY0FBYyxZQUFZLGtCQUFrQixXQUFXLGdCQUFnQjtBQUFBLElBQ3pGLFVBQVUsZ0JBQWdCLEtBQUssT0FBTyxNQUFNO0FBQUEsRUFDOUM7QUFBQTtBQXdERixJQUFJLE9BQWtCLENBU3RCOzs7QUM1Rk8sSUFBTSxvQkFBb0IsT0FBTyxPQUFPO0FBQUEsRUFDN0M7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFDRixDQUFVOzs7QUM5TlYsU0FBUyxPQUFPLENBQUMsT0FBdUI7QUFBQSxFQUN0QyxNQUFNLE1BQU0sSUFBSSxXQUFXLEtBQUs7QUFBQSxFQUNoQyxPQUFPLGdCQUFnQixHQUFHO0FBQUEsRUFDMUIsT0FBTyxNQUFNLEtBQUssS0FBSyxDQUFDLE1BQU0sRUFBRSxTQUFTLEVBQUUsRUFBRSxTQUFTLEdBQUcsR0FBRyxDQUFDLEVBQUUsS0FBSyxFQUFFO0FBQUE7QUFFakUsU0FBUyxLQUFLLENBQUMsUUFBd0I7QUFBQSxFQUM1QyxPQUFPLEdBQUcsVUFBVSxRQUFRLENBQUM7QUFBQTs7O0FDbEJ4QixTQUFTLGFBQWEsQ0FBQyxJQUF5QztBQUFBLEVBQ3JFLE1BQU0sS0FBSyxHQUFHLFlBQVksQ0FBQztBQUFBLEVBQzNCLE9BQU8sR0FBRyxLQUFLLENBQUMsTUFBTSxFQUFFLE9BQU8sR0FBRyxlQUFlLEtBQUssR0FBRztBQUFBOzs7QUNZcEQsU0FBUyxTQUFTLENBQUMsTUFBcUI7QUFBQSxFQUM3QyxRQUFRLE9BQU8sTUFBTSxHQUFHLEtBQUssVUFBVSxJQUFJO0FBQUEsQ0FBSztBQUFBOzs7QVA2QmxELFFBQVEsT0FBTyxHQUFHLFNBQVMsQ0FBQyxNQUE2QjtBQUFBLEVBQ3ZELElBQUksRUFBRSxTQUFTO0FBQUEsSUFBUyxRQUFRLEtBQUssQ0FBQztBQUFBLENBQ3ZDO0FBRUQsSUFBTSxhQUFhLFNBQVEsY0FBYyxZQUFZLEdBQUcsQ0FBQztBQUd6RCxJQUFNLGdCQUFnQixNQUFLLFlBQVksTUFBTSxXQUFXLFdBQVc7QUFPbkUsU0FBUyxpQkFBaUIsR0FBa0I7QUFBQSxFQUMxQyxJQUFJO0FBQUEsSUFDRixNQUFNLGlCQUFpQixNQUFLLFlBQVksTUFBTSxNQUFNLE1BQU0sa0JBQWtCLGFBQWE7QUFBQSxJQUN6RixPQUFPLEtBQUssTUFBTSxhQUFhLGdCQUFnQixPQUFPLENBQUMsRUFBRSxXQUFXO0FBQUEsSUFDcEUsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBO0FBQUE7QUFHWCxJQUFNLGlCQUFpQixrQkFBa0I7QUEwQnpDLElBQU0sV0FBb0M7QUFBQSxFQUN4QyxPQUFPO0FBQUEsRUFDUCxVQUFVO0FBQUEsRUFDVixXQUFXO0FBQUEsRUFDWCxVQUFVO0FBQ1o7QUFHQSxJQUFJLGtCQUFpQztBQUVyQyxTQUFTLGFBQWEsQ0FDcEIsTUFDQSxTQUNBLE9BQ1E7QUFBQSxFQUNSLE9BQU8sR0FBRyxLQUFLLFVBQVU7QUFBQSxJQUN2QixJQUFJO0FBQUEsSUFDSixPQUFPO0FBQUEsTUFDTDtBQUFBLE1BQ0EsV0FBVyxTQUFTO0FBQUEsTUFFcEIsV0FBVztBQUFBLE1BQ1g7QUFBQSxTQUNJLE9BQU8sT0FBTyxFQUFFLE1BQU0sTUFBTSxLQUFLLElBQUksQ0FBQztBQUFBLFNBQ3RDLE9BQU8sVUFBVSxFQUFFLFNBQVMsTUFBTSxRQUFRLElBQUksQ0FBQztBQUFBLElBQ3JEO0FBQUEsSUFDQSxNQUFNLEVBQUUsU0FBUyxnQkFBZ0I7QUFBQSxFQUNuQyxDQUFDO0FBQUE7QUFBQTtBQUdILFNBQVMsR0FBRyxDQUNWLEtBQ0EsT0FBZ0IsU0FDaEIsT0FDTztBQUFBLEVBQ1AsUUFBUSxPQUFPLE1BQU0sY0FBYyxNQUFNLEtBQUssS0FBSyxDQUFDO0FBQUEsRUFDcEQsUUFBUSxLQUFLLFNBQVMsS0FBSztBQUFBO0FBRzdCLFNBQVMsS0FBSyxDQUFDLElBQTJCO0FBQUEsRUFDeEMsT0FBTyxJQUFJLFFBQVEsQ0FBQyxNQUFNLFdBQVcsR0FBRyxFQUFFLENBQUM7QUFBQTtBQUc3QyxTQUFTLGVBQWUsQ0FBQyxTQUEwQjtBQUFBLEVBQ2pELE9BQU8sVUFBVSxNQUFLLE9BQU8sR0FBRyxVQUFVLGNBQWMsSUFBSSxNQUFLLE9BQU8sR0FBRyxvQkFBb0I7QUFBQTtBQUdqRyxTQUFTLFdBQVcsQ0FBQyxTQUFrQztBQUFBLEVBQ3JELElBQUk7QUFBQSxJQUNGLE9BQU8sS0FBSyxNQUFNLGFBQWEsZ0JBQWdCLE9BQU8sR0FBRyxNQUFNLENBQUM7QUFBQSxJQUNoRSxNQUFNO0FBQUEsSUFDTixPQUFPO0FBQUE7QUFBQTtBQUlYLFNBQVMsY0FBYyxDQUFDLFNBQTJCO0FBQUEsRUFDakQsTUFBTSxJQUFJLFlBQVksT0FBTztBQUFBLEVBQzdCLElBQUksQ0FBQztBQUFBLElBQUcsSUFBSSxxREFBK0MsV0FBVztBQUFBLEVBQ3RFLE9BQU87QUFBQTtBQUdULGVBQWUsR0FBRyxDQUNoQixNQUNBLFFBQ0EsTUFDQSxNQUM0QztBQUFBLEVBQzVDLE1BQU0sTUFBTSxNQUFNLE1BQU0sb0JBQW9CLE9BQU8sUUFBUTtBQUFBLElBQ3pEO0FBQUEsSUFDQSxTQUFTLFNBQVMsWUFBWSxFQUFFLGdCQUFnQixtQkFBbUIsSUFBSTtBQUFBLElBQ3ZFLE1BQU0sU0FBUyxZQUFZLEtBQUssVUFBVSxJQUFJLElBQUk7QUFBQSxFQUNwRCxDQUFDO0FBQUEsRUFDRCxJQUFJLE9BQWdCO0FBQUEsRUFDcEIsSUFBSTtBQUFBLElBQ0YsT0FBTyxNQUFNLElBQUksS0FBSztBQUFBLElBQ3RCLE1BQU07QUFBQSxFQUNSLE9BQU8sRUFBRSxRQUFRLElBQUksUUFBUSxLQUFLO0FBQUE7QUFlcEMsSUFBTSxjQUFjO0FBQUEsRUFDbEIsT0FBTyxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQ3hCLE1BQU0sRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN2QixLQUFLLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDdEIsUUFBUSxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQ3pCLE9BQU8sRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN4QixPQUFPLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDeEIsTUFBTSxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQ3ZCLFNBQVMsRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUMxQixLQUFLLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDdEIsU0FBUyxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQzFCLFNBQVMsRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUMxQixPQUFPLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDeEIsU0FBUyxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQzFCLE9BQU8sRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN4QixNQUFNLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDdkIsTUFBTSxFQUFFLE1BQU0sVUFBVTtBQUFBLEVBQ3hCLFdBQVcsRUFBRSxNQUFNLFVBQVU7QUFBQSxFQUM3QixRQUFRLEVBQUUsTUFBTSxVQUFVO0FBQUEsRUFDMUIsT0FBTyxFQUFFLE1BQU0sVUFBVTtBQUMzQjtBQWdCTyxJQUFNLFlBQVk7QUFBQSxFQUN2QixNQUFNLENBQUMsU0FBUyxVQUFVLFdBQVcsV0FBVyxTQUFTO0FBQUEsRUFDekQsVUFBVSxDQUFDO0FBQUEsRUFDWCxNQUFNLENBQUMsV0FBVyxPQUFPO0FBQUEsRUFDekIsT0FBTyxDQUFDLFdBQVcsTUFBTTtBQUFBLEVBQ3pCLEtBQUssQ0FBQyxXQUFXLE9BQU87QUFBQSxFQUN4QixLQUFLLENBQUMsV0FBVyxTQUFTO0FBQUEsRUFDMUIsUUFBUSxDQUFDLFNBQVM7QUFBQSxFQUNsQixRQUFRLENBQUMsU0FBUztBQUFBLEVBQ2xCLFVBQVUsQ0FBQyxTQUFTO0FBQUEsRUFDcEIsU0FBUyxDQUFDLFdBQVcsT0FBTyxVQUFVLFNBQVMsT0FBTyxTQUFTLE9BQU87QUFBQSxFQUN0RSxRQUFRLENBQUMsV0FBVyxLQUFLO0FBQUEsRUFDekIsZUFBZSxDQUFDLFdBQVcsUUFBUSxRQUFRLE1BQU07QUFBQSxFQUNqRCxrQkFBa0IsQ0FBQyxTQUFTO0FBQUEsRUFDNUIsS0FBSyxDQUFDLFdBQVcsT0FBTztBQUFBLEVBQ3hCLE9BQU8sQ0FBQyxTQUFTO0FBQUEsRUFDakIsTUFBTSxDQUFDLFNBQVM7QUFBQSxFQUNoQixNQUFNLENBQUM7QUFDVDtBQUlBLElBQU0sUUFBUSxPQUFPLEtBQUssU0FBUztBQUVuQyxJQUFNLFNBQVMsQ0FBQyxNQUF5QixPQUFPLE9BQU8sV0FBVyxDQUFDO0FBR25FLElBQU0sV0FBVyxDQUFDLFNBQXlCLFVBQVUsTUFBTSxJQUFJLENBQUMsTUFBTSxLQUFLLEdBQUcsRUFBRSxLQUFLO0FBQUE7QUFFckYsTUFBTSxtQkFBbUIsTUFBTTtBQUFDO0FBRXpCLFNBQVMsU0FBUyxDQUN2QixNQUNBLE1BSUE7QUFBQSxFQWtCQSxJQUFJO0FBQUEsRUFDSixJQUFJO0FBQUEsSUFDRixTQUFTLGNBQWM7QUFBQSxNQUNyQjtBQUFBLE1BQ0EsU0FBUztBQUFBLE1BQ1QsUUFBUTtBQUFBLE1BQ1Isa0JBQWtCO0FBQUEsSUFDcEIsQ0FBQztBQUFBLElBQ0QsT0FBTyxHQUFHO0FBQUEsSUFDVixNQUFNLElBQUksV0FBVyxhQUFhLFFBQVEsRUFBRSxVQUFVLE9BQU8sQ0FBQyxDQUFDO0FBQUE7QUFBQSxFQUdqRSxJQUFJLE1BQU07QUFBQSxJQUNSLE1BQU0sVUFBVSxJQUFJLElBQVksVUFBVSxLQUFLO0FBQUEsSUFDL0MsTUFBTSxRQUFRLE9BQU8sS0FBSyxPQUFPLE1BQU0sRUFBRSxLQUFLLENBQUMsTUFBTSxDQUFDLFFBQVEsSUFBSSxDQUFDLENBQUM7QUFBQSxJQUNwRSxJQUFJLE9BQU87QUFBQSxNQUNULE1BQU0sSUFBSSxXQUNSLEtBQUssOEJBQThCLCtEQUNyQztBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQUEsRUFFQSxPQUFPO0FBQUEsSUFDTCxLQUFLLE9BQU87QUFBQSxJQUNaLE9BQU8sT0FBTztBQUFBLEVBQ2hCO0FBQUE7QUFLRixlQUFlLFNBQVMsR0FBb0I7QUFBQSxFQUMxQyxRQUFRLE1BQU0sSUFBSSxNQUFNLEtBQUssR0FBRyxLQUFLO0FBQUE7QUFHdkMsZUFBZSxPQUFPLENBQUMsU0FBNkIsS0FBOEI7QUFBQSxFQUNoRixNQUFNLElBQUksZUFBZSxPQUFPO0FBQUEsRUFDaEMsUUFBUSxXQUFXLE1BQU0sSUFBSSxFQUFFLE1BQU0sUUFBUSxRQUFRLEdBQUc7QUFBQSxFQUN4RCxJQUFJLFdBQVc7QUFBQSxJQUFLLElBQUksb0JBQW9CLDhDQUF3QyxVQUFVO0FBQUEsRUFDOUYsVUFBVSxFQUFFLElBQUksTUFBTSxNQUFNLElBQUksS0FBSyxDQUFDO0FBQUE7QUFLeEMsZUFBZSxPQUFPLENBQUMsT0FBeUM7QUFBQSxFQUM5RCxNQUFNLE9BQU8sQ0FBQyxPQUFPLGFBQWE7QUFBQSxFQUNsQyxJQUFJLE1BQU07QUFBQSxJQUFPLEtBQUssS0FBSyxXQUFXLE9BQU8sTUFBTSxLQUFLLENBQUM7QUFBQSxFQUN6RCxJQUFJLE1BQU07QUFBQSxJQUFRLEtBQUssS0FBSyxZQUFZLE9BQU8sTUFBTSxNQUFNLENBQUM7QUFBQSxFQUM1RCxJQUFJLE1BQU07QUFBQSxJQUFTLEtBQUssS0FBSyxhQUFhLE9BQU8sTUFBTSxPQUFPLENBQUM7QUFBQSxFQUMvRCxJQUFJLE1BQU07QUFBQSxJQUFTLEtBQUssS0FBSyxhQUFhLE9BQU8sTUFBTSxPQUFPLENBQUM7QUFBQSxFQUMvRCxJQUFJLE1BQU07QUFBQSxJQUFZLEtBQUssS0FBSyxXQUFXO0FBQUEsRUFFM0MsTUFBTSxTQUFTLFlBQVksR0FBRztBQUFBLEVBSTlCLE1BQU0sT0FBTyxNQUFNLFFBQVEsVUFBVSxNQUFNO0FBQUEsSUFDekMsVUFBVTtBQUFBLElBQ1YsT0FBTyxDQUFDLFVBQVUsVUFBVSxRQUFRO0FBQUEsSUFDcEMsS0FBSyxRQUFRO0FBQUEsSUFDYixLQUFLLE1BQUssWUFBWSxJQUFJO0FBQUEsRUFDNUIsQ0FBQztBQUFBLEVBQ0QsS0FBSyxNQUFNO0FBQUEsRUFFWCxNQUFNLFdBQVcsS0FBSyxJQUFJLElBQUk7QUFBQSxFQUM5QixPQUFPLEtBQUssSUFBSSxJQUFJLFVBQVU7QUFBQSxJQUM1QixNQUFNLE1BQU0sRUFBRTtBQUFBLElBQ2QsTUFBTSxJQUFJLFlBQVk7QUFBQSxJQUN0QixJQUFJLEtBQUssRUFBRSxlQUFlLFFBQVE7QUFBQSxNQUNoQyxJQUFJO0FBQUEsUUFDRixNQUFNLElBQUksTUFBTSxNQUFNLG9CQUFvQixFQUFFLFlBQVk7QUFBQSxRQUN4RCxJQUFJLEVBQUUsSUFBSTtBQUFBLFVBQ1IsVUFBVSxDQUFDO0FBQUEsVUFDWDtBQUFBLFFBQ0Y7QUFBQSxRQUNBLE1BQU07QUFBQSxJQUdWO0FBQUEsRUFDRjtBQUFBLEVBQ0EsSUFBSSwyQ0FBMkMsVUFBVTtBQUFBO0FBRzNELGVBQWUsUUFBUSxDQUFDLFNBQWtCLE9BQU8sT0FBTztBQUFBLEVBQ3RELE1BQU0sSUFBSSxlQUFlLE9BQU87QUFBQSxFQUNoQyxRQUFRLFFBQVEsU0FBUyxNQUFNLElBQUksRUFBRSxNQUFNLE9BQU8sU0FBUyxPQUFPLEtBQUssV0FBVztBQUFBLEVBQ2xGLElBQUksV0FBVztBQUFBLElBQUssSUFBSSxzQkFBc0IsV0FBVyxVQUFVO0FBQUEsRUFDbkUsVUFBVSxJQUFJO0FBQUE7QUFHaEIsZUFBZSxPQUFPLENBQUMsU0FBNkIsVUFBa0I7QUFBQSxFQUNwRSxJQUFJLFFBQVE7QUFBQSxFQUNaLElBQUksUUFBUTtBQUFBLEVBQ1osSUFBSSxVQUFVO0FBQUEsRUFDZCxJQUFJLFVBQVU7QUFBQSxFQUNkLElBQUksV0FBVztBQUFBLEVBQ2YsTUFBTSxPQUFPLE1BQU07QUFBQSxJQUNqQixVQUFVO0FBQUEsSUFDVixRQUFRLEtBQUssQ0FBQztBQUFBO0FBQUEsRUFFaEIsUUFBUSxHQUFHLFVBQVUsSUFBSTtBQUFBLEVBQ3pCLFFBQVEsR0FBRyxXQUFXLElBQUk7QUFBQSxFQUUxQixPQUFPLENBQUMsU0FBUztBQUFBLElBQ2YsTUFBTSxJQUFJLFlBQVksT0FBTztBQUFBLElBQzdCLElBQUksQ0FBQyxHQUFHO0FBQUEsTUFDTixJQUFJO0FBQUEsUUFBVSxRQUFRLEtBQUssQ0FBQztBQUFBLE1BQzVCLFFBQVEsT0FBTyxNQUFNO0FBQUEsQ0FBOEI7QUFBQSxNQUNuRCxNQUFNLE1BQU0sS0FBSztBQUFBLE1BQ2pCLFFBQVEsS0FBSyxJQUFJLFFBQVEsR0FBRyxJQUFJO0FBQUEsTUFDaEM7QUFBQSxJQUNGO0FBQUEsSUFDQSxJQUFJLENBQUM7QUFBQSxNQUFTLFVBQVUsRUFBRTtBQUFBLElBQzFCLElBQUksQ0FBQyxVQUFVO0FBQUEsTUFDYixXQUFXO0FBQUEsTUFFWCxRQUFRLE9BQU8sTUFDYixHQUFHLEtBQUssVUFBVSxFQUFFLE1BQU0sYUFBYSxZQUFZLEVBQUUsWUFBWSxNQUFNLEVBQUUsS0FBSyxDQUFDO0FBQUEsQ0FDakY7QUFBQSxJQUNGO0FBQUEsSUFDQSxJQUFJO0FBQUEsSUFDSixJQUFJO0FBQUEsTUFDRixNQUFNLE1BQU0sTUFBTSxvQkFBb0IsRUFBRSxxQkFBcUIsT0FBTztBQUFBLE1BQ3BFLE1BQU07QUFBQSxNQUNOLE1BQU0sTUFBTSxLQUFLO0FBQUEsTUFDakIsUUFBUSxLQUFLLElBQUksUUFBUSxHQUFHLElBQUk7QUFBQSxNQUNoQztBQUFBO0FBQUEsSUFFRixJQUFJLENBQUMsSUFBSSxNQUFNLENBQUMsSUFBSSxNQUFNO0FBQUEsTUFDeEIsTUFBTSxNQUFNLEtBQUs7QUFBQSxNQUNqQixRQUFRLEtBQUssSUFBSSxRQUFRLEdBQUcsSUFBSTtBQUFBLE1BQ2hDO0FBQUEsSUFDRjtBQUFBLElBQ0EsUUFBUTtBQUFBLElBQ1IsTUFBTSxTQUFTLElBQUksS0FBSyxVQUFVO0FBQUEsSUFDbEMsTUFBTSxNQUFNLElBQUk7QUFBQSxJQUNoQixJQUFJLE1BQU07QUFBQSxJQUNWLE9BQU8sTUFBTTtBQUFBLE1BQ1gsSUFBSTtBQUFBLE1BQ0osSUFBSTtBQUFBLFFBQ0YsUUFBUSxNQUFNLE9BQU8sS0FBSztBQUFBLFFBQzFCLE1BQU07QUFBQSxRQUNOO0FBQUE7QUFBQSxNQUVGLElBQUksTUFBTTtBQUFBLFFBQU07QUFBQSxNQUNoQixPQUFPLElBQUksT0FBTyxNQUFNLE9BQU8sRUFBRSxRQUFRLEtBQUssQ0FBQztBQUFBLE1BQy9DLFNBQVMsTUFBTSxJQUFJLFFBQVE7QUFBQTtBQUFBLENBQU0sRUFBRyxPQUFPLEdBQUcsTUFBTSxJQUFJLFFBQVE7QUFBQTtBQUFBLENBQU0sR0FBRztBQUFBLFFBQ3ZFLE1BQU0sUUFBUSxJQUFJLE1BQU0sR0FBRyxHQUFHO0FBQUEsUUFDOUIsTUFBTSxJQUFJLE1BQU0sTUFBTSxDQUFDO0FBQUEsUUFDdkIsTUFBTSxZQUFzQixDQUFDO0FBQUEsUUFDN0IsV0FBVyxRQUFRLE1BQU0sTUFBTTtBQUFBLENBQUksR0FBRztBQUFBLFVBQ3BDLElBQUksS0FBSyxXQUFXLEdBQUcsR0FBRztBQUFBLFlBQ3hCLFFBQVEsT0FBTyxNQUFNO0FBQUEsQ0FBc0I7QUFBQSxZQUMzQztBQUFBLFVBQ0Y7QUFBQSxVQUNBLElBQUksS0FBSyxXQUFXLE9BQU87QUFBQSxZQUFHLFVBQVUsS0FBSyxLQUFLLE1BQU0sQ0FBQyxFQUFFLEtBQUssQ0FBQztBQUFBLFFBQ25FO0FBQUEsUUFDQSxJQUFJLENBQUMsVUFBVTtBQUFBLFVBQVE7QUFBQSxRQUN2QixNQUFNLFVBQVUsVUFBVSxLQUFLO0FBQUEsQ0FBSTtBQUFBLFFBQ25DLElBQUk7QUFBQSxVQUNGLE1BQU0sS0FBSyxLQUFLLE1BQU0sT0FBTztBQUFBLFVBQzdCLElBQUksT0FBTyxHQUFHLE9BQU8sWUFBWSxHQUFHLEtBQUs7QUFBQSxZQUFPLFFBQVEsR0FBRztBQUFBLFVBQzNELElBQUksR0FBRyxTQUFTLFVBQVU7QUFBQSxZQWN4QixRQUFRLE9BQU8sTUFBTSxHQUFHO0FBQUEsR0FBYSxNQUFNLFFBQVEsS0FBSyxDQUFDLENBQUM7QUFBQSxZQUMxRCxVQUFVO0FBQUEsWUFDVjtBQUFBLFVBQ0Y7QUFBQSxVQUNBLFFBQVEsT0FBTyxNQUFNLEdBQUc7QUFBQSxDQUFXO0FBQUEsVUFDbkMsTUFBTTtBQUFBLE1BR1Y7QUFBQSxJQUNGO0FBQUEsSUFDQSxNQUFNLE1BQU0sS0FBSztBQUFBLEVBQ25CO0FBQUE7QUFHRixTQUFTLE9BQU8sQ0FBQyxTQUFrQjtBQUFBLEVBQ2pDLE1BQU0sSUFBSSxZQUFZLE9BQU87QUFBQSxFQUM3QixJQUFJLENBQUM7QUFBQSxJQUFHLElBQUksNkJBQTZCLFdBQVc7QUFBQSxFQUNwRCxVQUFVLENBQUM7QUFBQTtBQUdiLFNBQVMsV0FBVyxHQUFHO0FBQUEsRUFHckIsTUFBTSxPQUFPLFFBQVEsSUFBSSxlQUFlLE1BQUssUUFBUSxJQUFJLFFBQVEsSUFBSSxTQUFTO0FBQUEsRUFDOUUsTUFBTSxNQUFNLE1BQUssTUFBTSxXQUFXO0FBQUEsRUFDbEMsSUFBSTtBQUFBLEVBQ0osSUFBSTtBQUFBLElBQ0YsUUFBUSxZQUFZLEdBQUcsRUFBRSxPQUFPLENBQUMsTUFBTSxFQUFFLFNBQVMsT0FBTyxDQUFDO0FBQUEsSUFDMUQsTUFBTTtBQUFBLElBQ04sVUFBVSxFQUFFLFVBQVUsQ0FBQyxFQUFFLENBQUM7QUFBQSxJQUMxQjtBQUFBO0FBQUEsRUFHRixNQUFNLE9BQWMsQ0FBQztBQUFBLEVBQ3JCLFdBQVcsS0FBSyxPQUFPO0FBQUEsSUFDckIsTUFBTSxPQUFPLE1BQUssS0FBSyxDQUFDO0FBQUEsSUFDeEIsSUFBSTtBQUFBLE1BQ0YsTUFBTSxLQUFLLEtBQUssTUFBTSxhQUFhLE1BQU0sTUFBTSxDQUFDO0FBQUEsTUFDaEQsS0FBSyxLQUFLO0FBQUEsUUFDUixJQUFJLEVBQUUsUUFBUSxXQUFXLEVBQUU7QUFBQSxRQUMzQixPQUFPLEdBQUc7QUFBQSxRQUNWLFVBQVUsTUFBTSxRQUFRLEdBQUcsUUFBUSxJQUFJLEdBQUcsU0FBUyxTQUFTO0FBQUEsUUFDNUQsT0FBTyxTQUFTLElBQUksRUFBRTtBQUFBLE1BQ3hCLENBQUM7QUFBQSxNQUNELE1BQU07QUFBQSxFQUdWO0FBQUEsRUFDQSxLQUFLLEtBQUssQ0FBQyxHQUFHLE1BQU0sRUFBRSxRQUFRLEVBQUUsS0FBSztBQUFBLEVBS3JDLFVBQVUsRUFBRSxVQUFVLEtBQUssQ0FBQztBQUFBO0FBSzlCLGVBQWUsU0FBUyxDQUFDLFNBQTZCLFdBQW1CO0FBQUEsRUFDdkUsTUFBTSxPQUFPLElBQUksS0FBSyxTQUFTO0FBQUEsRUFDL0IsSUFBSSxDQUFFLE1BQU0sS0FBSyxPQUFPO0FBQUEsSUFBSSxJQUFJLG9CQUFvQixhQUFhLFdBQVc7QUFBQSxFQUM1RSxNQUFNLFFBQVEsSUFBSSxXQUFXLE1BQU0sS0FBSyxZQUFZLENBQUM7QUFBQSxFQUNyRCxNQUFNLE1BQU0sSUFBSSxJQUFJLGFBQWEsUUFBUSxFQUFFLE9BQU8sS0FBSyxFQUFFLE9BQU8sS0FBSyxFQUFFLE1BQU0sR0FBRyxFQUFFO0FBQUEsRUFDbEYsTUFBTSxPQUFPLE1BQU0sSUFBSSxJQUFJLE1BQU0sS0FBSyxFQUFFLFNBQVM7QUFBQSxFQUNqRCxNQUFNLFFBQVEsU0FBUztBQUFBLElBQ3JCLE1BQU07QUFBQSxJQUNOLE1BQU07QUFBQSxJQUNOLE1BQU0sQ0FBQyxLQUFLLFNBQVMsR0FBRyxLQUFLLFVBQVUsQ0FBQztBQUFBLElBQ3hDO0FBQUEsRUFDRixDQUFDO0FBQUE7QUFLSCxlQUFlLGFBQWEsQ0FBQyxTQUE2QixPQUF5QztBQUFBLEVBQ2pHLE1BQU0sTUFBTSxPQUFPLE1BQU0sU0FBUyxXQUFXLE1BQU0sT0FBTztBQUFBLEVBQzFELE1BQU0sUUFBUSxJQUFJLE1BQU0sR0FBRyxFQUFFLElBQUksQ0FBQyxNQUFNLFNBQVMsRUFBRSxLQUFLLEdBQUcsRUFBRSxDQUFDO0FBQUEsRUFDOUQsSUFBSSxNQUFNLFdBQVcsS0FBSyxNQUFNLEtBQUssQ0FBQyxNQUFNLE9BQU8sTUFBTSxDQUFDLENBQUMsR0FBRztBQUFBLElBQzVELElBQUkseUVBQXlFO0FBQUEsRUFDL0U7QUFBQSxFQUNBLE1BQU0sVUFBbUMsRUFBRSxNQUFNLE1BQU07QUFBQSxFQUN2RCxJQUFJLE9BQU8sTUFBTSxTQUFTO0FBQUEsSUFBVSxRQUFRLE9BQU8sTUFBTTtBQUFBLEVBQ3pELElBQUksT0FBTyxNQUFNLFNBQVM7QUFBQSxJQUFVLFFBQVEsT0FBTyxNQUFNO0FBQUEsRUFDekQsTUFBTSxRQUFRLFNBQVMsRUFBRSxNQUFNLGVBQWUsUUFBUSxDQUFDO0FBQUE7QUFPekQsZUFBZSxXQUFXLENBQUMsU0FBa0I7QUFBQSxFQUMzQyxNQUFNLElBQUksZUFBZSxPQUFPO0FBQUEsRUFDaEMsUUFBUSxRQUFRLFNBQVMsTUFBTSxJQUFJLEVBQUUsTUFBTSxPQUFPLFFBQVE7QUFBQSxFQUMxRCxJQUFJLFdBQVc7QUFBQSxJQUFLLElBQUksc0JBQXNCLFdBQVcsVUFBVTtBQUFBLEVBQ25FLE1BQU0sTUFBTyxLQUFvRCxPQUFPO0FBQUEsRUFDeEUsTUFBTSxPQUFPLEtBQUs7QUFBQSxFQUNsQixJQUFJLENBQUM7QUFBQSxJQUFNLElBQUksNEVBQXNFLFVBQVU7QUFBQSxFQUMvRixJQUFJO0FBQUEsRUFDSixJQUFJO0FBQUEsSUFDRixXQUFXLE1BQU0sU0FBUyxJQUFJO0FBQUEsSUFDOUIsT0FBTyxHQUFHO0FBQUEsSUFDVixJQUFJLGFBQWE7QUFBQSxNQUFlLElBQUksb0JBQW9CLEVBQUUsV0FBVyxVQUFVO0FBQUEsSUFDL0UsTUFBTTtBQUFBO0FBQUEsRUFFUixNQUFNLFdBQXNCLFNBQVMsU0FBUyxJQUFJLENBQUMsT0FBTztBQUFBLElBQ3hELElBQUksTUFBTSxHQUFHO0FBQUEsSUFDYixNQUFNLEVBQUU7QUFBQSxJQUNSLE1BQU0sRUFBRTtBQUFBLElBQ1IsTUFBTSxFQUFFO0FBQUEsSUFDUixRQUFRO0FBQUEsRUFDVixFQUFFO0FBQUEsRUFDRixNQUFNLE9BQU8sU0FBUyxXQUFXLFlBQU0sU0FBUyxTQUFTLFFBQVEsQ0FBQyxNQUFNO0FBQUEsRUFDeEUsUUFBUSxPQUFPLE1BQU0sc0JBQXNCLFNBQVMsd0JBQXdCLE9BQU87QUFBQSxDQUFRO0FBQUEsRUFDM0YsTUFBTSxRQUFRLFNBQVMsRUFBRSxNQUFNLGdCQUFnQixTQUFTLENBQUM7QUFBQTtBQUszRCxTQUFTLFFBQVEsQ0FBQyxNQUFzQjtBQUFBLEVBQ3RDLE1BQU0sVUFBVSxNQUFNLEtBQUssUUFBUSxFQUFFLEVBQ2xDLElBQUksQ0FBQyxNQUFPLGtCQUFrQixLQUFLLENBQUMsSUFBSSxJQUFJLEdBQUksRUFDaEQsS0FBSyxFQUFFLEVBQ1AsUUFBUSxRQUFRLEVBQUU7QUFBQSxFQUNyQixPQUFPLFdBQVc7QUFBQTtBQU9iLFNBQVMsY0FBYyxDQUFDLE1BQWMsU0FBeUI7QUFBQSxFQUNwRSxPQUFPLEdBQUcsU0FBUyxJQUFJLElBQUksWUFBWSxTQUFTLEtBQUssSUFBSTtBQUFBO0FBVzNELGVBQWUsVUFBVSxDQUFDLFNBQTZCLE9BQXlDO0FBQUEsRUFDOUYsTUFBTSxJQUFJLGVBQWUsT0FBTztBQUFBLEVBQ2hDLElBQUksQ0FBQyxFQUFFO0FBQUEsSUFBVyxJQUFJLDhEQUF3RCxVQUFVO0FBQUEsRUFHeEYsSUFBSSxRQUFxQixNQUFNLFdBQVcsT0FBTyxTQUFTO0FBQUEsRUFDMUQsSUFBSSxPQUFPLE1BQU0sVUFBVSxVQUFVO0FBQUEsSUFDbkMsSUFBSSxDQUFDLENBQUMsUUFBUSxPQUFPLE1BQU0sRUFBRSxTQUFTLE1BQU0sS0FBSyxHQUFHO0FBQUEsTUFDbEQsSUFBSSxzQ0FBc0MsTUFBTSxRQUFRO0FBQUEsSUFDMUQ7QUFBQSxJQUNBLFFBQVEsTUFBTTtBQUFBLEVBQ2hCO0FBQUEsRUFLQSxNQUFNLFdBQVcsT0FBTyxNQUFNLFVBQVUsV0FBVyxNQUFNLFFBQVE7QUFBQSxFQUlqRSxNQUFNLGdCQUFnQixXQUFXLGtCQUFrQixRQUFRLElBQUk7QUFBQSxFQUMvRCxNQUFNLGFBQWEsWUFBWSxDQUFDLGdCQUFnQixXQUFXO0FBQUEsRUFJM0QsTUFBTSxnQkFBZ0IsT0FBTyxNQUFNLFVBQVUsV0FBVyxNQUFNLFFBQVE7QUFBQSxFQUN0RSxNQUFNLFFBQ0osVUFBVSxTQUNOLFNBQ0Msa0JBQ0EsZ0JBQWtCLFNBQW9CLE1BQU0sR0FBRyxFQUFFLE1BQU0sVUFBWSxZQUFZO0FBQUEsRUFJdEYsTUFBTSxNQUFNLE9BQU8sTUFBTSxRQUFRLFdBQVcsU0FBUyxNQUFNLEtBQUssRUFBRSxJQUFJO0FBQUEsRUFDdEUsSUFBSSxPQUFPLE1BQU0sR0FBRztBQUFBLElBQUcsSUFBSSx3QkFBd0I7QUFBQSxFQUNuRCxNQUFNLFdBQ0osT0FBTyxNQUFNLFFBQVEsV0FDakIsSUFBSSxJQUNGLE1BQU0sSUFDSCxNQUFNLEdBQUcsRUFDVCxJQUFJLENBQUMsTUFBTSxFQUFFLEtBQUssQ0FBQyxFQUNuQixPQUFPLE9BQU8sQ0FDbkIsSUFDQTtBQUFBLEVBRU4sUUFBUSxRQUFRLFNBQVMsTUFBTSxJQUFJLEVBQUUsTUFBTSxPQUFPLFFBQVE7QUFBQSxFQUMxRCxJQUFJLFdBQVc7QUFBQSxJQUFLLElBQUksc0JBQXNCLFdBQVcsVUFBVTtBQUFBLEVBQ25FLE1BQU0sS0FBTSxLQUEwRTtBQUFBLEVBQ3RGLE1BQU0sYUFBYSxJQUFJLFFBQVE7QUFBQSxFQUMvQixJQUFJLENBQUM7QUFBQSxJQUNILElBQUksNEVBQXNFLFVBQVU7QUFBQSxFQUN0RixJQUFJLFlBQVksSUFBSSxZQUFZLENBQUMsR0FBRyxPQUFPLENBQUMsTUFBTSxFQUFFLFdBQVcsU0FBUztBQUFBLEVBQ3hFLElBQUk7QUFBQSxJQUFVLFdBQVcsU0FBUyxPQUFPLENBQUMsTUFBTSxTQUFTLElBQUksRUFBRSxFQUFFLENBQUM7QUFBQSxFQUlsRSxJQUFJLFlBQVk7QUFBQSxFQUNoQixJQUFJLFVBQVUsUUFBUTtBQUFBLElBQ3BCLE1BQU0sU0FBUyxTQUFTO0FBQUEsSUFDeEIsV0FBVyxTQUFTLE9BQU8sQ0FBQyxNQUFNLGFBQWEsRUFBRSxNQUFNLEtBQUssQ0FBQztBQUFBLElBQzdELFlBQVksU0FBUyxTQUFTO0FBQUEsRUFDaEM7QUFBQSxFQUNBLElBQUksQ0FBQyxTQUFTLFFBQVE7QUFBQSxJQUNwQixJQUNFLFlBQVksSUFDUiw0QkFBc0IsNkJBQTZCLGNBQWMsSUFBSSxVQUFVLDBCQUEwQixjQUFjLElBQUksS0FBSyx3Q0FDaEksV0FDRSwrQ0FDQSwwREFDUjtBQUFBLEVBQ0Y7QUFBQSxFQUVBLE1BQU0sSUFBSSxFQUFFLE1BQU0sUUFBUSxRQUFRLEVBQUUsTUFBTSxVQUFVLE1BQU0sTUFBTSxNQUFNLG1CQUFhLENBQUM7QUFBQSxFQUNwRixJQUFJLE9BQU87QUFBQSxFQUNYLElBQUksU0FBUztBQUFBLEVBQ2IsSUFBSTtBQUFBLElBQ0YsV0FBVyxNQUFNLFVBQVU7QUFBQSxNQUN6QixNQUFNLFVBQVUsTUFBSyxFQUFFLFdBQVcsZUFBZSxHQUFHLE1BQU0sS0FBSyxDQUFDO0FBQUEsTUFDaEUsSUFBSTtBQUFBLFFBR0YsTUFBTSxTQUFTLGdCQUNYLE1BQU0sa0JBQWtCLElBQ3RCO0FBQUEsVUFDRSxZQUFZLE1BQUssRUFBRSxXQUFXLGVBQWUsR0FBRyxNQUFNLE1BQU0sQ0FBQztBQUFBLFVBQzdELE1BQU0sR0FBRztBQUFBLFVBQ1QsTUFBTSxHQUFHO0FBQUEsUUFDWCxHQUNBLFNBQ0EsRUFBRSxPQUFPLFNBQVMsQ0FDcEIsSUFDQSxNQUFNLGFBQWEsSUFBSSxFQUFFLFlBQVksTUFBTSxHQUFHLE1BQU0sTUFBTSxHQUFHLEtBQUssR0FBRyxTQUFTO0FBQUEsVUFDNUU7QUFBQSxVQUNBO0FBQUEsVUFDQSxPQUFPO0FBQUEsUUFDVCxDQUFDO0FBQUEsUUFDTCxNQUFNLElBQUksRUFBRSxNQUFNLFFBQVEsUUFBUTtBQUFBLFVBQ2hDLE1BQU07QUFBQSxVQUNOLElBQUksR0FBRztBQUFBLFVBR1AsU0FBUztBQUFBLFlBQ1AsSUFBSSxNQUFNLEdBQUc7QUFBQSxZQUNiLE9BQU87QUFBQSxZQUNQLE1BQU0sVUFBVSxTQUFTLFFBQVEsZ0JBQWdCLFVBQVU7QUFBQSxZQUMzRCxNQUFNLE9BQU87QUFBQSxZQUNiLEtBQUs7QUFBQSxVQUNQO0FBQUEsVUFDQSxRQUFRO0FBQUEsUUFDVixDQUFDO0FBQUEsUUFDRDtBQUFBLFFBQ0EsUUFBUSxPQUFPLE1BQU0sZUFBZSxHQUFHLFNBQVMsR0FBRyxTQUFTLGlCQUFXLE9BQU87QUFBQSxDQUFRO0FBQUEsUUFDdEYsT0FBTyxHQUFHO0FBQUEsUUFDVjtBQUFBLFFBQ0EsUUFBUSxPQUFPLE1BQ2IsMEJBQTBCLEdBQUcsU0FBUyxhQUFhLFFBQVEsRUFBRSxVQUFVLE9BQU8sQ0FBQztBQUFBLENBQ2pGO0FBQUE7QUFBQSxJQUVKO0FBQUEsWUFDQTtBQUFBLElBQ0EsTUFBTSxJQUFJLEVBQUUsTUFBTSxRQUFRLFFBQVEsRUFBRSxNQUFNLFVBQVUsTUFBTSxNQUFNLENBQUM7QUFBQTtBQUFBLEVBRW5FLFVBQVUsRUFBRSxJQUFJLE1BQU0sS0FBSyxNQUFNLFFBQVEsT0FBTyxTQUFTLFFBQVEsV0FBVyxPQUFPLE1BQU0sQ0FBQztBQUFBO0FBRzVGLFNBQVMsVUFBVSxDQUFDLEdBQW1CO0FBQUEsRUFDckMsT0FBTyxFQUFFLFFBQ1AsV0FDQSxDQUFDLE9BQU8sRUFBRSxLQUFLLFNBQVMsS0FBSyxRQUFRLEtBQUssUUFBUSxLQUFLLFNBQVMsR0FBRyxFQUNyRTtBQUFBO0FBaUJGLFNBQVMsZ0JBQWdCLENBQUMsT0FBZSxRQUFpQztBQUFBLEVBQ3hFLE1BQU0sUUFBUSxDQUFDLEdBQUcsSUFBSSxJQUFJLE9BQU8sSUFBSSxDQUFDLE1BQU0sRUFBRSxJQUFJLENBQUMsQ0FBQyxFQUFFLEtBQUs7QUFBQSxFQUMzRCxNQUFNLFlBQVksQ0FBQyxPQUFPLEdBQUcsS0FBSyxFQUMvQixJQUFJLENBQUMsTUFBTTtBQUFBLElBQ1YsTUFBTSxJQUFJLE1BQU0sUUFBUSxPQUFPLFNBQVMsT0FBTyxPQUFPLENBQUMsTUFBTSxFQUFFLFNBQVMsQ0FBQyxFQUFFO0FBQUEsSUFDM0UsT0FBTyxzQkFBc0IsTUFBTSxRQUFRLFlBQVksb0JBQW9CLFdBQVcsQ0FBQyxNQUFNLFdBQVcsQ0FBQyxxQkFBcUI7QUFBQSxHQUMvSCxFQUNBLEtBQUssRUFBRTtBQUFBLEVBQ1YsTUFBTSxRQUFRLE9BQ1gsSUFDQyxDQUFDLE1BQU0seUNBQXlDLFdBQVcsRUFBRSxJQUFJO0FBQUEsdUNBQ2hDLFdBQVcsRUFBRSxJQUFJLFdBQVcsV0FBVyxFQUFFLElBQUk7QUFBQTtBQUFBLCtCQUVyRCxXQUFXLEVBQUUsSUFBSTtBQUFBLCtCQUNqQixXQUFXLEVBQUUsSUFBSSxVQUFNLFdBQVcsRUFBRSxLQUFLLElBQUksRUFBRSxPQUFPLEtBQUssV0FBVyxFQUFFLElBQUksT0FBTztBQUFBO0FBQUEsZ0JBRzlHLEVBQ0MsS0FBSztBQUFBLENBQUk7QUFBQSxFQUNaLE9BQU87QUFBQTtBQUFBLFNBRUEsV0FBVyxLQUFLO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEscUJBcUNmLFdBQVcsS0FBSyxnQ0FBMkIsT0FBTyxlQUFlLE9BQU8sV0FBVyxJQUFJLEtBQUs7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSx3REFhOUM7QUFBQTtBQUFBO0FBQUEsRUFHdEQ7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQXVCRixlQUFlLFNBQVMsQ0FBQyxTQUE2QixPQUF5QztBQUFBLEVBQzdGLE1BQU0sSUFBSSxlQUFlLE9BQU87QUFBQSxFQUNoQyxJQUFJLENBQUMsRUFBRTtBQUFBLElBQVcsSUFBSSx5REFBbUQsVUFBVTtBQUFBLEVBQ25GLE1BQU0sV0FDSixPQUFPLE1BQU0sUUFBUSxXQUNqQixJQUFJLElBQ0YsTUFBTSxJQUNILE1BQU0sR0FBRyxFQUNULElBQUksQ0FBQyxNQUFNLEVBQUUsS0FBSyxDQUFDLEVBQ25CLE9BQU8sT0FBTyxDQUNuQixJQUNBO0FBQUEsRUFFTixRQUFRLFFBQVEsU0FBUyxNQUFNLElBQUksRUFBRSxNQUFNLE9BQU8sUUFBUTtBQUFBLEVBQzFELElBQUksV0FBVztBQUFBLElBQUssSUFBSSxzQkFBc0IsV0FBVyxVQUFVO0FBQUEsRUFDbkUsTUFBTSxLQUFNLEtBQThEO0FBQUEsRUFDMUUsSUFBSSxZQUFZLElBQUksWUFBWSxDQUFDLEdBQUcsT0FBTyxDQUFDLE1BQU0sRUFBRSxXQUFXLFNBQVM7QUFBQSxFQUN4RSxJQUFJO0FBQUEsSUFBVSxXQUFXLFNBQVMsT0FBTyxDQUFDLE1BQU0sU0FBUyxJQUFJLEVBQUUsRUFBRSxDQUFDO0FBQUEsRUFDbEUsSUFBSSxDQUFDLFNBQVM7QUFBQSxJQUNaLElBQUksV0FBVyxtQ0FBbUMsdUJBQXVCLFVBQVU7QUFBQSxFQUNyRixNQUFNLFFBQVEsSUFBSSxTQUFTO0FBQUEsRUFFM0IsTUFBTSxXQUFXLE1BQUssRUFBRSxXQUFXLGNBQWM7QUFBQSxFQUNqRCxNQUFNLFVBQVU7QUFBQSxFQUNoQixJQUFJLFNBQW1DO0FBQUEsRUFDdkMsSUFBSSxVQUF5QjtBQUFBLEVBRzdCLElBQUk7QUFBQSxJQUNGLE9BQU8sVUFBVSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBSWpELE1BQU0sWUFBWSxNQUFLLFVBQVUsUUFBUTtBQUFBLElBQ3pDLE1BQU0sV0FBVyxNQUFLLFVBQVUsT0FBTztBQUFBLElBQ3ZDLFVBQVUsV0FBVyxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQUEsSUFFeEMsTUFBTSxXQUE0QixDQUFDO0FBQUEsSUFDbkMsV0FBVyxNQUFNLFVBQVU7QUFBQSxNQUN6QixNQUFNLFNBQVMsY0FBYyxFQUFFO0FBQUEsTUFDL0IsSUFBSSxDQUFDO0FBQUEsUUFBUTtBQUFBLE1BQ2IsTUFBTSxhQUFhLE1BQUssRUFBRSxXQUFXLFNBQVMsT0FBTyxJQUFJLENBQUM7QUFBQSxNQUMxRCxJQUFJLENBQUMsV0FBVyxVQUFVLEdBQUc7QUFBQSxRQUMzQixRQUFRLE9BQU8sTUFBTSxtQ0FBbUMsR0FBRyxTQUFTLE9BQU87QUFBQSxDQUFVO0FBQUEsUUFDckY7QUFBQSxNQUNGO0FBQUEsTUFDQSxNQUFNLFdBQVcsR0FBRyxTQUFTLEdBQUcsSUFBSTtBQUFBLE1BQ3BDLGFBQWEsWUFBWSxNQUFLLFdBQVcsUUFBUSxDQUFDO0FBQUEsTUFHbEQsSUFBSSxXQUEwQjtBQUFBLE1BQzlCLElBQUksT0FBTyxVQUFVLFFBQVE7QUFBQSxRQUMzQixNQUFNLFdBQVcsTUFBSyxFQUFFLFdBQVcsZUFBZSxHQUFHLE1BQU0sTUFBTSxDQUFDO0FBQUEsUUFDbEUsSUFBSSxXQUFXLFFBQVEsR0FBRztBQUFBLFVBQ3hCLFVBQVUsVUFBVSxFQUFFLFdBQVcsS0FBSyxDQUFDO0FBQUEsVUFDdkMsYUFBYSxVQUFVLE1BQUssVUFBVSxRQUFRLENBQUM7QUFBQSxVQUMvQyxXQUFXLFNBQVM7QUFBQSxRQUN0QjtBQUFBLE1BQ0Y7QUFBQSxNQUNBLFNBQVMsS0FBSztBQUFBLFFBQ1osTUFBTSxHQUFHO0FBQUEsUUFDVCxNQUFNLEdBQUc7QUFBQSxRQUNULE9BQU8sT0FBTztBQUFBLFFBQ2QsTUFBTSxPQUFPLFFBQVE7QUFBQSxRQUNyQixNQUFNLEdBQUc7QUFBQSxRQUNULE1BQU0sVUFBVTtBQUFBLFFBQ2hCLE1BQU07QUFBQSxNQUNSLENBQUM7QUFBQSxJQUNIO0FBQUEsSUFDQSxJQUFJLENBQUMsU0FBUztBQUFBLE1BQVEsTUFBTSxJQUFJLE1BQU0sbURBQW1EO0FBQUEsSUFFekYsY0FDRSxNQUFLLFVBQVUsZUFBZSxHQUM5QixLQUFLLFVBQVUsRUFBRSxPQUFPLE9BQU8sU0FBUyxRQUFRLFFBQVEsU0FBUyxHQUFHLE1BQU0sQ0FBQyxDQUM3RTtBQUFBLElBQ0EsY0FBYyxNQUFLLFVBQVUsY0FBYyxHQUFHLGlCQUFpQixPQUFPLFFBQVEsQ0FBQztBQUFBLElBRy9FLE1BQU0sVUFBVSxNQUFLLEVBQUUsV0FBVyxPQUFPO0FBQUEsSUFDekMsT0FBTyxTQUFTLEVBQUUsT0FBTyxLQUFLLENBQUM7QUFBQSxJQUMvQixNQUFNLE9BQU8sSUFBSSxNQUFNLENBQUMsT0FBTyxNQUFNLE1BQU0sU0FBUyxHQUFHLEdBQUc7QUFBQSxNQUN4RCxLQUFLO0FBQUEsTUFDTCxRQUFRO0FBQUEsTUFDUixRQUFRO0FBQUEsSUFDVixDQUFDO0FBQUEsSUFDRCxPQUFPLE1BQU0sU0FBUyxNQUFNLFFBQVEsSUFBSSxDQUFDLElBQUksU0FBUyxLQUFLLE1BQU0sRUFBRSxLQUFLLEdBQUcsS0FBSyxNQUFNLENBQUM7QUFBQSxJQUN2RixJQUFJLFVBQVU7QUFBQSxNQUFHLE1BQU0sSUFBSSxNQUFNLG9CQUFvQixXQUFXLEtBQUssS0FBSyxHQUFHO0FBQUEsSUFFN0UsTUFBTSxJQUFJLEVBQUUsTUFBTSxRQUFRLFFBQVE7QUFBQSxNQUNoQyxNQUFNO0FBQUEsTUFDTixNQUFNO0FBQUEsTUFDTixPQUFPLFNBQVM7QUFBQSxJQUNsQixDQUFDO0FBQUEsSUFDRCxRQUFRLE9BQU8sTUFBTSxtQkFBbUIsU0FBUywwQkFBb0I7QUFBQSxDQUFXO0FBQUEsSUFDaEYsU0FBUyxFQUFFLE9BQU8sU0FBUyxPQUFPO0FBQUEsSUFDbEMsT0FBTyxHQUFHO0FBQUEsSUFDVixVQUFVLGFBQWEsUUFBUSxFQUFFLFVBQVUsT0FBTyxDQUFDO0FBQUEsWUFDbkQ7QUFBQSxJQUNBLE9BQU8sVUFBVSxFQUFFLFdBQVcsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLElBQ2pELE1BQU0sSUFBSSxFQUFFLE1BQU0sUUFBUSxRQUFRLEVBQUUsTUFBTSxVQUFVLE1BQU0sTUFBTSxDQUFDO0FBQUE7QUFBQSxFQUduRSxJQUFJLFdBQVcsQ0FBQztBQUFBLElBQVEsSUFBSSxrQkFBa0IsV0FBVyxhQUFhLFVBQVU7QUFBQSxFQUNoRixVQUFVLEVBQUUsSUFBSSxNQUFNLFFBQVEsU0FBUyxPQUFPLE9BQU8sTUFBTSxDQUFDO0FBQUE7QUFHOUQsSUFBTSxPQUFPO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBbUNiLGVBQWUsSUFBSSxDQUFDLE1BQWlDO0FBQUEsRUFDbkQsT0FBTyxTQUFTLFFBQVE7QUFBQSxFQUN4QixrQkFBa0IsUUFBUTtBQUFBLEVBSTFCLElBQUksU0FBUyxZQUFZLFNBQVMsTUFBTTtBQUFBLElBQ3RDLFFBQVEsT0FBTyxNQUFNLEdBQUc7QUFBQSxDQUFRO0FBQUEsSUFDaEMsT0FBTztBQUFBLEVBQ1Q7QUFBQSxFQUNBLElBQUksU0FBUyxlQUFlLFNBQVMsTUFBTTtBQUFBLElBQ3pDLFVBQVUsRUFBRSxNQUFNLFVBQVUsU0FBUyxlQUFlLENBQUM7QUFBQSxJQUNyRCxPQUFPO0FBQUEsRUFDVDtBQUFBLEVBQ0EsSUFBSSxTQUFTLFdBQVc7QUFBQSxJQUl0QixRQUFRLE9BQU8sTUFDYixjQUFjLFNBQVMsaUJBQWlCLEVBQUUsTUFBTSxvQkFBb0IsU0FBUyxNQUFNLENBQUMsQ0FDdEY7QUFBQSxJQUNBLE9BQU87QUFBQSxFQUNUO0FBQUEsRUFJQSxJQUFJLENBQUMsT0FBTyxJQUFJLEdBQUc7QUFBQSxJQUNqQixRQUFRLE9BQU8sTUFDYixjQUFjLFNBQVMsaUJBQWlCLFNBQVM7QUFBQSxNQUMvQyxNQUFNO0FBQUEsTUFDTixTQUFTO0FBQUEsSUFDWCxDQUFDLENBQ0g7QUFBQSxJQUNBLE9BQU87QUFBQSxFQUNUO0FBQUEsRUFFQSxJQUFJO0FBQUEsRUFDSixJQUFJO0FBQUEsRUFDSixJQUFJO0FBQUEsS0FDRCxFQUFFLEtBQUssTUFBTSxJQUFJLFVBQVUsTUFBTSxJQUFJO0FBQUEsSUFDdEMsT0FBTyxHQUFHO0FBQUEsSUFDVixJQUFJLEVBQUUsYUFBYTtBQUFBLE1BQWEsTUFBTTtBQUFBLElBQ3RDLFFBQVEsT0FBTyxNQUNiLGNBQWMsU0FBUyxFQUFFLFNBQVM7QUFBQSxNQUNoQyxNQUFNLDREQUFzRDtBQUFBLE1BQzVELFNBQVMsU0FBUyxJQUFJO0FBQUEsSUFDeEIsQ0FBQyxDQUNIO0FBQUEsSUFDQSxPQUFPO0FBQUE7QUFBQSxFQUVULE1BQU0sVUFBVSxPQUFPLE1BQU0sWUFBWSxXQUFXLE1BQU0sVUFBVTtBQUFBLEVBRXBFLFFBQVE7QUFBQSxTQUNEO0FBQUEsTUFDSCxNQUFNLFFBQVEsS0FBSztBQUFBLE1BQ25CO0FBQUEsU0FDRztBQUFBLE1BQ0gsTUFBTSxRQUFRLFNBQVMsT0FBTyxNQUFNLFVBQVUsV0FBVyxTQUFTLE1BQU0sT0FBTyxFQUFFLElBQUksRUFBRTtBQUFBLE1BQ3ZGO0FBQUEsU0FDRztBQUFBLE1BQ0gsTUFBTSxTQUFTLFNBQVMsTUFBTSxTQUFTLElBQUk7QUFBQSxNQUMzQztBQUFBLFNBQ0csT0FBTztBQUFBLE1BQ1YsTUFBTSxPQUFPLE1BQU0sVUFBVSxPQUFPLE1BQU0sVUFBVSxJQUFJLElBQUksS0FBSyxHQUFHO0FBQUEsTUFDcEUsSUFBSSxDQUFDO0FBQUEsUUFBTSxJQUFJLG9DQUFvQztBQUFBLE1BQ25ELE1BQU0sUUFBUSxTQUFTLEVBQUUsTUFBTSxPQUFPLEtBQUssQ0FBQztBQUFBLE1BQzVDO0FBQUEsSUFDRjtBQUFBLFNBQ0ssT0FBTztBQUFBLE1BQ1YsSUFBSSxDQUFDLElBQUk7QUFBQSxRQUFRLElBQUksMENBQTBDO0FBQUEsTUFDL0QsTUFBTSxNQUErQixFQUFFLE1BQU0sT0FBTyxNQUFNLElBQUksS0FBSyxHQUFHLEVBQUU7QUFBQSxNQUN4RSxJQUFJLE9BQU8sTUFBTSxZQUFZLFVBQVU7QUFBQSxRQUNyQyxJQUFJLFVBQVUsTUFBTSxRQUNqQixNQUFNLEdBQUcsRUFDVCxJQUFJLENBQUMsTUFBTSxFQUFFLEtBQUssQ0FBQyxFQUNuQixPQUFPLE9BQU87QUFBQSxNQUNuQjtBQUFBLE1BQ0EsTUFBTSxRQUFRLFNBQVMsR0FBRztBQUFBLE1BQzFCO0FBQUEsSUFDRjtBQUFBLFNBQ0s7QUFBQSxNQUNILE1BQU0sUUFBUSxTQUFTO0FBQUEsUUFDckIsTUFBTTtBQUFBLFFBQ04sTUFBTSxJQUFJLE9BQU87QUFBQSxRQUNqQixNQUFNLElBQUksTUFBTSxDQUFDLEVBQUUsS0FBSyxHQUFHO0FBQUEsTUFDN0IsQ0FBQztBQUFBLE1BQ0Q7QUFBQSxTQUNHO0FBQUEsTUFDSCxJQUFJLENBQUMsSUFBSTtBQUFBLFFBQVEsSUFBSSwyQkFBMkI7QUFBQSxNQUNoRCxNQUFNLFVBQVUsU0FBUyxJQUFJLEVBQUU7QUFBQSxNQUMvQjtBQUFBLFNBQ0c7QUFBQSxNQUNILE1BQU0sWUFBWSxPQUFPO0FBQUEsTUFDekI7QUFBQSxTQUNHO0FBQUEsTUFDSCxNQUFNLFdBQVcsU0FBUyxLQUFLO0FBQUEsTUFDL0I7QUFBQSxTQUNHO0FBQUEsTUFDSCxNQUFNLFVBQVUsU0FBUyxLQUFLO0FBQUEsTUFDOUI7QUFBQSxTQUNHO0FBQUEsTUFDSCxNQUFNLGNBQWMsU0FBUyxLQUFLO0FBQUEsTUFDbEM7QUFBQSxTQUNHO0FBQUEsTUFDSCxJQUFJLENBQUMsSUFBSTtBQUFBLFFBQVEsSUFBSSw0QkFBNEI7QUFBQSxNQUNqRCxNQUFNLFFBQVEsU0FBUyxFQUFFLE1BQU0sa0JBQWtCLElBQUksSUFBSSxHQUFHLENBQUM7QUFBQSxNQUM3RDtBQUFBLFNBQ0csT0FBTztBQUFBLE1BR1YsTUFBTSxNQUFNLE1BQU0sVUFBVSxPQUFPLE1BQU0sVUFBVSxJQUFJLElBQUksS0FBSyxHQUFHO0FBQUEsTUFDbkUsSUFBSSxDQUFDO0FBQUEsUUFBSyxJQUFJLHFEQUFxRDtBQUFBLE1BQ25FLElBQUk7QUFBQSxNQUNKLElBQUk7QUFBQSxRQUNGLE9BQU8sS0FBSyxNQUFNLEdBQUc7QUFBQSxRQUNyQixNQUFNO0FBQUEsUUFDTixJQUFJLDZCQUE2QjtBQUFBO0FBQUEsTUFFbkMsTUFBTSxRQUFRLFNBQVMsSUFBSTtBQUFBLE1BQzNCO0FBQUEsSUFDRjtBQUFBLFNBQ0s7QUFBQSxNQUNILE1BQU0sUUFBUSxTQUFTLEVBQUUsTUFBTSxRQUFRLENBQUM7QUFBQSxNQUN4QztBQUFBLFNBQ0c7QUFBQSxNQUNILFFBQVEsT0FBTztBQUFBLE1BQ2Y7QUFBQSxTQUNHO0FBQUEsTUFDSCxZQUFZO0FBQUEsTUFDWjtBQUFBLFNBQ0c7QUFBQSxNQUNILFFBQVEsT0FBTyxNQUFNLEdBQUc7QUFBQSxDQUFRO0FBQUEsTUFDaEM7QUFBQTtBQUFBLE1BT0EsSUFBSSx3QkFBd0IsU0FBUyxVQUFVO0FBQUE7QUFBQSxFQUduRCxPQUFPO0FBQUE7QUFHVCxJQUFJLGtCQUFrQjtBQUFBLEVBUXBCLFFBQVEsV0FBVyxNQUFNLEtBQUssUUFBUSxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQ3JEO0FBaUJBLGVBQXNCLEdBQUcsR0FBb0I7QUFBQSxFQUMzQyxPQUFPLE1BQU0sS0FBSyxRQUFRLEtBQUssTUFBTSxDQUFDLENBQUM7QUFBQTsiLAogICJkZWJ1Z0lkIjogIkJEQTg3QTZCMzM4MUZDN0E2NDc1NkUyMTY0NzU2RTIxIiwKICAibmFtZXMiOiBbXQp9
