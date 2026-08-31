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

//# debugId=E64ABA12250E466B64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL21hZ3BpZS9iYWNrZW5kL2NsaS50cyIsICIuLi9zY3JpcHRzL2JhY2tlbmQudHMiLCAiLi4vc2hhcmVkL2FscGhhLnRzIiwgIi4uL3NjcmlwdHMvZGlzY292ZXIudHMiLCAiLi4vc2hhcmVkL3R5cGVzLnRzIiwgIi4uL3NjcmlwdHMvcmVkdWNlLnRzIiwgIi4uL3NoYXJlZC92ZXJzaW9ucy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L2xpYi9wcmludEpzb24udHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAiIyEvdXNyL2Jpbi9lbnYgYnVuXG5cbi8vIG1hZ3BpZSBDTEkg4oCUIHRoaW4sIHN0YXRlbGVzcyB3cmFwcGVyIGFyb3VuZCB0aGUgcGVyLXNlc3Npb24gZGFlbW9uJ3MgSFRUUFxuLy8gc3VyZmFjZSAoc2VydmVyLnRzKS4gT25lIEhUVFAgcm91bmQtdHJpcCBwZXIgdmVyYi4gYHRhaWxgIHN0cmVhbXMgU1NFIHVzZXJcbi8vIGV2ZW50cyBhcyBKU09OTCBmb3IgTW9uaXRvciB0byB3cmFwIChhIGBncm91bmRpbmdgIGFuY2hvciBsaW5lIGZpcnN0KS5cbi8vXG4vLyBMaWZlY3ljbGU6XG4vLyAgIGJ1biBjbGkudHMgb3BlbiBbLS10aXRsZSAuLl0gWy0taW50ZW50IC4uXSBbLS1yZXN0b3JlIDxpZD5dIFstLXRpbWVvdXQgU10gWy0tbm8tb3Blbl1cbi8vICAgYnVuIGNsaS50cyB0YWlsIFstLXNpbmNlIE5dICAgICAgICAgICAgIyBTU0UgdXNlciBldmVudHMg4oaSIEpTT05MIChNb25pdG9yIHRoaXMpXG4vLyAgIGJ1biBjbGkudHMgc3RhdGUgWy0tZnVsbF0gICAgICAgICAgICAgICMgbGVhbiBzdGF0ZSBzbmFwc2hvdCAoYWRkIC0tZnVsbCBmb3IgcmF3KVxuLy9cbi8vIERyaXZpbmcgdGhlIHN1cmZhY2UgKFBPU1QgL2NtZCk6XG4vLyAgIGJ1biBjbGkudHMgc2F5IFt0ZXh0Li4uXSBbLS1zdGRpbl0gICAgICAgICAgICAgICAgICMgcG9zdCBhZ2VudCBkaWFsb2d1ZSAodGV4dCBvciBwaXBlZCBzdGRpbilcbi8vICAgYnVuIGNsaS50cyBhc2sgPHRleHQuLi4+IFstLW9wdGlvbnMgXCJhfGJ8Y1wiXSAgICAgICAjIGFzayB0aGUgdXNlciAoaW4tdGhyZWFkKVxuLy8gICBidW4gY2xpLnRzIHN0YXR1cyBvbiBbdGV4dC4uLl0gfCBzdGF0dXMgb2ZmICAgICAgICAjIHRoZSB3b3JraW5nIHNwaW5uZXJcbi8vICAgYnVuIGNsaS50cyBzb3VyY2UgPGltYWdlUGF0aD4gICAgICAgICAgICAgICAgICAgICAgIyBzZXQgdGhlIGNvbXBvc2l0ZSB1bmRlciByZXZpZXcgKGNvbXB1dGVzIHNoYSArIHNpemUpXG4vLyAgIGJ1biBjbGkudHMgY21kIFstLXN0ZGluXSAgICAgICAgICAgICAgICAgICAgICAgICAgICAjIFBPU1QgYSByYXcgQWdlbnRDb21tYW5kIEpTT04gYm9keSAoZnJvbSBzdGRpbilcbi8vICAgYnVuIGNsaS50cyBjbG9zZSB8IGluZm8gfCBzZXNzaW9ucyB8IGhlbHBcbi8vXG4vLyBgLS1zdGRpbmAgcmVhZHMgdGhlIGJvZHkgZnJvbSBzdGRpbiBzbyBuYXR1cmFsLWxhbmd1YWdlIHRleHQgaXMgbmV2ZXIgaW5saW5lZFxuLy8gaW50byBhIHNoZWxsLXBhcnNlZCBhcmcuIFBheWxvYWQgb24gc3Rkb3V0LCBsaXZlbmVzcy9lY2hvIG9uIHN0ZGVyci5cbi8vXG4vLyBBbGwgdmVyYnMgdGFyZ2V0IHRoZSBtb3N0IHJlY2VudCBzZXNzaW9uIGJ5IGRlZmF1bHQ7IHBhc3MgLS1zZXNzaW9uIDxpZD4uXG5cbmltcG9ydCB7IHNwYXduIH0gZnJvbSBcIm5vZGU6Y2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0IHtcbiAgY29weUZpbGVTeW5jLFxuICBleGlzdHNTeW5jLFxuICBta2RpclN5bmMsXG4gIHJlYWRkaXJTeW5jLFxuICByZWFkRmlsZVN5bmMsXG4gIHJtU3luYyxcbiAgc3RhdFN5bmMsXG4gIHdyaXRlRmlsZVN5bmMsXG59IGZyb20gXCJub2RlOmZzXCI7XG5pbXBvcnQgeyB0bXBkaXIgfSBmcm9tIFwibm9kZTpvc1wiO1xuaW1wb3J0IHsgYmFzZW5hbWUsIGRpcm5hbWUsIGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgeyBmaWxlVVJMVG9QYXRoIH0gZnJvbSBcIm5vZGU6dXJsXCI7XG5pbXBvcnQgeyBwYXJzZUFyZ3MgYXMgbm9kZVBhcnNlQXJncyB9IGZyb20gXCJub2RlOnV0aWxcIjtcbmltcG9ydCB7XG4gIHR5cGUgQWxwaGFQb2xpY3ksXG4gIGlzTWVkaWFGb3JnZU1vZGVsLFxuICBtZWRpYUZvcmdlQmFja2VuZCxcbiAgcmVtYmdCYWNrZW5kLFxuICBzaG91bGRSZW1vdmUsXG59IGZyb20gXCIuLi8uLi8uLi9wbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvbWFncGllL3NjcmlwdHMvYmFja2VuZFwiO1xuaW1wb3J0IHsgRGlzY292ZXJFcnJvciwgZGlzY292ZXIgfSBmcm9tIFwiLi4vLi4vLi4vcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL21hZ3BpZS9zY3JpcHRzL2Rpc2NvdmVyXCI7XG5pbXBvcnQgeyBuZXdJZCB9IGZyb20gXCIuLi8uLi8uLi9wbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvbWFncGllL3NjcmlwdHMvcmVkdWNlXCI7XG5pbXBvcnQgdHlwZSB7IEVsZW1lbnQgfSBmcm9tIFwiLi4vLi4vLi4vcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL21hZ3BpZS9zaGFyZWQvdHlwZXNcIjtcbmltcG9ydCB7IGNob3NlblZlcnNpb24gfSBmcm9tIFwiLi4vLi4vLi4vcGx1Z2lucy9zcGVsbGJvb2svc2tpbGxzL21hZ3BpZS9zaGFyZWQvdmVyc2lvbnNcIjtcbmltcG9ydCB7IHByaW50SnNvbiB9IGZyb20gXCIuLi8uLi9raXQvbGliL3ByaW50SnNvblwiO1xuXG4vLyBTd2FsbG93IEVQSVBFIChhIGRvd25zdHJlYW0gYGhlYWRgL01vbml0b3IgY2xvc2luZyBvdXIgc3Rkb3V0IHNob3VsZG4ndCBjcmFzaCkuXG5wcm9jZXNzLnN0ZG91dC5vbihcImVycm9yXCIsIChlOiBOb2RlSlMuRXJybm9FeGNlcHRpb24pID0+IHtcbiAgaWYgKGUuY29kZSA9PT0gXCJFUElQRVwiKSBwcm9jZXNzLmV4aXQoMCk7XG59KTtcblxuY29uc3QgU0NSSVBUX0RJUiA9IGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcbi8vIFNlZSB0aGUgYXN0cm9sYWJlIHR3aW46IGBkaXN0L2AgYW5kIGBzY3JpcHRzL2AgYXJlIHRoZSBzYW1lIGRlcHRoLCBzbyBvbmx5XG4vLyBhIFNJQkxJTkctcmVsYXRpdmUgcGF0aCBicmVha3Mgd2hlbiB0aGlzIGV4ZWN1dGVzIGFzIGAuLi9kaXN0L2NsaS5qc2AuXG5jb25zdCBTRVJWRVJfU0NSSVBUID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwic2NyaXB0c1wiLCBcInNlcnZlci50c1wiKTtcblxuLy8gT3VyIHBsdWdpbiB2ZXJzaW9uIChmcm9tIHBsdWdpbi5qc29uKSDigJQgdGhlIG9uZSBudW1iZXIgbWFncGllIGNhbiBob25lc3RseVxuLy8gcmVwb3J0IGFzIGl0cyBvd24uIEQxIGFza3MgYSBDTEkgdG8gYW5zd2VyIGAtLXZlcnNpb25gOyBhbiBhZ2VudCB0aGF0IGNhbm5vdFxuLy8gdGVsbCB3aGljaCBidWlsZCBpdCBpcyBkcml2aW5nIGNhbm5vdCB0ZWxsIGEgbWlzc2luZyBmZWF0dXJlIGZyb20gYSBzdGFsZVxuLy8gaW5zdGFsbC4gQmVzdC1lZmZvcnQ6IG51bGwgaWYgdGhlIHJlYWQgZmFpbHMsIGFuZCBgLS12ZXJzaW9uYCBzYXlzIHNvIHJhdGhlclxuLy8gdGhhbiBpbnZlbnRpbmcgb25lLiBTYW1lIHJlc29sdXRpb24gZ3JhcGV2aW5lIHVzZXMuXG5mdW5jdGlvbiByZWFkUGx1Z2luVmVyc2lvbigpOiBzdHJpbmcgfCBudWxsIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBwbHVnaW5Kc29uUGF0aCA9IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuY2xhdWRlLXBsdWdpblwiLCBcInBsdWdpbi5qc29uXCIpO1xuICAgIHJldHVybiBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwbHVnaW5Kc29uUGF0aCwgXCJ1dGYtOFwiKSkudmVyc2lvbiA/PyBudWxsO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuY29uc3QgUExVR0lOX1ZFUlNJT04gPSByZWFkUGx1Z2luVmVyc2lvbigpO1xuXG50eXBlIFNlc3Npb24gPSB7XG4gIHVybDogc3RyaW5nO1xuICBwb3J0OiBudW1iZXI7XG4gIHNlc3Npb25faWQ6IHN0cmluZztcbiAgdGl0bGU6IHN0cmluZztcbiAgZmlsZXNfZGlyPzogc3RyaW5nO1xufTtcblxuLy8g4pSA4pSAIGVycm9yIGVudmVsb3BlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy9cbi8vIG1hZ3BpZSBkZWNsYXJlcyBgZGVmYXVsdE91dHB1dDogXCJqc29uXCJgLCBhbmQgdGhhdCBkZWNsYXJhdGlvbiBpcyBhYm91dCBFVkVSWVxuLy8gc3RyZWFtLCBub3QganVzdCB0aGUgaGFwcHkgcGF0aC4gQSBjYWxsZXIgdGhhdCBnZXRzIG9uZSBKU09OIGRvY3VtZW50IGZyb20gYVxuLy8gdmVyYiBhbmQgcHJvc2UgZnJvbSBhIGZhaWx1cmUgaGFzIHRvIHBhcnNlIHR3byBmb3JtYXRzIHRvIHVzZSBvbmUgdG9vbCDigJQgYW5kXG4vLyB0aGUgZmFpbHVyZSBpcyB0aGUgY2FzZSB3aGVyZSBpdCBjYW4gbGVhc3QgYWZmb3JkIHRvIGd1ZXNzLiBTbyBhIGZhaWx1cmUgaXNcbi8vIE9ORSBKU09OIGRvY3VtZW50IG9uIHN0ZGVyciwgYW5kIHN0ZG91dCBzdGF5cyBlbXB0eSBiZWNhdXNlIHN0ZG91dCBjYXJyaWVzXG4vLyBkYXRhIGFuZCBhIGZhaWx1cmUgaGFzIG5vbmUuXG4vL1xuLy8gYGtpbmRgIGlzIHRoZSBjb250cmFjdDsgYG1lc3NhZ2VgIGlzIHByZXNlbnRhdGlvbi4gUmV3b3JkaW5nIGEgbWVzc2FnZSBtdXN0XG4vLyBuZXZlciBicmVhayBhIGNhbGxlciwgd2hpY2ggaXQgZG9lcyB0aGUgbW9tZW50IGFueW9uZSBtYXRjaGVzIG9uIHByb3NlLlxuLy8gRXhpdCBjb2RlcyBmb2xsb3cgdGhlIGFjYyB0YXhvbm9teTogdXNhZ2UgZXJyb3JzIGFyZSB0aGUgY2FsbGVyJ3MgdG8gZml4IGJ5XG4vLyBjaGFuZ2luZyB0aGUgY29tbWFuZCwgaW50ZXJuYWwgZmF1bHRzIGFyZSBub3QsIGFuZCBjb2xsYXBzaW5nIHRoZW0gaW50byBvbmVcbi8vIG51bWJlciBsZWF2ZXMgYW4gYWdlbnQgd2l0aCBub3RoaW5nIHRvIHJvdXRlIG9uLlxudHlwZSBFcnJLaW5kID0gXCJ1c2FnZVwiIHwgXCJpbnRlcm5hbFwiIHwgXCJub3RfZm91bmRcIiB8IFwiY29uZmxpY3RcIjtcblxuY29uc3QgRVhJVF9GT1I6IFJlY29yZDxFcnJLaW5kLCBudW1iZXI+ID0ge1xuICB1c2FnZTogMiwgLy8gdGhlIGNhbGxlciBjYW4gZml4IHRoaXMgYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmRcbiAgaW50ZXJuYWw6IDEsIC8vIG1hZ3BpZSBicm9rZTsgdGhlIGludm9jYXRpb24gbWF5IGhhdmUgYmVlbiBmaW5lXG4gIG5vdF9mb3VuZDogNSwgLy8gdGhlIG5hbWVkIHRoaW5nIGRvZXMgbm90IGV4aXN0XG4gIGNvbmZsaWN0OiA2LCAvLyBhIHByZWNvbmRpdGlvbiBmYWlsZWRcbn07XG5cbi8vIFRoZSB2ZXJiIHVuZGVyIGV4ZWN1dGlvbiwgc28gdGhlIGVudmVsb3BlIGNhbiBuYW1lIGl0LiBTZXQgb25jZSBieSBtYWluKCkuXG5sZXQgQ1VSUkVOVF9DT01NQU5EOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuZnVuY3Rpb24gZXJyb3JFbnZlbG9wZShcbiAga2luZDogRXJyS2luZCxcbiAgbWVzc2FnZTogc3RyaW5nLFxuICBleHRyYT86IHsgaGludD86IHN0cmluZzsgY2hvaWNlcz86IHN0cmluZ1tdIH0sXG4pOiBzdHJpbmcge1xuICByZXR1cm4gYCR7SlNPTi5zdHJpbmdpZnkoe1xuICAgIG9rOiBmYWxzZSxcbiAgICBlcnJvcjoge1xuICAgICAga2luZCxcbiAgICAgIGV4aXRfY29kZTogRVhJVF9GT1Jba2luZF0sXG4gICAgICAvLyBPbmx5IHJhdGUgbGltaXRzIGFyZSB3b3J0aCByZXRyeWluZyB1bmNoYW5nZWQ7IG5vdGhpbmcgbWFncGllIHJhaXNlcyBpcy5cbiAgICAgIHJldHJ5YWJsZTogZmFsc2UsXG4gICAgICBtZXNzYWdlLFxuICAgICAgLi4uKGV4dHJhPy5oaW50ID8geyBoaW50OiBleHRyYS5oaW50IH0gOiB7fSksXG4gICAgICAuLi4oZXh0cmE/LmNob2ljZXMgPyB7IGNob2ljZXM6IGV4dHJhLmNob2ljZXMgfSA6IHt9KSxcbiAgICB9LFxuICAgIG1ldGE6IHsgY29tbWFuZDogQ1VSUkVOVF9DT01NQU5EIH0sXG4gIH0pfVxcbmA7XG59XG5cbmZ1bmN0aW9uIGRpZShcbiAgbXNnOiBzdHJpbmcsXG4gIGtpbmQ6IEVycktpbmQgPSBcInVzYWdlXCIsXG4gIGV4dHJhPzogeyBoaW50Pzogc3RyaW5nOyBjaG9pY2VzPzogc3RyaW5nW10gfSxcbik6IG5ldmVyIHtcbiAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoZXJyb3JFbnZlbG9wZShraW5kLCBtc2csIGV4dHJhKSk7XG4gIHByb2Nlc3MuZXhpdChFWElUX0ZPUltraW5kXSk7XG59XG5cbmZ1bmN0aW9uIHNsZWVwKG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+IHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyKSA9PiBzZXRUaW1lb3V0KHIsIG1zKSk7XG59XG5cbmZ1bmN0aW9uIHNlc3Npb25GaWxlUGF0aChzZXNzaW9uPzogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHNlc3Npb24gPyBqb2luKHRtcGRpcigpLCBgbWFncGllLSR7c2Vzc2lvbn0uanNvbmApIDogam9pbih0bXBkaXIoKSwgXCJtYWdwaWUtbGF0ZXN0Lmpzb25cIik7XG59XG5cbmZ1bmN0aW9uIHJlYWRTZXNzaW9uKHNlc3Npb24/OiBzdHJpbmcpOiBTZXNzaW9uIHwgbnVsbCB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKHNlc3Npb25GaWxlUGF0aChzZXNzaW9uKSwgXCJ1dGY4XCIpKSBhcyBTZXNzaW9uO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG5mdW5jdGlvbiByZXF1aXJlU2Vzc2lvbihzZXNzaW9uPzogc3RyaW5nKTogU2Vzc2lvbiB7XG4gIGNvbnN0IHMgPSByZWFkU2Vzc2lvbihzZXNzaW9uKTtcbiAgaWYgKCFzKSBkaWUoXCJubyBydW5uaW5nIG1hZ3BpZSBzZXNzaW9uIOKAlCBydW46IGNsaS50cyBvcGVuXCIsIFwibm90X2ZvdW5kXCIpO1xuICByZXR1cm4gcztcbn1cblxuYXN5bmMgZnVuY3Rpb24gYXBpKFxuICBwb3J0OiBudW1iZXIsXG4gIG1ldGhvZDogc3RyaW5nLFxuICBwYXRoOiBzdHJpbmcsXG4gIGJvZHk/OiB1bmtub3duLFxuKTogUHJvbWlzZTx7IHN0YXR1czogbnVtYmVyOyBkYXRhOiB1bmtub3duIH0+IHtcbiAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtwb3J0fSR7cGF0aH1gLCB7XG4gICAgbWV0aG9kLFxuICAgIGhlYWRlcnM6IGJvZHkgIT09IHVuZGVmaW5lZCA/IHsgXCJjb250ZW50LXR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSA6IHVuZGVmaW5lZCxcbiAgICBib2R5OiBib2R5ICE9PSB1bmRlZmluZWQgPyBKU09OLnN0cmluZ2lmeShib2R5KSA6IHVuZGVmaW5lZCxcbiAgfSk7XG4gIGxldCBkYXRhOiB1bmtub3duID0gbnVsbDtcbiAgdHJ5IHtcbiAgICBkYXRhID0gYXdhaXQgcmVzLmpzb24oKTtcbiAgfSBjYXRjaCB7fVxuICByZXR1cm4geyBzdGF0dXM6IHJlcy5zdGF0dXMsIGRhdGEgfTtcbn1cblxuLy8gU3BsaXQgYXJndiBpbnRvIHBvc2l0aW9uYWxzICsgZmxhZ3MuIGAtLWZsYWcgdmFsdWVgLCBgLS1mbGFnPXZhbHVlYCwgb3IgYm9vbGVhbi5cbi8vICM4MSAvIEQ0IOKAlCBUSEUgUkVDT0dOSVpFRCBTRVQsIEFUIFBBUlNFUiBBTFRJVFVERS5cbi8vXG4vLyBUaGUgaGFuZC1yb2xsZWQgcGFyc2VyIGhhZCBubyByZWdpc3RyeSwgc28gYW4gdW5rbm93biBmbGFnIHdhcyBhY2NlcHRlZCBhdFxuLy8gZXhpdCAwIGFuZCB0aGUgdmVyYiByYW4gYW55d2F5LCBhbmQgZnJlZSBwcm9zZSBjb250YWluaW5nIGEgYC0td29yZGAgd2FzXG4vLyBzaWxlbnRseSB0cnVuY2F0ZWQgYXQgdGhhdCB3b3JkLiBgbm9kZTp1dGlsYCBzdHJpY3Qgc3VwcGxpZXMgcmVqZWN0aW9uLCB0aGVcbi8vIGA9YCBmb3JtIGFuZCB0aGUgYC0tYCB0ZXJtaW5hdG9yIGZyb20gdGhlIHN0YW5kYXJkIGxpYnJhcnkuXG4vL1xuLy8gVHlwZXMgYXJlIHRob3RoJ3MgYXVkaXRlZCBhcnRpZmFjdCAoMTUgc3RyaW5nIMK3IDQgYm9vbGVhbiksIGVhY2ggc2V0dGxlZCBieVxuLy8gdW5hbWJpZ3VvdXMgZXZpZGVuY2UgYXQgZXZlcnkgY29uc3VtcHRpb24gc2l0ZS4gR2V0dGluZyBvbmUgd3JvbmcgaXMgbm90IGFcbi8vIG5vLW9wOiBhIFwic3RyaW5nXCIgdGhhdCBzaG91bGQgYmUgYm9vbGVhbiBTV0FMTE9XUyBUSEUgTkVYVCBQT1NJVElPTkFMLCBhbmQgYVxuLy8gXCJib29sZWFuXCIgdGhhdCBzaG91bGQgYmUgc3RyaW5nIGJyZWFrcyB0aGUgc3BhY2UgZm9ybS5cbmNvbnN0IENMSV9PUFRJT05TID0ge1xuICBhbHBoYTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGJib3g6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBpZHM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBpbnRlbnQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBsYWJlbDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIG1vZGVsOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbmFtZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIG9wdGlvbnM6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBwYWQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICByZXN0b3JlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc2Vzc2lvbjogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHNpbmNlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdGltZW91dDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRpdGxlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdHlwZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGZ1bGw6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgXCJuby1vcGVuXCI6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgcmVtb3ZlOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHN0ZGluOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG59IGFzIGNvbnN0O1xuXG4vLyBXSElDSCBGTEFHUyBFQUNIIFZFUkIgQUNDRVBUUyDigJQgYW5kIHRoZSBvbmx5IHNvdXJjZSBvZiB0aGUgdmVyYiBzZXQuXG4vL1xuLy8gVGhlIHBhcnNlciB1c2VkIHRvIGVuZm9yY2UgT05FIEdMT0JBTCByZWdpc3RyeTogZXZlcnkgdmVyYiBhY2NlcHRlZCBldmVyeVxuLy8gZmxhZywgc28gYGNsb3NlIC0tYWxwaGEgYXV0b2AgYW5kIGBzYXkgLS1iYm94IDEsMiwzLDRgIHBhcnNlZCBjbGVhbiBhbmQgZGlkXG4vLyBub3RoaW5nLiBBIHJlY29yZGVkLXN1cmZhY2UgY2Vuc3VzIGNvdW50ZWQgMjg5IHN1Y2ggZmxhZy9wYXRoIHBhaXJzIOKAlCAyODlcbi8vIGludm9jYXRpb25zIG1hZ3BpZSBhY2NlcHRlZCBhdCBleGl0IDAgYW5kIGNvdWxkIG5vdCBhY3Qgb24uIFRoYXQgaXMgdGhlXG4vLyBmYWlsdXJlIHRoaXMgd2hvbGUga2l0IGlzIG5hbWVkIGZvcjogdGhlIHRvb2wgZG9lcyB0aGUgd3JvbmcgdGhpbmcgYW5kIHJlcG9ydHNcbi8vIHN1Y2Nlc3MuIEFuIHVua25vd24tZmxhZyBjaGVjayBhdCB0aGUgcm9vdCBjYW5ub3Qgc2VlIGl0LCBiZWNhdXNlIG5vbmUgb2YgdGhlXG4vLyBmbGFncyBhcmUgdW5rbm93biDigJQgdGhleSBhcmUganVzdCBub3Qga25vd24gSEVSRS5cbi8vXG4vLyBTbyB0aGUgcmVjb2duaXplZCBzZXQgaXMgcGVyIHZlcmIsIGFuZCB0aGlzIHRhYmxlIGlzIGl0LiBgVkVSQlNgIGlzIGRlcml2ZWRcbi8vIGZyb20gaXRzIGtleXMgYW5kIGVhY2ggdmVyYiBwYXJzZXMgYWdhaW5zdCBpdHMgb3duIG9wdGlvbnMsIHdoaWNoIG1lYW5zIHRoZVxuLy8gaGVscCB0ZXh0LCB0aGUgcmVqZWN0aW9uJ3MgYGNob2ljZXNgIGFuZCB0aGUgcGFyc2VyIGNhbiBubyBsb25nZXIgZGlzYWdyZWU6XG4vLyB0aGVyZSBpcyBvbmUgb2JqZWN0LCBhbmQgYWRkaW5nIGEgZmxhZyB0byBhIHZlcmIgaXMgb25lIGVkaXQuXG5leHBvcnQgY29uc3QgVkVSQl9TUEVDID0ge1xuICBvcGVuOiBbXCJ0aXRsZVwiLCBcImludGVudFwiLCBcInRpbWVvdXRcIiwgXCJyZXN0b3JlXCIsIFwibm8tb3BlblwiXSxcbiAgc2Vzc2lvbnM6IFtdLFxuICB0YWlsOiBbXCJzZXNzaW9uXCIsIFwic2luY2VcIl0sXG4gIHN0YXRlOiBbXCJzZXNzaW9uXCIsIFwiZnVsbFwiXSxcbiAgc2F5OiBbXCJzZXNzaW9uXCIsIFwic3RkaW5cIl0sXG4gIGFzazogW1wic2Vzc2lvblwiLCBcIm9wdGlvbnNcIl0sXG4gIHN0YXR1czogW1wic2Vzc2lvblwiXSxcbiAgc291cmNlOiBbXCJzZXNzaW9uXCJdLFxuICBkaXNjb3ZlcjogW1wic2Vzc2lvblwiXSxcbiAgZXh0cmFjdDogW1wic2Vzc2lvblwiLCBcImlkc1wiLCBcInJlbW92ZVwiLCBcImFscGhhXCIsIFwicGFkXCIsIFwibW9kZWxcIiwgXCJsYWJlbFwiXSxcbiAgZXhwb3J0OiBbXCJzZXNzaW9uXCIsIFwiaWRzXCJdLFxuICBcImVsZW1lbnQtYWRkXCI6IFtcInNlc3Npb25cIiwgXCJiYm94XCIsIFwibmFtZVwiLCBcInR5cGVcIl0sXG4gIFwiZWxlbWVudC1yZW1vdmVcIjogW1wic2Vzc2lvblwiXSxcbiAgY21kOiBbXCJzZXNzaW9uXCIsIFwic3RkaW5cIl0sXG4gIGNsb3NlOiBbXCJzZXNzaW9uXCJdLFxuICBpbmZvOiBbXCJzZXNzaW9uXCJdLFxuICBoZWxwOiBbXSxcbn0gYXMgY29uc3Qgc2F0aXNmaWVzIFJlY29yZDxzdHJpbmcsIHJlYWRvbmx5IChrZXlvZiB0eXBlb2YgQ0xJX09QVElPTlMpW10+O1xuXG50eXBlIFZlcmIgPSBrZXlvZiB0eXBlb2YgVkVSQl9TUEVDO1xuXG5jb25zdCBWRVJCUyA9IE9iamVjdC5rZXlzKFZFUkJfU1BFQykgYXMgVmVyYltdO1xuXG5jb25zdCBpc1ZlcmIgPSAodjogc3RyaW5nKTogdiBpcyBWZXJiID0+IE9iamVjdC5oYXNPd24oVkVSQl9TUEVDLCB2KTtcblxuLy8gVGhlIGZsYWdzIG9uZSB2ZXJiIGFjY2VwdHMsIGFzIHRoZSBjYWxsZXIgc3BlbGxzIHRoZW0uXG5jb25zdCBmbGFnc0ZvciA9ICh2ZXJiOiBWZXJiKTogc3RyaW5nW10gPT4gVkVSQl9TUEVDW3ZlcmJdLm1hcCgoaykgPT4gYC0tJHtrfWApLnNvcnQoKTtcblxuY2xhc3MgVXNhZ2VFcnJvciBleHRlbmRzIEVycm9yIHt9XG5cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZUFyZ3MoXG4gIGFyZ3M6IHN0cmluZ1tdLFxuICB2ZXJiPzogVmVyYixcbik6IHtcbiAgcG9zOiBzdHJpbmdbXTtcbiAgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+O1xufSB7XG4gIC8vIFRXTyBTVEFHRVMsIEFORCBUSEUgT1JERVIgSVMgVEhFIFBPSU5ULlxuICAvL1xuICAvLyBTdGFnZSAxIHBhcnNlcyBhZ2FpbnN0IHRoZSBXSE9MRSByZWdpc3RyeSwgc28gYSB0b2tlbiBtYWdwaWUgaGFzIG5ldmVyXG4gIC8vIGhlYXJkIG9mIGlzIHJlZnVzZWQgYnkgYG5vZGU6dXRpbGAgd2l0aCBpdHMgb3duIG1lc3NhZ2UuIFN0YWdlIDIgdGhlbiBhc2tzXG4gIC8vIHRoZSBxdWVzdGlvbiB0aGUgcGFyc2VyIGNhbm5vdDogaXMgdGhpcyBmbGFnIGFjY2VwdGVkIEFUIFRISVMgVkVSQi5cbiAgLy9cbiAgLy8gRG9pbmcgaXQgdGhlIG90aGVyIHdheSDigJQgaGFuZGluZyBwYXJzZUFyZ3MgYSBwZXItdmVyYiBzdWJzZXQg4oCUIHdhcyB0aGUgZmlyc3RcbiAgLy8gc2hhcGUsIGFuZCBpdCBhbnN3ZXJlZCBgc2F5IC0tYmJveGAgd2l0aCBcIlVua25vd24gb3B0aW9uICctLWJib3gnXCIsIHdoaWNoIGlzXG4gIC8vIGZhbHNlLiBgLS1iYm94YCBpcyBhIHBlcmZlY3RseSBnb29kIGZsYWc7IGl0IGp1c3QgaXMgbm90IGBzYXlgJ3MuIEFuIGFnZW50XG4gIC8vIHRvbGQgYSByZWFsIGZsYWcgaXMgdW5rbm93biBnb2VzIGxvb2tpbmcgZm9yIGEgdHlwbyBpdCBkaWQgbm90IG1ha2UuXG4gIC8vXG4gIC8vIEl0IGFsc28gY29zdCB0aGUgZ3JpbW9pcmUncyBmbGFnLWludmFyaWFudCB3YXJkIGl0cyBmb290aW5nOiB0aGF0IGNoZWNrXG4gIC8vIHJlc29sdmVzIGBvcHRpb25zOiA8aWRlbnRpZmllcj5gIGJhY2sgdG8gYSBsaXRlcmFsIGRlY2xhcmF0aW9uLCBhbmQgYSBzdWJzZXRcbiAgLy8gY29tcHV0ZWQgYXQgdGhlIGNhbGwgc2l0ZSBpcyBub3Qgb25lLiBUaGUgd2FyZCBjb3VsZCBubyBsb25nZXIgcmVhZCBtYWdwaWUnc1xuICAvLyByZWdpc3RyeSBhdCBhbGwgYW5kIHJlcG9ydGVkIHRoZSBlbnRyeSBwb2ludCB1bnJlc29sdmVkIOKAlCB0aGUgaW5zdHJ1bWVudFxuICAvLyBzYXlpbmcgXCJJIGNhbm5vdCBzZWUgdGhpc1wiLCBleGFjdGx5IGFzIGRlc2lnbmVkLiBLZWVwaW5nIGBDTElfT1BUSU9OU2AgYXRcbiAgLy8gdGhlIGNhbGwgc2l0ZSBrZWVwcyB0aGUgcmVnaXN0cnkgbGVnaWJsZSB0byBpdC5cbiAgbGV0IHBhcnNlZDogeyB2YWx1ZXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+OyBwb3NpdGlvbmFsczogc3RyaW5nW10gfTtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBub2RlUGFyc2VBcmdzKHtcbiAgICAgIGFyZ3MsXG4gICAgICBvcHRpb25zOiBDTElfT1BUSU9OUyxcbiAgICAgIHN0cmljdDogdHJ1ZSxcbiAgICAgIGFsbG93UG9zaXRpb25hbHM6IHRydWUsXG4gICAgfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICB0aHJvdyBuZXcgVXNhZ2VFcnJvcihlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkpO1xuICB9XG5cbiAgaWYgKHZlcmIpIHtcbiAgICBjb25zdCBhbGxvd2VkID0gbmV3IFNldDxzdHJpbmc+KFZFUkJfU1BFQ1t2ZXJiXSk7XG4gICAgY29uc3Qgc3RyYXkgPSBPYmplY3Qua2V5cyhwYXJzZWQudmFsdWVzKS5maW5kKChrKSA9PiAhYWxsb3dlZC5oYXMoaykpO1xuICAgIGlmIChzdHJheSkge1xuICAgICAgdGhyb3cgbmV3IFVzYWdlRXJyb3IoXG4gICAgICAgIGAtLSR7c3RyYXl9IGlzIG5vdCBhY2NlcHRlZCBieSBcXGAke3ZlcmJ9XFxgIChpdCBpcyBhIHJlY29nbml6ZWQgbWFncGllIGZsYWcsIGp1c3Qgbm90IHRoaXMgdmVyYidzKWAsXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiB7XG4gICAgcG9zOiBwYXJzZWQucG9zaXRpb25hbHMsXG4gICAgZmxhZ3M6IHBhcnNlZC52YWx1ZXMgYXMgUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4sXG4gIH07XG59XG5cbi8vIFJlYWQgYWxsIG9mIHN0ZGluIGFzIHRleHQgKEJ1bi5zdGRpbikuIFVzZWQgYnkgYC0tc3RkaW5gIHNvIE5MIHRleHQgaXNuJ3QgYVxuLy8gc2hlbGwtcGFyc2VkIGFyZy5cbmFzeW5jIGZ1bmN0aW9uIHJlYWRTdGRpbigpOiBQcm9taXNlPHN0cmluZz4ge1xuICByZXR1cm4gKGF3YWl0IEJ1bi5zdGRpbi50ZXh0KCkpLnRyaW0oKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcG9zdENtZChzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsIG1zZzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIHtcbiAgY29uc3QgcyA9IHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pO1xuICBjb25zdCB7IHN0YXR1cyB9ID0gYXdhaXQgYXBpKHMucG9ydCwgXCJQT1NUXCIsIFwiL2NtZFwiLCBtc2cpO1xuICBpZiAoc3RhdHVzICE9PSAyMDApIGRpZShgY21kIGZhaWxlZCAoSFRUUCAke3N0YXR1c30pIOKAlCBpcyB0aGUgc2Vzc2lvbiBzdGlsbCBhbGl2ZT9gLCBcImludGVybmFsXCIpO1xuICBwcmludEpzb24oeyBvazogdHJ1ZSwgc2VudDogbXNnLnR5cGUgfSk7XG59XG5cbi8vIOKUgOKUgCB2ZXJicyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuYXN5bmMgZnVuY3Rpb24gY21kT3BlbihmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgYXJncyA9IFtcInJ1blwiLCBTRVJWRVJfU0NSSVBUXTtcbiAgaWYgKGZsYWdzLnRpdGxlKSBhcmdzLnB1c2goXCItLXRpdGxlXCIsIFN0cmluZyhmbGFncy50aXRsZSkpO1xuICBpZiAoZmxhZ3MuaW50ZW50KSBhcmdzLnB1c2goXCItLWludGVudFwiLCBTdHJpbmcoZmxhZ3MuaW50ZW50KSk7XG4gIGlmIChmbGFncy50aW1lb3V0KSBhcmdzLnB1c2goXCItLXRpbWVvdXRcIiwgU3RyaW5nKGZsYWdzLnRpbWVvdXQpKTtcbiAgaWYgKGZsYWdzLnJlc3RvcmUpIGFyZ3MucHVzaChcIi0tcmVzdG9yZVwiLCBTdHJpbmcoZmxhZ3MucmVzdG9yZSkpO1xuICBpZiAoZmxhZ3NbXCJuby1vcGVuXCJdKSBhcmdzLnB1c2goXCItLW5vLW9wZW5cIik7XG5cbiAgY29uc3QgcHJldklkID0gcmVhZFNlc3Npb24oKT8uc2Vzc2lvbl9pZDtcbiAgLy8gRGV0YWNoZWQgbm9kZTpjaGlsZF9wcm9jZXNzIChub3QgQnVuLnNwYXduKSBzbyB0aGUgZGFlbW9uIFNVUlZJVkVTIHRoaXMgQ0xJXG4gIC8vIHByb2Nlc3MgZXhpdGluZyDigJQgdGhlIGhvdXNlIHBhdHRlcm4gZm9yIGEgc3RhbmRpbmcgZGFlbW9uLiBjd2QgcGlubmVkIHRvIHRoZVxuICAvLyBza2lsbCByb290IHNvIEJ1biBmaW5kcyBidW5maWcudG9tbCAocmVnaXN0ZXJzIGJ1bi1wbHVnaW4tdGFpbHdpbmQpLlxuICBjb25zdCBwcm9jID0gc3Bhd24ocHJvY2Vzcy5leGVjUGF0aCwgYXJncywge1xuICAgIGRldGFjaGVkOiB0cnVlLFxuICAgIHN0ZGlvOiBbXCJpZ25vcmVcIiwgXCJpZ25vcmVcIiwgXCJpZ25vcmVcIl0sXG4gICAgZW52OiBwcm9jZXNzLmVudixcbiAgICBjd2Q6IGpvaW4oU0NSSVBUX0RJUiwgXCIuLlwiKSxcbiAgfSk7XG4gIHByb2MudW5yZWYoKTtcblxuICBjb25zdCBkZWFkbGluZSA9IERhdGUubm93KCkgKyA1MDAwO1xuICB3aGlsZSAoRGF0ZS5ub3coKSA8IGRlYWRsaW5lKSB7XG4gICAgYXdhaXQgc2xlZXAoODApO1xuICAgIGNvbnN0IHMgPSByZWFkU2Vzc2lvbigpO1xuICAgIGlmIChzICYmIHMuc2Vzc2lvbl9pZCAhPT0gcHJldklkKSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCByID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtzLnBvcnR9L3N0YXRlYCk7XG4gICAgICAgIGlmIChyLm9rKSB7XG4gICAgICAgICAgcHJpbnRKc29uKHMpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIG5vdCB1cCB5ZXQgKi9cbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgZGllKFwibWFncGllIHNlcnZlciBmYWlsZWQgdG8gc3RhcnQgd2l0aGluIDVzXCIsIFwiaW50ZXJuYWxcIik7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFN0YXRlKHNlc3Npb24/OiBzdHJpbmcsIGZ1bGwgPSBmYWxzZSkge1xuICBjb25zdCBzID0gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbik7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGkocy5wb3J0LCBcIkdFVFwiLCBgL3N0YXRlJHtmdWxsID8gXCJcIiA6IFwiP2xlYW49MVwifWApO1xuICBpZiAoc3RhdHVzICE9PSAyMDApIGRpZShgc3RhdGUgZmFpbGVkIChIVFRQICR7c3RhdHVzfSlgLCBcImludGVybmFsXCIpO1xuICBwcmludEpzb24oZGF0YSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFRhaWwoc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkLCBzaW5jZUFyZzogbnVtYmVyKSB7XG4gIGxldCBzaW5jZSA9IHNpbmNlQXJnO1xuICBsZXQgZGVsYXkgPSAyNTA7XG4gIGxldCBzdG9wcGVkID0gZmFsc2U7XG4gIGxldCBib3VuZElkID0gc2Vzc2lvbjtcbiAgbGV0IGdyb3VuZGVkID0gZmFsc2U7XG4gIGNvbnN0IHN0b3AgPSAoKSA9PiB7XG4gICAgc3RvcHBlZCA9IHRydWU7XG4gICAgcHJvY2Vzcy5leGl0KDApO1xuICB9O1xuICBwcm9jZXNzLm9uKFwiU0lHSU5UXCIsIHN0b3ApO1xuICBwcm9jZXNzLm9uKFwiU0lHVEVSTVwiLCBzdG9wKTtcblxuICB3aGlsZSAoIXN0b3BwZWQpIHtcbiAgICBjb25zdCBzID0gcmVhZFNlc3Npb24oYm91bmRJZCk7XG4gICAgaWYgKCFzKSB7XG4gICAgICBpZiAoZ3JvdW5kZWQpIHByb2Nlc3MuZXhpdCgwKTsgLy8gb3VyIHBpbm5lZCBzZXNzaW9uIHdlbnQgYXdheSDihpIgZG9uZVxuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXCIjIG5vIHNlc3Npb24geWV0LCByZXRyeWluZ+KAplxcblwiKTtcbiAgICAgIGF3YWl0IHNsZWVwKGRlbGF5KTtcbiAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCA1MDAwKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoIWJvdW5kSWQpIGJvdW5kSWQgPSBzLnNlc3Npb25faWQ7IC8vIHBpbiB0byB0aGUgZmlyc3Qgc2Vzc2lvbiB3ZSByZXNvbHZlZFxuICAgIGlmICghZ3JvdW5kZWQpIHtcbiAgICAgIGdyb3VuZGVkID0gdHJ1ZTtcbiAgICAgIC8vIGdyb3VuZGluZyBhbmNob3Ig4oCUIHBhcnNlYWJsZSArIHZpc2libGUgaW4gYSBNb25pdG9yOyBuYW1lcyB0aGUgYmluZGluZy5cbiAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKFxuICAgICAgICBgJHtKU09OLnN0cmluZ2lmeSh7IHR5cGU6IFwiZ3JvdW5kaW5nXCIsIHNlc3Npb25faWQ6IHMuc2Vzc2lvbl9pZCwgcG9ydDogcy5wb3J0IH0pfVxcbmAsXG4gICAgICApO1xuICAgIH1cbiAgICBsZXQgcmVzOiBSZXNwb25zZTtcbiAgICB0cnkge1xuICAgICAgcmVzID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtzLnBvcnR9L2V2ZW50cz9zaW5jZT0ke3NpbmNlfWApO1xuICAgIH0gY2F0Y2gge1xuICAgICAgYXdhaXQgc2xlZXAoZGVsYXkpO1xuICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIDUwMDApO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmICghcmVzLm9rIHx8ICFyZXMuYm9keSkge1xuICAgICAgYXdhaXQgc2xlZXAoZGVsYXkpO1xuICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIDUwMDApO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGRlbGF5ID0gMjUwO1xuICAgIGNvbnN0IHJlYWRlciA9IHJlcy5ib2R5LmdldFJlYWRlcigpO1xuICAgIGNvbnN0IGRlYyA9IG5ldyBUZXh0RGVjb2RlcigpO1xuICAgIGxldCBidWYgPSBcIlwiO1xuICAgIHdoaWxlICh0cnVlKSB7XG4gICAgICBsZXQgY2h1bms6IFJlYWRhYmxlU3RyZWFtUmVhZFJlc3VsdDxVaW50OEFycmF5PjtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNodW5rID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGlmIChjaHVuay5kb25lKSBicmVhaztcbiAgICAgIGJ1ZiArPSBkZWMuZGVjb2RlKGNodW5rLnZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcbiAgICAgIGZvciAobGV0IHNlcCA9IGJ1Zi5pbmRleE9mKFwiXFxuXFxuXCIpOyBzZXAgPj0gMDsgc2VwID0gYnVmLmluZGV4T2YoXCJcXG5cXG5cIikpIHtcbiAgICAgICAgY29uc3QgYmxvY2sgPSBidWYuc2xpY2UoMCwgc2VwKTtcbiAgICAgICAgYnVmID0gYnVmLnNsaWNlKHNlcCArIDIpO1xuICAgICAgICBjb25zdCBkYXRhTGluZXM6IHN0cmluZ1tdID0gW107XG4gICAgICAgIGZvciAoY29uc3QgbGluZSBvZiBibG9jay5zcGxpdChcIlxcblwiKSkge1xuICAgICAgICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoXCI6XCIpKSB7XG4gICAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcIjogbWFncGllLWtlZXBhbGl2ZVxcblwiKTtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAobGluZS5zdGFydHNXaXRoKFwiZGF0YTpcIikpIGRhdGFMaW5lcy5wdXNoKGxpbmUuc2xpY2UoNSkudHJpbSgpKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIWRhdGFMaW5lcy5sZW5ndGgpIGNvbnRpbnVlO1xuICAgICAgICBjb25zdCBwYXlsb2FkID0gZGF0YUxpbmVzLmpvaW4oXCJcXG5cIik7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgZXYgPSBKU09OLnBhcnNlKHBheWxvYWQpIGFzIHsgaWQ/OiBudW1iZXI7IHR5cGU/OiBzdHJpbmcgfTtcbiAgICAgICAgICBpZiAodHlwZW9mIGV2LmlkID09PSBcIm51bWJlclwiICYmIGV2LmlkID4gc2luY2UpIHNpbmNlID0gZXYuaWQ7XG4gICAgICAgICAgaWYgKGV2LnR5cGUgPT09IFwiY2xvc2VkXCIpIHtcbiAgICAgICAgICAgIC8vIFAwZiDigJQgU0hBUEUgQjogdGhlIGRyYWluIGNhbGxiYWNrIHJpZGVzIFRISVMgd3JpdGUsIHNvIGl0IGZpcmVzXG4gICAgICAgICAgICAvLyBvbiB0aGlzIHdyaXRlJ3MgY29tcGxldGlvbi4gTk9UIGEgdHJhaWxpbmcgYHdyaXRlKFwiXCIsIGNiKWAg4oCUIGFcbiAgICAgICAgICAgIC8vIGRyYWluIGNhbGxiYWNrIGNvdmVycyBvbmx5IGl0cyBvd24gd3JpdGUgYW5kIGlzIG5vdCBhIGJhcnJpZXJcbiAgICAgICAgICAgIC8vIChtZWFzdXJlZCBieXRlLWZvci1ieXRlIGFzIGJyb2tlbiBhcyBubyBmaXgpLCBhbmQgdGhhdCBpcyBleGFjdGx5XG4gICAgICAgICAgICAvLyB0aGUgaGVscGVyIHRoaXMgd3JpdGUtdGhlbi1leGl0IHNoYXBlIGludml0ZXMuXG4gICAgICAgICAgICAvL1xuICAgICAgICAgICAgLy8gUEVSLVNJVEUgUFJFQ09ORElUSU9OLCByZWFkIGF0IFRISVMgc2l0ZSByYXRoZXIgdGhhbiBjYXJyaWVkIG92ZXJcbiAgICAgICAgICAgIC8vIGZyb20gYSBzaWJsaW5nOiB0aGUgZXhpdCBzaXRzIGluc2lkZSBgd2hpbGUgKCFzdG9wcGVkKWAgLT5cbiAgICAgICAgICAgIC8vIGB3aGlsZSAodHJ1ZSlgIC0+IHRoZSBmcmFtZSBsb29wLCBzbyBgcHJvY2Vzcy5leGl0Q29kZWAgKyBhXG4gICAgICAgICAgICAvLyBuYXR1cmFsIHJldHVybiAoc2hhcGUgRCkgZG9lcyBOT1QgbGVhdmUgdGhlIHRhaWwg4oCUIGl0IGZhbGxzXG4gICAgICAgICAgICAvLyB0aHJvdWdoIGFuZCB0aGUgbG9vcHMgZ28gcm91bmQgYWdhaW4uIFRoZSBleHBsaWNpdCBgcmV0dXJuYCBpc1xuICAgICAgICAgICAgLy8gd2hhdCBleGl0cyB0aGUgbG9vcHM7IHRoZSBjYWxsYmFjayBpcyB3aGF0IGRyYWlucy4gQm90aCwgZm9yXG4gICAgICAgICAgICAvLyBkaWZmZXJlbnQgcmVhc29ucy5cbiAgICAgICAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke3BheWxvYWR9XFxuYCwgKCkgPT4gcHJvY2Vzcy5leGl0KDApKTtcbiAgICAgICAgICAgIHN0b3BwZWQgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgIH1cbiAgICAgICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtwYXlsb2FkfVxcbmApO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAvKiBza2lwIG1hbGZvcm1lZCBmcmFtZSAqL1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICAgIGF3YWl0IHNsZWVwKGRlbGF5KTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjbWRJbmZvKHNlc3Npb24/OiBzdHJpbmcpIHtcbiAgY29uc3QgcyA9IHJlYWRTZXNzaW9uKHNlc3Npb24pO1xuICBpZiAoIXMpIGRpZShcIm5vIHJ1bm5pbmcgbWFncGllIHNlc3Npb25cIiwgXCJub3RfZm91bmRcIik7XG4gIHByaW50SnNvbihzKTtcbn1cblxuZnVuY3Rpb24gY21kU2Vzc2lvbnMoKSB7XG4gIC8vIE1pcnJvciBwZXJzaXN0LnNlcnZlcidzIHNuYXBzaG90IGRpciByZXNvbHV0aW9uIChhdm9pZCBpbXBvcnRpbmcgbm9kZTpmcyBwYXRoXG4gIC8vIGxvZ2ljIHR3aWNlKTogJE1BR1BJRV9IT01FL3NuYXBzaG90cyBvciB+Ly5tYWdwaWUvc25hcHNob3RzLlxuICBjb25zdCBob21lID0gcHJvY2Vzcy5lbnYuTUFHUElFX0hPTUUgPz8gam9pbihwcm9jZXNzLmVudi5IT01FID8/IFwiXCIsIFwiLm1hZ3BpZVwiKTtcbiAgY29uc3QgZGlyID0gam9pbihob21lLCBcInNuYXBzaG90c1wiKTtcbiAgbGV0IGZpbGVzOiBzdHJpbmdbXTtcbiAgdHJ5IHtcbiAgICBmaWxlcyA9IHJlYWRkaXJTeW5jKGRpcikuZmlsdGVyKChmKSA9PiBmLmVuZHNXaXRoKFwiLmpzb25cIikpO1xuICB9IGNhdGNoIHtcbiAgICBwcmludEpzb24oeyBzZXNzaW9uczogW10gfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHR5cGUgUm93ID0geyBpZDogc3RyaW5nOyB0aXRsZTogc3RyaW5nOyBlbGVtZW50czogbnVtYmVyOyBtdGltZTogbnVtYmVyIH07XG4gIGNvbnN0IHJvd3M6IFJvd1tdID0gW107XG4gIGZvciAoY29uc3QgZiBvZiBmaWxlcykge1xuICAgIGNvbnN0IHBhdGggPSBqb2luKGRpciwgZik7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHN0ID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpKTtcbiAgICAgIHJvd3MucHVzaCh7XG4gICAgICAgIGlkOiBmLnJlcGxhY2UoL1xcLmpzb24kLywgXCJcIiksXG4gICAgICAgIHRpdGxlOiBzdC50aXRsZSxcbiAgICAgICAgZWxlbWVudHM6IEFycmF5LmlzQXJyYXkoc3QuZWxlbWVudHMpID8gc3QuZWxlbWVudHMubGVuZ3RoIDogMCxcbiAgICAgICAgbXRpbWU6IHN0YXRTeW5jKHBhdGgpLm10aW1lTXMsXG4gICAgICB9KTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIHNraXAgdW5yZWFkYWJsZSBzbmFwc2hvdCAqL1xuICAgIH1cbiAgfVxuICByb3dzLnNvcnQoKGEsIGIpID0+IGIubXRpbWUgLSBhLm10aW1lKTtcbiAgLy8gT05FIEpTT04gZG9jdW1lbnQsIGxpa2UgZXZlcnkgb3RoZXIgZGF0YSB2ZXJiLiBUaGlzIHByaW50ZWQgYSBwcm9zZSB0YWJsZVxuICAvLyB1bnRpbCB0aGUgbWFjaGluZS1tb2RlIGRlY2xhcmF0aW9uIHdlbnQgaW4sIGF0IHdoaWNoIHBvaW50IHRoZSB0b29sIHdhc1xuICAvLyBjbGFpbWluZyBgZGVmYXVsdE91dHB1dDogXCJqc29uXCJgIHdoaWxlIGFuc3dlcmluZyB0aGlzIHZlcmIgaW4gcHJvc2Ug4oCUIGFcbiAgLy8gZGVjbGFyYXRpb24gaXMgb25seSB3b3J0aCB3aGF0IGl0cyBsZWFzdCBob25lc3QgcGF0aCBtYWtlcyBpdC5cbiAgcHJpbnRKc29uKHsgc2Vzc2lvbnM6IHJvd3MgfSk7XG59XG5cbi8vIGBzb3VyY2UgPGltYWdlUGF0aD5gIOKAlCBjb21wdXRlIHNoYTI1Nls6MTZdICsgcGl4ZWwgc2l6ZSAoQnVuLkltYWdlKSBhbmQgcG9zdFxuLy8gc291cmNlLnNldC4gVGhlIGFnZW50IHJ1bnMgZGlzY292ZXIgc2VwYXJhdGVseTsgdGhpcyBqdXN0IHJlZ2lzdGVycyB0aGUgYm9hcmQuXG5hc3luYyBmdW5jdGlvbiBjbWRTb3VyY2Uoc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkLCBpbWFnZVBhdGg6IHN0cmluZykge1xuICBjb25zdCBmaWxlID0gQnVuLmZpbGUoaW1hZ2VQYXRoKTtcbiAgaWYgKCEoYXdhaXQgZmlsZS5leGlzdHMoKSkpIGRpZShgaW1hZ2Ugbm90IGZvdW5kOiAke2ltYWdlUGF0aH1gLCBcIm5vdF9mb3VuZFwiKTtcbiAgY29uc3QgYnl0ZXMgPSBuZXcgVWludDhBcnJheShhd2FpdCBmaWxlLmFycmF5QnVmZmVyKCkpO1xuICBjb25zdCBzaGEgPSBuZXcgQnVuLkNyeXB0b0hhc2hlcihcInNoYTI1NlwiKS51cGRhdGUoYnl0ZXMpLmRpZ2VzdChcImhleFwiKS5zbGljZSgwLCAxNik7XG4gIGNvbnN0IG1ldGEgPSBhd2FpdCBuZXcgQnVuLkltYWdlKGJ5dGVzKS5tZXRhZGF0YSgpO1xuICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICB0eXBlOiBcInNvdXJjZS5zZXRcIixcbiAgICBwYXRoOiBpbWFnZVBhdGgsXG4gICAgc2l6ZTogW21ldGEud2lkdGggPz8gMCwgbWV0YS5oZWlnaHQgPz8gMF0sXG4gICAgc2hhLFxuICB9KTtcbn1cblxuLy8gYGVsZW1lbnQtYWRkIC0tYmJveCBcIngxLHkxLHgyLHkyXCIgWy0tbmFtZSAuLl0gWy0tdHlwZSAuLl1gIOKAlCBhZ2VudCBib3hlcyBhXG4vLyByZWdpb24gaW5jcmVtZW50YWxseSAoc291cmNlIHBpeGVscykuIE1pcnJvcnMgdGhlIHVzZXIncyBcIm1hcmsgYSBtaXNzZWQgcmVnaW9uXCIuXG5hc3luYyBmdW5jdGlvbiBjbWRFbGVtZW50QWRkKHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCwgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KSB7XG4gIGNvbnN0IHJhdyA9IHR5cGVvZiBmbGFncy5iYm94ID09PSBcInN0cmluZ1wiID8gZmxhZ3MuYmJveCA6IFwiXCI7XG4gIGNvbnN0IHBhcnRzID0gcmF3LnNwbGl0KFwiLFwiKS5tYXAoKG4pID0+IHBhcnNlSW50KG4udHJpbSgpLCAxMCkpO1xuICBpZiAocGFydHMubGVuZ3RoICE9PSA0IHx8IHBhcnRzLnNvbWUoKG4pID0+IE51bWJlci5pc05hTihuKSkpIHtcbiAgICBkaWUoJ3VzYWdlOiBlbGVtZW50LWFkZCAtLWJib3ggXCJ4MSx5MSx4Mix5MlwiIFstLW5hbWUgPG5hbWU+XSBbLS10eXBlIDx0eXBlPl0nKTtcbiAgfVxuICBjb25zdCBlbGVtZW50OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgYmJveDogcGFydHMgfTtcbiAgaWYgKHR5cGVvZiBmbGFncy5uYW1lID09PSBcInN0cmluZ1wiKSBlbGVtZW50Lm5hbWUgPSBmbGFncy5uYW1lO1xuICBpZiAodHlwZW9mIGZsYWdzLnR5cGUgPT09IFwic3RyaW5nXCIpIGVsZW1lbnQudHlwZSA9IGZsYWdzLnR5cGU7XG4gIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcImVsZW1lbnQuYWRkXCIsIGVsZW1lbnQgfSk7XG59XG5cbi8vIGBkaXNjb3ZlcmAg4oCUIHJlYWQgL3N0YXRlIGZvciBzb3VyY2UucGF0aCwgcnVuIGRpc2NvdmVyLnRzIG9uIGl0LCBidWlsZCB0aGVcbi8vIEVsZW1lbnRbXSAoc3RhdHVzIFwicHJvcG9zZWRcIiwgYmJveCBmcm9tIHRoZSBtYW5pZmVzdCdzIGJib3hfcGl4ZWwpLCBhbmQgUE9TVFxuLy8gZWxlbWVudHMuc2V0LiBUaGUgd2hvbGUgZGlzY292ZXLihpJicmVha2Rvd24gbG9vcCBpbiBvbmUgc2hvdCAoZm9yIHRoZSBhZ2VudCBvciBhXG4vLyB0ZXN0ZXIpLiBSZXF1aXJlcyBPUEVOUk9VVEVSX0FQSV9LRVkgaW4gdGhlIGVudmlyb25tZW50LlxuYXN5bmMgZnVuY3Rpb24gY21kRGlzY292ZXIoc2Vzc2lvbj86IHN0cmluZykge1xuICBjb25zdCBzID0gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbik7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGkocy5wb3J0LCBcIkdFVFwiLCBcIi9zdGF0ZVwiKTtcbiAgaWYgKHN0YXR1cyAhPT0gMjAwKSBkaWUoYHN0YXRlIGZhaWxlZCAoSFRUUCAke3N0YXR1c30pYCwgXCJpbnRlcm5hbFwiKTtcbiAgY29uc3Qgc3JjID0gKGRhdGEgYXMgeyBzdGF0ZT86IHsgc291cmNlPzogeyBwYXRoPzogc3RyaW5nIH0gfSB9KS5zdGF0ZT8uc291cmNlO1xuICBjb25zdCBwYXRoID0gc3JjPy5wYXRoO1xuICBpZiAoIXBhdGgpIGRpZShcIm5vIHNvdXJjZSBzZXQg4oCUIGRyb3AgYSBjb21wb3NpdGUgKG9yIHJ1bjogc291cmNlIDxpbWFnZVBhdGg+KSBmaXJzdFwiLCBcImNvbmZsaWN0XCIpO1xuICBsZXQgbWFuaWZlc3Q6IEF3YWl0ZWQ8UmV0dXJuVHlwZTx0eXBlb2YgZGlzY292ZXI+PjtcbiAgdHJ5IHtcbiAgICBtYW5pZmVzdCA9IGF3YWl0IGRpc2NvdmVyKHBhdGgpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgaWYgKGUgaW5zdGFuY2VvZiBEaXNjb3ZlckVycm9yKSBkaWUoYGRpc2NvdmVyIGZhaWxlZDogJHtlLm1lc3NhZ2V9YCwgXCJpbnRlcm5hbFwiKTtcbiAgICB0aHJvdyBlO1xuICB9XG4gIGNvbnN0IGVsZW1lbnRzOiBFbGVtZW50W10gPSBtYW5pZmVzdC5lbGVtZW50cy5tYXAoKGUpID0+ICh7XG4gICAgaWQ6IG5ld0lkKFwiZVwiKSxcbiAgICBuYW1lOiBlLm5hbWUsXG4gICAgdHlwZTogZS50eXBlLFxuICAgIGJib3g6IGUuYmJveF9waXhlbCxcbiAgICBzdGF0dXM6IFwicHJvcG9zZWRcIixcbiAgfSkpO1xuICBjb25zdCBjb3N0ID0gbWFuaWZlc3QuY29zdF91c2QgPyBgIOKAlCAkJHttYW5pZmVzdC5jb3N0X3VzZC50b0ZpeGVkKDQpfWAgOiBcIlwiO1xuICBwcm9jZXNzLnN0ZGVyci53cml0ZShgbWFncGllOiBkaXNjb3ZlcmVkICR7ZWxlbWVudHMubGVuZ3RofSBlbGVtZW50KHMpIG9uICR7cGF0aH0ke2Nvc3R9XFxuYCk7XG4gIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcImVsZW1lbnRzLnNldFwiLCBlbGVtZW50cyB9KTtcbn1cblxuLy8gTWlycm9yIHJlbW92ZS5weSdzIHNhZmVfZmlsZW5hbWUgc28gdGhlIGN1dG91dCBmaWxlbmFtZSBpcyBzdGFibGUgKyB0cmF2ZXJzYWwtXG4vLyBzYWZlICh0aGUgc3VyZmFjZSBzZXJ2ZXMgaXQgdmlhIC9hc3NldHMvPGJhc2VuYW1lPikuXG5mdW5jdGlvbiBzYW5pdGl6ZShuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBjbGVhbmVkID0gQXJyYXkuZnJvbShuYW1lIHx8IFwiXCIpXG4gICAgLm1hcCgoYykgPT4gKC9bQS1aYS16MC05XFwtXy5dLy50ZXN0KGMpID8gYyA6IFwiX1wiKSlcbiAgICAuam9pbihcIlwiKVxuICAgIC5yZXBsYWNlKC9eXFwuKy8sIFwiXCIpOyAvLyBubyBoaWRkZW4gZG90ZmlsZXNcbiAgcmV0dXJuIGNsZWFuZWQgfHwgXCJlbGVtZW50XCI7XG59XG5cbi8vIFRoZSBvbi1kaXNrIGZpbGVuYW1lIGZvciBhIHZlcnNpb246IGVhY2ggTU9ERUwgZ2V0cyBpdHMgb3duIGZpbGUgc28gdmVyc2lvbnNcbi8vIGRvbid0IG92ZXJ3cml0ZSBlYWNoIG90aGVyIGFuZCBkb24ndCBjb2xsaWRlIGluIHRoZSBicm93c2VyIGNhY2hlICh0d28gdmVyc2lvbnNcbi8vIGF0IHRoZSBzYW1lIFVSTCB3b3VsZCBzaG93IGEgc3RhbGUgaW1hZ2UpLiBUaGUgcmF3IGNyb3Aga2VlcHMgdGhlIGJhcmVcbi8vIGA8bmFtZT4ucG5nYDsgZXZlcnkgcmVtb3ZhbCBtb2RlbCBpcyBzdWZmaXhlZCBgPG5hbWU+Ljxtb2RlbD4ucG5nYC5cbmV4cG9ydCBmdW5jdGlvbiBjdXRvdXRGaWxlbmFtZShuYW1lOiBzdHJpbmcsIGJhY2tlbmQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtzYW5pdGl6ZShuYW1lKX0ke2JhY2tlbmQgPT09IFwiY3JvcFwiID8gXCJcIiA6IGAuJHtiYWNrZW5kfWB9LnBuZ2A7XG59XG5cbi8vIGBleHRyYWN0IFstLWlkcyBhLGJdIFstLXJlbW92ZV0gWy0tYWxwaGEgYXV0b3xhbGx8bm9uZV0gWy0tcGFkIE5dYCDigJQgY3V0IGFcbi8vIHNsaWNlIGZvciBldmVyeSBub24tZHJvcHBlZCBlbGVtZW50IChvciBqdXN0IGAtLWlkc2AsIG9uIHJlLWN1dCkuIERFRkFVTFQgaXNcbi8vIENST1AtT05MWSAoYSByYXcgUGlsbG93IHNsaWNlLCBubyBiYWNrZ3JvdW5kIHJlbW92YWwg4oaSIGJhY2tlbmQgbGFiZWwgXCJjcm9wXCIpLlxuLy8gYC0tcmVtb3ZlYCBzd2l0Y2hlcyBvbiByZW1iZyBiYWNrZ3JvdW5kIHJlbW92YWwgKC0tYWxwaGEgYXV0byDihpIgYmFja2VuZFxuLy8gXCJyZW1iZ1wiKSBmb3IgdGhlIG5leHQgcGhhc2U7IGFuIGV4cGxpY2l0IGAtLWFscGhhYCBvdmVycmlkZXMgdGhlIHBvbGljeS5cbi8vIFJlYWRzIC9zdGF0ZSBmb3Igc291cmNlLnBhdGggKyBlbGVtZW50cywgY3V0cyBlYWNoIHZpYSByZW1iZ0JhY2tlbmQgKOKGklxuLy8gcmVtb3ZlLnB5KSwgYW5kIHBvc3RzIHRoZSByZXN1bHQgYmFjayB3aXRoIGVsZW1lbnQuYWRkVmVyc2lvbi4gU2V0cyB0aGUgYnVzeVxuLy8gc3Bpbm5lciBhcm91bmQgdGhlIGxvb3A7IHBlci1lbGVtZW50IHByb2dyZXNzIOKGkiBzdGRlcnIsIHN1bW1hcnkg4oaSIHN0ZG91dC5cbmFzeW5jIGZ1bmN0aW9uIGNtZEV4dHJhY3Qoc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkLCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgcyA9IHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pO1xuICBpZiAoIXMuZmlsZXNfZGlyKSBkaWUoXCJzZXNzaW9uIGhhcyBubyBmaWxlc19kaXIg4oCUIGNhbm5vdCBtYXRlcmlhbGl6ZSBjdXRvdXRzXCIsIFwiY29uZmxpY3RcIik7XG5cbiAgLy8gUG9saWN5OiBjcm9wLW9ubHkgYnkgZGVmYXVsdDsgLS1yZW1vdmUgZmxpcHMgdG8gcmVtYmcgKGF1dG8pOyAtLWFscGhhIHdpbnMuXG4gIGxldCBhbHBoYTogQWxwaGFQb2xpY3kgPSBmbGFncy5yZW1vdmUgPT09IHRydWUgPyBcImF1dG9cIiA6IFwibm9uZVwiO1xuICBpZiAodHlwZW9mIGZsYWdzLmFscGhhID09PSBcInN0cmluZ1wiKSB7XG4gICAgaWYgKCFbXCJhdXRvXCIsIFwiYWxsXCIsIFwibm9uZVwiXS5pbmNsdWRlcyhmbGFncy5hbHBoYSkpIHtcbiAgICAgIGRpZShgLS1hbHBoYSBtdXN0IGJlIGF1dG98YWxsfG5vbmUgKGdvdCAke2ZsYWdzLmFscGhhfSlgKTtcbiAgICB9XG4gICAgYWxwaGEgPSBmbGFncy5hbHBoYSBhcyBBbHBoYVBvbGljeTtcbiAgfVxuICAvLyBUaGUgdmVyc2lvbiBsYWJlbCA9IHRoZSByZW1vdmFsIE1PREVMOiBcImNyb3BcIiAobm8gcmVtb3ZhbCksIFwicmVtYmdcIiAocmVtYmcnc1xuICAvLyBkZWZhdWx0IHUybmV0KSwgb3IgYSBzcGVjaWZpYyByZW1iZyBtb2RlbCBuYW1lIG9uIGEgcmV0cnkgKC0tbW9kZWwsIGUuZy5cbiAgLy8gaXNuZXQtZ2VuZXJhbC11c2UpLiBFYWNoIGxhYmVsIOKGkiBpdHMgb3duIGZpbGUgKGN1dG91dEZpbGVuYW1lKSBzbyB2ZXJzaW9uc1xuICAvLyBjb2V4aXN0ICsgZG9uJ3QgY2FjaGUtY29sbGlkZTsgYWRkVmVyc2lvbiB1cHNlcnRzIGJ5IHRoaXMgbGFiZWwuXG4gIGNvbnN0IHJlcU1vZGVsID0gdHlwZW9mIGZsYWdzLm1vZGVsID09PSBcInN0cmluZ1wiID8gZmxhZ3MubW9kZWwgOiB1bmRlZmluZWQ7XG4gIC8vIFJvdXRlIGJ5IGlkIFNIQVBFLCBuZXZlciBhIGhhcmRjb2RlZCBtb2RlbCBsaXN0OiBhIG1lZGlhLWZvcmdlIGlkIGlzIGFcbiAgLy8gcHJvdmlkZXIgcGF0aCAoaGFzIFwiL1wiKTsgYSBiYXJlIG5hbWUgaXMgYSByZW1iZyBtb2RlbC4gVGhlIGFnZW50IGRpc2NvdmVyc1xuICAvLyBtZWRpYS1mb3JnZSBiZy1yZW1vdmUgaWRzIHZpYSBgbWVkaWEtZm9yZ2UgbW9kZWxzIGxpc3RgIGFuZCBwYXNzZXMgb25lIGhlcmUuXG4gIGNvbnN0IHVzZU1lZGlhRm9yZ2UgPSByZXFNb2RlbCA/IGlzTWVkaWFGb3JnZU1vZGVsKHJlcU1vZGVsKSA6IGZhbHNlO1xuICBjb25zdCByZW1iZ01vZGVsID0gcmVxTW9kZWwgJiYgIXVzZU1lZGlhRm9yZ2UgPyByZXFNb2RlbCA6IHVuZGVmaW5lZDtcbiAgLy8gVGhlIHZlcnNpb24gbGFiZWwgKGl0cyBzdHJpcCByb3cgKyBmaWxlbmFtZSkuIEZyaWVuZGx5OiBleHBsaWNpdCAtLWxhYmVsIHdpbnM7XG4gIC8vIGVsc2UgZm9yIGEgbWVkaWEtZm9yZ2UgcGF0aCBpZCB1c2UgdGhlIHNlZ21lbnQgYWZ0ZXIgdGhlIHZlbmRvcjsgZWxzZSB0aGVcbiAgLy8gbW9kZWwgbmFtZS4gY3JvcC1vbmx5IGhhcyBubyBtb2RlbC5cbiAgY29uc3QgZXhwbGljaXRMYWJlbCA9IHR5cGVvZiBmbGFncy5sYWJlbCA9PT0gXCJzdHJpbmdcIiA/IGZsYWdzLmxhYmVsIDogdW5kZWZpbmVkO1xuICBjb25zdCBsYWJlbCA9XG4gICAgYWxwaGEgPT09IFwibm9uZVwiXG4gICAgICA/IFwiY3JvcFwiXG4gICAgICA6IChleHBsaWNpdExhYmVsID8/XG4gICAgICAgICh1c2VNZWRpYUZvcmdlID8gKChyZXFNb2RlbCBhcyBzdHJpbmcpLnNwbGl0KFwiL1wiKVsxXSA/PyBcImNsb3VkXCIpIDogKHJlcU1vZGVsID8/IFwicmVtYmdcIikpKTtcbiAgLy8gRGVmYXVsdCBwYWQgPSAwOiB0aGUgc2xpY2UgbXVzdCBtYXRjaCB0aGUgYm94IHRoZSB1c2VyIGRyZXcgKFdZU0lXWUcpLiBUaGUgYm94XG4gIC8vIElTIHRoZSBwYWRkaW5nIGNvbnRyb2wg4oCUIGRyYWcgYSBoYW5kbGUgb3V0IGZvciBicmVhdGhpbmcgcm9vbS4gKHJlbW92ZS5weSdzIG93blxuICAvLyBkZWZhdWx0IGlzIDgsIHNvIHdlIE1VU1QgcGFzcyBhbiBleHBsaWNpdCAwLCBub3QgdW5kZWZpbmVkLikgLS1wYWQgb3ZlcnJpZGVzLlxuICBjb25zdCBwYWQgPSB0eXBlb2YgZmxhZ3MucGFkID09PSBcInN0cmluZ1wiID8gcGFyc2VJbnQoZmxhZ3MucGFkLCAxMCkgOiAwO1xuICBpZiAoTnVtYmVyLmlzTmFOKHBhZCkpIGRpZShcIi0tcGFkIG11c3QgYmUgYSBudW1iZXJcIik7XG4gIGNvbnN0IGlkRmlsdGVyID1cbiAgICB0eXBlb2YgZmxhZ3MuaWRzID09PSBcInN0cmluZ1wiXG4gICAgICA/IG5ldyBTZXQoXG4gICAgICAgICAgZmxhZ3MuaWRzXG4gICAgICAgICAgICAuc3BsaXQoXCIsXCIpXG4gICAgICAgICAgICAubWFwKCh4KSA9PiB4LnRyaW0oKSlcbiAgICAgICAgICAgIC5maWx0ZXIoQm9vbGVhbiksXG4gICAgICAgIClcbiAgICAgIDogdW5kZWZpbmVkO1xuXG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGkocy5wb3J0LCBcIkdFVFwiLCBcIi9zdGF0ZVwiKTtcbiAgaWYgKHN0YXR1cyAhPT0gMjAwKSBkaWUoYHN0YXRlIGZhaWxlZCAoSFRUUCAke3N0YXR1c30pYCwgXCJpbnRlcm5hbFwiKTtcbiAgY29uc3Qgc3QgPSAoZGF0YSBhcyB7IHN0YXRlPzogeyBzb3VyY2U/OiB7IHBhdGg/OiBzdHJpbmcgfTsgZWxlbWVudHM/OiBFbGVtZW50W10gfSB9KS5zdGF0ZTtcbiAgY29uc3Qgc291cmNlUGF0aCA9IHN0Py5zb3VyY2U/LnBhdGg7XG4gIGlmICghc291cmNlUGF0aClcbiAgICBkaWUoXCJubyBzb3VyY2Ugc2V0IOKAlCBkcm9wIGEgY29tcG9zaXRlIChvciBydW46IHNvdXJjZSA8aW1hZ2VQYXRoPikgZmlyc3RcIiwgXCJjb25mbGljdFwiKTtcbiAgbGV0IGVsZW1lbnRzID0gKHN0Py5lbGVtZW50cyA/PyBbXSkuZmlsdGVyKChlKSA9PiBlLnN0YXR1cyAhPT0gXCJkcm9wcGVkXCIpO1xuICBpZiAoaWRGaWx0ZXIpIGVsZW1lbnRzID0gZWxlbWVudHMuZmlsdGVyKChlKSA9PiBpZEZpbHRlci5oYXMoZS5pZCkpO1xuICAvLyBXaGVuIFJFTU9WSU5HLCBuZXZlciB0b3VjaCBhbHBoYS1mb3JiaWRkZW4gdHlwZXMgKHBhbGV0dGUgLyBzY3JlZW5zaG90IC9cbiAgLy8gdHlwb2dyYXBoeSkg4oCUIHRoZXkgc3RheSB3aG9sZSBieSBwb2xpY3kuIFNraXAgdGhlbSBzbyB3ZSBkb24ndCB3cml0ZSBhXG4gIC8vIG1pc2xhYmVsZWQsIHJlZHVuZGFudCBcInJlbW92YWxcIiB2ZXJzaW9uIHRoYXQncyByZWFsbHkganVzdCB0aGUgY3JvcC5cbiAgbGV0IGtlcHRXaG9sZSA9IDA7XG4gIGlmIChhbHBoYSAhPT0gXCJub25lXCIpIHtcbiAgICBjb25zdCBiZWZvcmUgPSBlbGVtZW50cy5sZW5ndGg7XG4gICAgZWxlbWVudHMgPSBlbGVtZW50cy5maWx0ZXIoKGUpID0+IHNob3VsZFJlbW92ZShlLnR5cGUsIGFscGhhKSk7XG4gICAga2VwdFdob2xlID0gYmVmb3JlIC0gZWxlbWVudHMubGVuZ3RoO1xuICB9XG4gIGlmICghZWxlbWVudHMubGVuZ3RoKSB7XG4gICAgZGllKFxuICAgICAga2VwdFdob2xlID4gMFxuICAgICAgICA/IGBub3RoaW5nIHRvIHJlbW92ZSDigJQgJHtrZXB0V2hvbGV9IHNlbGVjdGVkIGVsZW1lbnQke2tlcHRXaG9sZSA9PT0gMSA/IFwiIGlzIGFcIiA6IFwicyBhcmVcIn0ga2VwdC13aG9sZSB0eXBlJHtrZXB0V2hvbGUgPT09IDEgPyBcIlwiIDogXCJzXCJ9IChwYWxldHRlL3NjcmVlbnNob3QvdHlwb2dyYXBoeSlgXG4gICAgICAgIDogaWRGaWx0ZXJcbiAgICAgICAgICA/IFwibm8gbWF0Y2hpbmcgZXh0cmFjdGFibGUgZWxlbWVudHMgZm9yIC0taWRzXCJcbiAgICAgICAgICA6IFwibm8gZXh0cmFjdGFibGUgZWxlbWVudHMgKGFsbCBkcm9wcGVkIG9yIG5vbmUgZGlzY292ZXJlZClcIixcbiAgICApO1xuICB9XG5cbiAgYXdhaXQgYXBpKHMucG9ydCwgXCJQT1NUXCIsIFwiL2NtZFwiLCB7IHR5cGU6IFwic3RhdHVzXCIsIGJ1c3k6IHRydWUsIHRleHQ6IFwiZXh0cmFjdGluZ+KAplwiIH0pO1xuICBsZXQgZG9uZSA9IDA7XG4gIGxldCBmYWlsZWQgPSAwO1xuICB0cnkge1xuICAgIGZvciAoY29uc3QgZWwgb2YgZWxlbWVudHMpIHtcbiAgICAgIGNvbnN0IG91dFBhdGggPSBqb2luKHMuZmlsZXNfZGlyLCBjdXRvdXRGaWxlbmFtZShlbC5uYW1lLCBsYWJlbCkpO1xuICAgICAgdHJ5IHtcbiAgICAgICAgLy8gQ2xvdWQgKG1lZGlhLWZvcmdlKSBydW5zIG9uIHRoZSBlbGVtZW50J3MgZXhpc3RpbmcgY3JvcCBpbWFnZSAoc2luZ2xlLVxuICAgICAgICAvLyBpbWFnZSB0cmFuc2Zvcm0pOyByZW1iZyBjcm9wcyB0aGUgYmJveCBmcm9tIHRoZSBzb3VyY2UgaXRzZWxmLlxuICAgICAgICBjb25zdCBjdXRvdXQgPSB1c2VNZWRpYUZvcmdlXG4gICAgICAgICAgPyBhd2FpdCBtZWRpYUZvcmdlQmFja2VuZC5jdXQoXG4gICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBzb3VyY2VQYXRoOiBqb2luKHMuZmlsZXNfZGlyLCBjdXRvdXRGaWxlbmFtZShlbC5uYW1lLCBcImNyb3BcIikpLFxuICAgICAgICAgICAgICAgIGJib3g6IGVsLmJib3gsXG4gICAgICAgICAgICAgICAgdHlwZTogZWwudHlwZSxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgb3V0UGF0aCxcbiAgICAgICAgICAgICAgeyBtb2RlbDogcmVxTW9kZWwgfSxcbiAgICAgICAgICAgIClcbiAgICAgICAgICA6IGF3YWl0IHJlbWJnQmFja2VuZC5jdXQoeyBzb3VyY2VQYXRoLCBiYm94OiBlbC5iYm94LCB0eXBlOiBlbC50eXBlIH0sIG91dFBhdGgsIHtcbiAgICAgICAgICAgICAgYWxwaGEsXG4gICAgICAgICAgICAgIHBhZCxcbiAgICAgICAgICAgICAgbW9kZWw6IHJlbWJnTW9kZWwsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgYXdhaXQgYXBpKHMucG9ydCwgXCJQT1NUXCIsIFwiL2NtZFwiLCB7XG4gICAgICAgICAgdHlwZTogXCJlbGVtZW50LmFkZFZlcnNpb25cIixcbiAgICAgICAgICBpZDogZWwuaWQsXG4gICAgICAgICAgLy8gYWRkVmVyc2lvbiB1cHNlcnRzIGJ5IG1vZGVsIChidW1wcyByZXYg4oaSIGNhY2hlLWJ1c3QpIGFuZCBjbGVhcnMgdGhlXG4gICAgICAgICAgLy8gZmxhZzsgY3JvcCA9IHJhdywgcmVtYmcgbW9kZWwgPSBsb2NhbCwgbWVkaWEtZm9yZ2UgPSBjbG91ZC5cbiAgICAgICAgICB2ZXJzaW9uOiB7XG4gICAgICAgICAgICBpZDogbmV3SWQoXCJ2XCIpLFxuICAgICAgICAgICAgbW9kZWw6IGxhYmVsLCAvLyBcImNyb3BcIiB8IFwicmVtYmdcIiB8IDxyZW1iZyBtb2RlbD4gfCA8bWVkaWEtZm9yZ2UgbGFiZWw+XG4gICAgICAgICAgICBraW5kOiBsYWJlbCA9PT0gXCJjcm9wXCIgPyBcInJhd1wiIDogdXNlTWVkaWFGb3JnZSA/IFwiY2xvdWRcIiA6IFwibG9jYWxcIixcbiAgICAgICAgICAgIHBhdGg6IGN1dG91dC5wYXRoLFxuICAgICAgICAgICAgcmV2OiAwLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgY2hvb3NlOiB0cnVlLFxuICAgICAgICB9KTtcbiAgICAgICAgZG9uZSsrO1xuICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgbWFncGllOiBjdXQgJHtlbC5uYW1lfSAoJHtlbC50eXBlfSwgJHtsYWJlbH0pIOKGkiAke2N1dG91dC5wYXRofVxcbmApO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBmYWlsZWQrKztcbiAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICAgYG1hZ3BpZTogY3V0IEZBSUxFRCBmb3IgJHtlbC5uYW1lfTogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9XFxuYCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG4gIH0gZmluYWxseSB7XG4gICAgYXdhaXQgYXBpKHMucG9ydCwgXCJQT1NUXCIsIFwiL2NtZFwiLCB7IHR5cGU6IFwic3RhdHVzXCIsIGJ1c3k6IGZhbHNlIH0pO1xuICB9XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBjdXQ6IGRvbmUsIGZhaWxlZCwgdG90YWw6IGVsZW1lbnRzLmxlbmd0aCwga2VwdFdob2xlLCBtb2RlbDogbGFiZWwgfSk7XG59XG5cbmZ1bmN0aW9uIGVzY2FwZUh0bWwoczogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHMucmVwbGFjZShcbiAgICAvWyY8PlwiXS9nLFxuICAgIChjKSA9PiAoeyBcIiZcIjogXCImYW1wO1wiLCBcIjxcIjogXCImbHQ7XCIsIFwiPlwiOiBcIiZndDtcIiwgJ1wiJzogXCImcXVvdDtcIiB9KVtjXSBhcyBzdHJpbmcsXG4gICk7XG59XG5cbnR5cGUgTWFuaWZlc3RBc3NldCA9IHtcbiAgbmFtZTogc3RyaW5nO1xuICB0eXBlOiBzdHJpbmc7XG4gIG1vZGVsOiBzdHJpbmc7XG4gIGtpbmQ6IHN0cmluZyB8IG51bGw7XG4gIGJib3g6IG51bWJlcltdO1xuICBmaWxlOiBzdHJpbmc7XG4gIGNyb3A6IHN0cmluZyB8IG51bGw7XG59O1xuXG4vLyBBIHNlbGYtY29udGFpbmVkIGNvbnRhY3Qgc2hlZXQgKG1hZ3BpZSBjcmVhbSBpZGVudGl0eSkg4oCUIG9wZW4gaW4gYSBicm93c2VyLCBub1xuLy8gZGVwcy4gQmFja2Ryb3AgdG9nZ2xlIChjaGVja2VyL3doaXRlL2dyYXkvYmxhY2spIHRvIGp1ZGdlIHRyYW5zcGFyZW5jeSwgYW5kXG4vLyB0eXBlIGZpbHRlcnMgYnVpbHQgZnJvbSB0aGUgdGF4b25vbXkgd2UgdGFnZ2VkIGR1cmluZyB0aGUgcnVuLiBgYS5maWxlYCBpcyB0aGVcbi8vIGluLXppcCBwYXRoIChhc3NldHMvPG5hbWU+LnBuZykuXG5mdW5jdGlvbiBidWlsZEdhbGxlcnlIdG1sKHRpdGxlOiBzdHJpbmcsIGFzc2V0czogTWFuaWZlc3RBc3NldFtdKTogc3RyaW5nIHtcbiAgY29uc3QgdHlwZXMgPSBbLi4ubmV3IFNldChhc3NldHMubWFwKChhKSA9PiBhLnR5cGUpKV0uc29ydCgpO1xuICBjb25zdCB0eXBlQ2hpcHMgPSBbXCJhbGxcIiwgLi4udHlwZXNdXG4gICAgLm1hcCgodCkgPT4ge1xuICAgICAgY29uc3QgbiA9IHQgPT09IFwiYWxsXCIgPyBhc3NldHMubGVuZ3RoIDogYXNzZXRzLmZpbHRlcigoYSkgPT4gYS50eXBlID09PSB0KS5sZW5ndGg7XG4gICAgICByZXR1cm4gYDxidXR0b24gY2xhc3M9XCJjaGlwJHt0ID09PSBcImFsbFwiID8gXCIgYWN0aXZlXCIgOiBcIlwifVwiIGRhdGEtZmlsdGVyPVwiJHtlc2NhcGVIdG1sKHQpfVwiPiR7ZXNjYXBlSHRtbCh0KX0gPHNwYW4gY2xhc3M9XCJuXCI+JHtufTwvc3Bhbj48L2J1dHRvbj5gO1xuICAgIH0pXG4gICAgLmpvaW4oXCJcIik7XG4gIGNvbnN0IGNhcmRzID0gYXNzZXRzXG4gICAgLm1hcChcbiAgICAgIChhKSA9PiBgICAgICAgPGZpZ3VyZSBjbGFzcz1cImNhcmRcIiBkYXRhLXR5cGU9XCIke2VzY2FwZUh0bWwoYS50eXBlKX1cIj5cbiAgICAgICAgPGRpdiBjbGFzcz1cInRodW1iXCI+PGltZyBzcmM9XCIke2VzY2FwZUh0bWwoYS5maWxlKX1cIiBhbHQ9XCIke2VzY2FwZUh0bWwoYS5uYW1lKX1cIj48L2Rpdj5cbiAgICAgICAgPGZpZ2NhcHRpb24+XG4gICAgICAgICAgPHNwYW4gY2xhc3M9XCJuYW1lXCI+JHtlc2NhcGVIdG1sKGEubmFtZSl9PC9zcGFuPlxuICAgICAgICAgIDxzcGFuIGNsYXNzPVwibWV0YVwiPiR7ZXNjYXBlSHRtbChhLnR5cGUpfSDCtyAke2VzY2FwZUh0bWwoYS5tb2RlbCl9JHthLmtpbmQgPyBgICgke2VzY2FwZUh0bWwoYS5raW5kKX0pYCA6IFwiXCJ9PC9zcGFuPlxuICAgICAgICA8L2ZpZ2NhcHRpb24+XG4gICAgICA8L2ZpZ3VyZT5gLFxuICAgIClcbiAgICAuam9pbihcIlxcblwiKTtcbiAgcmV0dXJuIGA8IWRvY3R5cGUgaHRtbD5cbjxodG1sIGxhbmc9XCJlblwiPjxoZWFkPjxtZXRhIGNoYXJzZXQ9XCJ1dGYtOFwiPlxuPHRpdGxlPiR7ZXNjYXBlSHRtbCh0aXRsZSl9IOKAlCBtYWdwaWUgYXNzZXRzPC90aXRsZT5cbjxzdHlsZT5cbiAgOnJvb3QgeyAtLWNyZWFtOiNmNmYxZTc7IC0taW5rOiMxNDE4MWI7IC0tbGluZTojZTJkOWM2OyAtLWluZGlnbzojNWI1YmYwOyB9XG4gIGJvZHkgeyBmb250LWZhbWlseTotYXBwbGUtc3lzdGVtLHN5c3RlbS11aSxzYW5zLXNlcmlmOyBiYWNrZ3JvdW5kOnZhcigtLWNyZWFtKTsgY29sb3I6dmFyKC0taW5rKTsgbWFyZ2luOjA7IHBhZGRpbmc6MjhweDsgfVxuICBoMSB7IGZvbnQtc2l6ZToyMHB4OyBmb250LXdlaWdodDo3MDA7IG1hcmdpbjowOyB9IC5jb3VudCB7IGNvbG9yOiM5YThmNzg7IGZvbnQtd2VpZ2h0OjQwMDsgfVxuICAudG9vbGJhciB7IGRpc3BsYXk6ZmxleDsgZ2FwOjE4cHg7IGFsaWduLWl0ZW1zOmNlbnRlcjsgZmxleC13cmFwOndyYXA7IG1hcmdpbjoxNnB4IDAgNHB4OyB9XG4gIC5ncm91cCB7IGRpc3BsYXk6ZmxleDsgZ2FwOjZweDsgYWxpZ24taXRlbXM6Y2VudGVyOyB9XG4gIC5sYWJlbCB7IGZvbnQtc2l6ZToxMXB4OyBjb2xvcjojOWE4Zjc4OyB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7IGxldHRlci1zcGFjaW5nOi4wNGVtOyB9XG4gIC8qIGJhY2tkcm9wID0gY29sb3Igc3dhdGNoZXMgKG5vdCB3b3Jkcyk7IHRyYW5zcGFyZW50ID0gYSBtaW5pIGNoZWNrZXIgc3F1YXJlICovXG4gIC5zdyB7IHdpZHRoOjIycHg7IGhlaWdodDoyMnB4OyBwYWRkaW5nOjA7IGJvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7IGJvcmRlci1yYWRpdXM6NXB4OyBjdXJzb3I6cG9pbnRlcjsgYm94LXNpemluZzpib3JkZXItYm94OyB9XG4gIC5zdy5hY3RpdmUgeyBvdXRsaW5lOjJweCBzb2xpZCB2YXIoLS1pbmRpZ28pOyBvdXRsaW5lLW9mZnNldDoxcHg7IH1cbiAgLnN3LmNoZWNrZXIgeyBiYWNrZ3JvdW5kLWNvbG9yOiNmZmY7XG4gICAgYmFja2dyb3VuZC1pbWFnZTpsaW5lYXItZ3JhZGllbnQoNDVkZWcsI2M5YzljOSAyNSUsdHJhbnNwYXJlbnQgMjUlKSxsaW5lYXItZ3JhZGllbnQoLTQ1ZGVnLCNjOWM5YzkgMjUlLHRyYW5zcGFyZW50IDI1JSksbGluZWFyLWdyYWRpZW50KDQ1ZGVnLHRyYW5zcGFyZW50IDc1JSwjYzljOWM5IDc1JSksbGluZWFyLWdyYWRpZW50KC00NWRlZyx0cmFuc3BhcmVudCA3NSUsI2M5YzljOSA3NSUpO1xuICAgIGJhY2tncm91bmQtc2l6ZTo4cHggOHB4OyBiYWNrZ3JvdW5kLXBvc2l0aW9uOjAgMCwwIDRweCw0cHggLTRweCwtNHB4IDA7IH1cbiAgLyogc2l6ZSA9IGEgc21hbGwgUy9NL0wgc2VnbWVudGVkIGNvbnRyb2wgKi9cbiAgLnNlZyB7IGZvbnQ6aW5oZXJpdDsgZm9udC1zaXplOjEycHg7IHBhZGRpbmc6NHB4IDlweDsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTsgYmFja2dyb3VuZDojZmZmZGY4OyBjb2xvcjp2YXIoLS1pbmspOyBjdXJzb3I6cG9pbnRlcjsgfVxuICAuc2VnOmZpcnN0LWNoaWxkIHsgYm9yZGVyLXJhZGl1czo2cHggMCAwIDZweDsgfSAuc2VnOmxhc3QtY2hpbGQgeyBib3JkZXItcmFkaXVzOjAgNnB4IDZweCAwOyB9IC5zZWcrLnNlZyB7IGJvcmRlci1sZWZ0Om5vbmU7IH1cbiAgLnNlZy5hY3RpdmUgeyBiYWNrZ3JvdW5kOnZhcigtLWluZGlnbyk7IGNvbG9yOiNmZmY7IGJvcmRlci1jb2xvcjp2YXIoLS1pbmRpZ28pOyB9XG4gIC5jaGlwIHsgZm9udDppbmhlcml0OyBmb250LXNpemU6MTJweDsgcGFkZGluZzo0cHggMTBweDsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTsgYm9yZGVyLXJhZGl1czo5OTlweDsgYmFja2dyb3VuZDojZmZmZGY4OyBjb2xvcjp2YXIoLS1pbmspOyBjdXJzb3I6cG9pbnRlcjsgfVxuICAuY2hpcC5hY3RpdmUgeyBiYWNrZ3JvdW5kOnZhcigtLWluZGlnbyk7IGNvbG9yOiNmZmY7IGJvcmRlci1jb2xvcjp2YXIoLS1pbmRpZ28pOyB9XG4gIC5jaGlwIC5uIHsgb3BhY2l0eTouNjsgbWFyZ2luLWxlZnQ6MnB4OyB9XG4gIC5ncmlkIHsgZGlzcGxheTpncmlkOyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KGF1dG8tZmlsbCxtaW5tYXgoMTcwcHgsMWZyKSk7IGdhcDoxMHB4OyBtYXJnaW4tdG9wOjE2cHg7IH1cbiAgYm9keVtkYXRhLXNpemU9XCJzbVwiXSAuZ3JpZCB7IGdyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoYXV0by1maWxsLG1pbm1heCgxMzJweCwxZnIpKTsgfVxuICBib2R5W2RhdGEtc2l6ZT1cImxnXCJdIC5ncmlkIHsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdChhdXRvLWZpbGwsbWlubWF4KDI2NHB4LDFmcikpOyBnYXA6MTRweDsgfVxuICAuY2FyZCB7IGJhY2tncm91bmQ6I2ZmZmRmODsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTsgYm9yZGVyLXJhZGl1czoxMHB4OyBvdmVyZmxvdzpoaWRkZW47IG1pbi13aWR0aDowOyB9XG4gIC50aHVtYiB7IGhlaWdodDoxNjBweDsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGp1c3RpZnktY29udGVudDpjZW50ZXI7IGJhY2tncm91bmQtY29sb3I6I2ZmZjtcbiAgICBiYWNrZ3JvdW5kLWltYWdlOmxpbmVhci1ncmFkaWVudCg0NWRlZywjZTdlMGQyIDI1JSx0cmFuc3BhcmVudCAyNSUpLGxpbmVhci1ncmFkaWVudCgtNDVkZWcsI2U3ZTBkMiAyNSUsdHJhbnNwYXJlbnQgMjUlKSxsaW5lYXItZ3JhZGllbnQoNDVkZWcsdHJhbnNwYXJlbnQgNzUlLCNlN2UwZDIgNzUlKSxsaW5lYXItZ3JhZGllbnQoLTQ1ZGVnLHRyYW5zcGFyZW50IDc1JSwjZTdlMGQyIDc1JSk7XG4gICAgYmFja2dyb3VuZC1zaXplOjE2cHggMTZweDsgYmFja2dyb3VuZC1wb3NpdGlvbjowIDAsMCA4cHgsOHB4IC04cHgsLThweCAwOyB9XG4gIGJvZHlbZGF0YS1zaXplPVwic21cIl0gLnRodW1iIHsgaGVpZ2h0OjExMnB4OyB9IGJvZHlbZGF0YS1zaXplPVwibGdcIl0gLnRodW1iIHsgaGVpZ2h0OjI0MHB4OyB9XG4gIGJvZHlbZGF0YS1iZz1cIndoaXRlXCJdIC50aHVtYiB7IGJhY2tncm91bmQ6I2ZmZiFpbXBvcnRhbnQ7IGJhY2tncm91bmQtaW1hZ2U6bm9uZSFpbXBvcnRhbnQ7IH1cbiAgYm9keVtkYXRhLWJnPVwiZ3JheVwiXSAudGh1bWIgeyBiYWNrZ3JvdW5kOiM4YThhOGEhaW1wb3J0YW50OyBiYWNrZ3JvdW5kLWltYWdlOm5vbmUhaW1wb3J0YW50OyB9XG4gIGJvZHlbZGF0YS1iZz1cImJsYWNrXCJdIC50aHVtYiB7IGJhY2tncm91bmQ6IzExMSFpbXBvcnRhbnQ7IGJhY2tncm91bmQtaW1hZ2U6bm9uZSFpbXBvcnRhbnQ7IH1cbiAgLnRodW1iIGltZyB7IG1heC13aWR0aDo4OCU7IG1heC1oZWlnaHQ6ODglOyBvYmplY3QtZml0OmNvbnRhaW47IH1cbiAgZmlnY2FwdGlvbiB7IHBhZGRpbmc6N3B4IDlweDsgZGlzcGxheTpmbGV4OyBmbGV4LWRpcmVjdGlvbjpjb2x1bW47IGdhcDoxcHg7IG1pbi13aWR0aDowOyB9XG4gIC5uYW1lLCAubWV0YSB7IHdoaXRlLXNwYWNlOm5vd3JhcDsgb3ZlcmZsb3c6aGlkZGVuOyB0ZXh0LW92ZXJmbG93OmVsbGlwc2lzOyB9XG4gIC5uYW1lIHsgZm9udC1zaXplOjEyLjVweDsgZm9udC13ZWlnaHQ6NjAwOyB9IC5tZXRhIHsgZm9udC1zaXplOjExcHg7IGNvbG9yOiM2ZjZjNjY7IH1cbjwvc3R5bGU+PC9oZWFkPjxib2R5IGRhdGEtYmc9XCJjaGVja2VyXCIgZGF0YS1zaXplPVwibWRcIj5cbiAgPGgxPvCfkKYgJHtlc2NhcGVIdG1sKHRpdGxlKX0gPHNwYW4gY2xhc3M9XCJjb3VudFwiPuKAlCAke2Fzc2V0cy5sZW5ndGh9IGFzc2V0JHthc3NldHMubGVuZ3RoID09PSAxID8gXCJcIiA6IFwic1wifTwvc3Bhbj48L2gxPlxuICA8ZGl2IGNsYXNzPVwidG9vbGJhclwiPlxuICAgIDxkaXYgY2xhc3M9XCJncm91cFwiPjxzcGFuIGNsYXNzPVwibGFiZWxcIj5CYWNrZHJvcDwvc3Bhbj5cbiAgICAgIDxidXR0b24gY2xhc3M9XCJzdyBjaGVja2VyIGFjdGl2ZVwiIGRhdGEtYmctYnRuPVwiY2hlY2tlclwiIHRpdGxlPVwiVHJhbnNwYXJlbnRcIj48L2J1dHRvbj5cbiAgICAgIDxidXR0b24gY2xhc3M9XCJzd1wiIGRhdGEtYmctYnRuPVwid2hpdGVcIiBzdHlsZT1cImJhY2tncm91bmQ6I2ZmZmZmZlwiIHRpdGxlPVwiV2hpdGVcIj48L2J1dHRvbj5cbiAgICAgIDxidXR0b24gY2xhc3M9XCJzd1wiIGRhdGEtYmctYnRuPVwiZ3JheVwiIHN0eWxlPVwiYmFja2dyb3VuZDojOGE4YThhXCIgdGl0bGU9XCJHcmF5XCI+PC9idXR0b24+XG4gICAgICA8YnV0dG9uIGNsYXNzPVwic3dcIiBkYXRhLWJnLWJ0bj1cImJsYWNrXCIgc3R5bGU9XCJiYWNrZ3JvdW5kOiMxMTExMTFcIiB0aXRsZT1cIkJsYWNrXCI+PC9idXR0b24+XG4gICAgPC9kaXY+XG4gICAgPGRpdiBjbGFzcz1cImdyb3VwXCI+PHNwYW4gY2xhc3M9XCJsYWJlbFwiPlNpemU8L3NwYW4+XG4gICAgICA8YnV0dG9uIGNsYXNzPVwic2VnXCIgZGF0YS1zaXplLWJ0bj1cInNtXCIgdGl0bGU9XCJTbWFsbFwiPlM8L2J1dHRvbj5cbiAgICAgIDxidXR0b24gY2xhc3M9XCJzZWcgYWN0aXZlXCIgZGF0YS1zaXplLWJ0bj1cIm1kXCIgdGl0bGU9XCJNZWRpdW1cIj5NPC9idXR0b24+XG4gICAgICA8YnV0dG9uIGNsYXNzPVwic2VnXCIgZGF0YS1zaXplLWJ0bj1cImxnXCIgdGl0bGU9XCJMYXJnZVwiPkw8L2J1dHRvbj5cbiAgICA8L2Rpdj5cbiAgICA8ZGl2IGNsYXNzPVwiZ3JvdXBcIj48c3BhbiBjbGFzcz1cImxhYmVsXCI+VHlwZTwvc3Bhbj4ke3R5cGVDaGlwc308L2Rpdj5cbiAgPC9kaXY+XG4gIDxkaXYgY2xhc3M9XCJncmlkXCI+XG4ke2NhcmRzfVxuICA8L2Rpdj5cbiAgPHNjcmlwdD5cbiAgICB2YXIgYm9keT1kb2N1bWVudC5ib2R5O1xuICAgIGZ1bmN0aW9uIHdpcmUoc2VsLCBhcHBseSl7IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoc2VsKS5mb3JFYWNoKGZ1bmN0aW9uKGIpeyBiLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgZnVuY3Rpb24oKXtcbiAgICAgIGFwcGx5KGIpO1xuICAgICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbChzZWwpLmZvckVhY2goZnVuY3Rpb24oeCl7IHguY2xhc3NMaXN0LnRvZ2dsZSgnYWN0aXZlJywgeD09PWIpOyB9KTtcbiAgICB9KTsgfSk7IH1cbiAgICB3aXJlKCdbZGF0YS1iZy1idG5dJywgZnVuY3Rpb24oYil7IGJvZHkuZGF0YXNldC5iZz1iLmRhdGFzZXQuYmdCdG47IH0pO1xuICAgIHdpcmUoJ1tkYXRhLXNpemUtYnRuXScsIGZ1bmN0aW9uKGIpeyBib2R5LmRhdGFzZXQuc2l6ZT1iLmRhdGFzZXQuc2l6ZUJ0bjsgfSk7XG4gICAgdmFyIGNhcmRzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNhcmQnKSk7XG4gICAgd2lyZSgnW2RhdGEtZmlsdGVyXScsIGZ1bmN0aW9uKGIpeyB2YXIgdD1iLmRhdGFzZXQuZmlsdGVyO1xuICAgICAgY2FyZHMuZm9yRWFjaChmdW5jdGlvbihjKXsgYy5zdHlsZS5kaXNwbGF5PSh0PT09J2FsbCd8fGMuZGF0YXNldC50eXBlPT09dCk/Jyc6J25vbmUnOyB9KTsgfSk7XG4gIDwvc2NyaXB0PlxuPC9ib2R5PjwvaHRtbD5cbmA7XG59XG5cbi8vIGBleHBvcnQgWy0taWRzIGEsYl1gIOKAlCBidWlsZCB0aGUgZG93bmxvYWRhYmxlIGFzc2V0IGJ1bmRsZSBmcm9tIGVhY2ggZWxlbWVudCdzXG4vLyBDSE9TRU4gdmVyc2lvbjogc3RhZ2UgY2xlYW4tbmFtZWQgUE5HcyAoKyB0aGUgcmF3IGNyb3Agd2hlbiB0aGUgY2hvc2VuIGlzIGFcbi8vIHJlbW92YWwpICsgbWFuaWZlc3QuanNvbiArIGdhbGxlcnkuaHRtbCwgemlwIGludG8gdGhlIHNlc3Npb24gZmlsZXMgZGlyLCBhbmRcbi8vIHBvc3QgYnVuZGxlLnNldCBzbyB0aGUgc3VyZmFjZSBvZmZlcnMgaXQgdmlhIC9hc3NldHMvPG5hbWU+LiBSZXNvbHZlcyB2ZXJzaW9uXG4vLyBmaWxlcyBieSBCQVNFTkFNRSBpbiBmaWxlc19kaXIgKHJvYnVzdCB0byBzdGFsZSBhYnNvbHV0ZSBwYXRocyBhZnRlciBhIHJlc3RvcmUpLlxuYXN5bmMgZnVuY3Rpb24gY21kRXhwb3J0KHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCwgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KSB7XG4gIGNvbnN0IHMgPSByZXF1aXJlU2Vzc2lvbihzZXNzaW9uKTtcbiAgaWYgKCFzLmZpbGVzX2RpcikgZGllKFwic2Vzc2lvbiBoYXMgbm8gZmlsZXNfZGlyIOKAlCBjYW5ub3QgYnVpbGQgYSBidW5kbGVcIiwgXCJjb25mbGljdFwiKTtcbiAgY29uc3QgaWRGaWx0ZXIgPVxuICAgIHR5cGVvZiBmbGFncy5pZHMgPT09IFwic3RyaW5nXCJcbiAgICAgID8gbmV3IFNldChcbiAgICAgICAgICBmbGFncy5pZHNcbiAgICAgICAgICAgIC5zcGxpdChcIixcIilcbiAgICAgICAgICAgIC5tYXAoKHgpID0+IHgudHJpbSgpKVxuICAgICAgICAgICAgLmZpbHRlcihCb29sZWFuKSxcbiAgICAgICAgKVxuICAgICAgOiB1bmRlZmluZWQ7XG5cbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaShzLnBvcnQsIFwiR0VUXCIsIFwiL3N0YXRlXCIpO1xuICBpZiAoc3RhdHVzICE9PSAyMDApIGRpZShgc3RhdGUgZmFpbGVkIChIVFRQICR7c3RhdHVzfSlgLCBcImludGVybmFsXCIpO1xuICBjb25zdCBzdCA9IChkYXRhIGFzIHsgc3RhdGU/OiB7IHRpdGxlPzogc3RyaW5nOyBlbGVtZW50cz86IEVsZW1lbnRbXSB9IH0pLnN0YXRlO1xuICBsZXQgZWxlbWVudHMgPSAoc3Q/LmVsZW1lbnRzID8/IFtdKS5maWx0ZXIoKGUpID0+IGUuc3RhdHVzICE9PSBcImRyb3BwZWRcIik7XG4gIGlmIChpZEZpbHRlcikgZWxlbWVudHMgPSBlbGVtZW50cy5maWx0ZXIoKGUpID0+IGlkRmlsdGVyLmhhcyhlLmlkKSk7XG4gIGlmICghZWxlbWVudHMubGVuZ3RoKVxuICAgIGRpZShpZEZpbHRlciA/IFwibm8gbWF0Y2hpbmcgZWxlbWVudHMgZm9yIC0taWRzXCIgOiBcIm5vIGFzc2V0cyB0byBleHBvcnRcIiwgXCJjb25mbGljdFwiKTtcbiAgY29uc3QgdGl0bGUgPSBzdD8udGl0bGUgPz8gXCJtYWdwaWVcIjtcblxuICBjb25zdCBzdGFnZURpciA9IGpvaW4ocy5maWxlc19kaXIsIFwiYnVuZGxlLXN0YWdlXCIpO1xuICBjb25zdCB6aXBOYW1lID0gXCJtYWdwaWUtYnVuZGxlLnppcFwiO1xuICBsZXQgcmVzdWx0OiB7IGNvdW50OiBudW1iZXIgfSB8IG51bGwgPSBudWxsO1xuICBsZXQgZmFpbHVyZTogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIC8vIFRoZSBgZXhwb3J0YCBpbXBlcmF0aXZlIHNldCBzdGF0dXMuYnVzeSBvbiByZWNlaXB0OyBjbGVhciBpdCAoYW5kIGNsZWFuIHRoZVxuICAvLyBzdGFnZSBkaXIpIG9uIEVWRVJZIGV4aXQgcGF0aCDigJQgb3RoZXJ3aXNlIHRoZSBFeHBvcnQgb3ZlcmxheSBzdGlja3MuXG4gIHRyeSB7XG4gICAgcm1TeW5jKHN0YWdlRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgLy8gRm9sZGVyaXplOiBmaW5hbCBjaG9zZW4gYXNzZXRzIHVuZGVyIGFzc2V0cy8sIHJhdyBjcm9wcyB1bmRlciBjcm9wcy8g4oCUIHNvIGFcbiAgICAvLyB3aG9sZSBmb2xkZXIgY2FuIGJlIGdyYWJiZWQgd2l0aG91dCBwYXJzaW5nIG1peGVkIGZpbGVzLiBjcm9wcy8gaXMgY3JlYXRlZFxuICAgIC8vIGxhemlseSAob25seSBpZiBzb21lIGl0ZW0gaGFzIGEgc2VwYXJhdGUgcmF3IGNyb3ApLlxuICAgIGNvbnN0IGFzc2V0c0RpciA9IGpvaW4oc3RhZ2VEaXIsIFwiYXNzZXRzXCIpO1xuICAgIGNvbnN0IGNyb3BzRGlyID0gam9pbihzdGFnZURpciwgXCJjcm9wc1wiKTtcbiAgICBta2RpclN5bmMoYXNzZXRzRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAgIGNvbnN0IG1hbmlmZXN0OiBNYW5pZmVzdEFzc2V0W10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGVsIG9mIGVsZW1lbnRzKSB7XG4gICAgICBjb25zdCBjaG9zZW4gPSBjaG9zZW5WZXJzaW9uKGVsKTtcbiAgICAgIGlmICghY2hvc2VuKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IGNob3NlbkZpbGUgPSBqb2luKHMuZmlsZXNfZGlyLCBiYXNlbmFtZShjaG9zZW4ucGF0aCkpO1xuICAgICAgaWYgKCFleGlzdHNTeW5jKGNob3NlbkZpbGUpKSB7XG4gICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBtYWdwaWUgZXhwb3J0OiBtaXNzaW5nIGZpbGUgZm9yICR7ZWwubmFtZX0gKCR7Y2hvc2VuLm1vZGVsfSlcXG5gKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBjb25zdCBmaWxlQmFzZSA9IGAke3Nhbml0aXplKGVsLm5hbWUpfS5wbmdgO1xuICAgICAgY29weUZpbGVTeW5jKGNob3NlbkZpbGUsIGpvaW4oYXNzZXRzRGlyLCBmaWxlQmFzZSkpO1xuICAgICAgLy8gdGhlIHJhdyBjcm9wIHRvbywgYnV0IG9ubHkgd2hlbiB0aGUgY2hvc2VuIGlzIGEgcmVtb3ZhbCAoZWxzZSBpdCdzIHRoZVxuICAgICAgLy8gc2FtZSBpbWFnZSBhcyB0aGUgYXNzZXQpLiBTYW1lIGJhc2UgbmFtZSwgaW4gY3JvcHMvLlxuICAgICAgbGV0IGNyb3BQYXRoOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICAgIGlmIChjaG9zZW4ubW9kZWwgIT09IFwiY3JvcFwiKSB7XG4gICAgICAgIGNvbnN0IGNyb3BGaWxlID0gam9pbihzLmZpbGVzX2RpciwgY3V0b3V0RmlsZW5hbWUoZWwubmFtZSwgXCJjcm9wXCIpKTtcbiAgICAgICAgaWYgKGV4aXN0c1N5bmMoY3JvcEZpbGUpKSB7XG4gICAgICAgICAgbWtkaXJTeW5jKGNyb3BzRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgICAgICBjb3B5RmlsZVN5bmMoY3JvcEZpbGUsIGpvaW4oY3JvcHNEaXIsIGZpbGVCYXNlKSk7XG4gICAgICAgICAgY3JvcFBhdGggPSBgY3JvcHMvJHtmaWxlQmFzZX1gO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBtYW5pZmVzdC5wdXNoKHtcbiAgICAgICAgbmFtZTogZWwubmFtZSxcbiAgICAgICAgdHlwZTogZWwudHlwZSxcbiAgICAgICAgbW9kZWw6IGNob3Nlbi5tb2RlbCxcbiAgICAgICAga2luZDogY2hvc2VuLmtpbmQgPz8gbnVsbCxcbiAgICAgICAgYmJveDogZWwuYmJveCxcbiAgICAgICAgZmlsZTogYGFzc2V0cy8ke2ZpbGVCYXNlfWAsXG4gICAgICAgIGNyb3A6IGNyb3BQYXRoLFxuICAgICAgfSk7XG4gICAgfVxuICAgIGlmICghbWFuaWZlc3QubGVuZ3RoKSB0aHJvdyBuZXcgRXJyb3IoXCJubyBjaG9zZW4gYXNzZXRzIGZvdW5kIHRvIGV4cG9ydCAoZmlsZXMgbWlzc2luZz8pXCIpO1xuXG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4oc3RhZ2VEaXIsIFwibWFuaWZlc3QuanNvblwiKSxcbiAgICAgIEpTT04uc3RyaW5naWZ5KHsgdGl0bGUsIGNvdW50OiBtYW5pZmVzdC5sZW5ndGgsIGFzc2V0czogbWFuaWZlc3QgfSwgbnVsbCwgMiksXG4gICAgKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oc3RhZ2VEaXIsIFwiZ2FsbGVyeS5odG1sXCIpLCBidWlsZEdhbGxlcnlIdG1sKHRpdGxlLCBtYW5pZmVzdCkpO1xuXG4gICAgLy8gemlwIGludG8gZmlsZXNfZGlyIChvdXRzaWRlIHRoZSBzdGFnZSBzbyB0aGUgYXJjaGl2ZSBpc24ndCBzZWxmLWluY2x1ZGVkKS5cbiAgICBjb25zdCB6aXBQYXRoID0gam9pbihzLmZpbGVzX2RpciwgemlwTmFtZSk7XG4gICAgcm1TeW5jKHppcFBhdGgsIHsgZm9yY2U6IHRydWUgfSk7XG4gICAgY29uc3QgcHJvYyA9IEJ1bi5zcGF3bihbXCJ6aXBcIiwgXCItclwiLCBcIi1xXCIsIHppcFBhdGgsIFwiLlwiXSwge1xuICAgICAgY3dkOiBzdGFnZURpcixcbiAgICAgIHN0ZG91dDogXCJwaXBlXCIsXG4gICAgICBzdGRlcnI6IFwicGlwZVwiLFxuICAgIH0pO1xuICAgIGNvbnN0IFt6ZXJyLCB6Y29kZV0gPSBhd2FpdCBQcm9taXNlLmFsbChbbmV3IFJlc3BvbnNlKHByb2Muc3RkZXJyKS50ZXh0KCksIHByb2MuZXhpdGVkXSk7XG4gICAgaWYgKHpjb2RlICE9PSAwKSB0aHJvdyBuZXcgRXJyb3IoYHppcCBmYWlsZWQgKGV4aXQgJHt6Y29kZX0pOiAke3plcnIudHJpbSgpfWApO1xuXG4gICAgYXdhaXQgYXBpKHMucG9ydCwgXCJQT1NUXCIsIFwiL2NtZFwiLCB7XG4gICAgICB0eXBlOiBcImJ1bmRsZS5zZXRcIixcbiAgICAgIG5hbWU6IHppcE5hbWUsXG4gICAgICBjb3VudDogbWFuaWZlc3QubGVuZ3RoLFxuICAgIH0pO1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBtYWdwaWU6IGJ1bmRsZWQgJHttYW5pZmVzdC5sZW5ndGh9IGFzc2V0KHMpIOKGkiAke3ppcFBhdGh9XFxuYCk7XG4gICAgcmVzdWx0ID0geyBjb3VudDogbWFuaWZlc3QubGVuZ3RoIH07XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBmYWlsdXJlID0gZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhzdGFnZURpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIGF3YWl0IGFwaShzLnBvcnQsIFwiUE9TVFwiLCBcIi9jbWRcIiwgeyB0eXBlOiBcInN0YXR1c1wiLCBidXN5OiBmYWxzZSB9KTtcbiAgfVxuXG4gIGlmIChmYWlsdXJlIHx8ICFyZXN1bHQpIGRpZShgZXhwb3J0IGZhaWxlZDogJHtmYWlsdXJlID8/IFwidW5rbm93blwifWAsIFwiaW50ZXJuYWxcIik7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBidW5kbGU6IHppcE5hbWUsIGNvdW50OiByZXN1bHQuY291bnQgfSk7XG59XG5cbmNvbnN0IEhFTFAgPSBgbWFncGllIOKAlCBhIHN0YW5kaW5nIHJldmlldyBzdXJmYWNlIGZvciBleHRyYWN0aW5nIGFzc2V0cyBmcm9tIGEgY29tcG9zaXRlIGltYWdlLlxuXG4gIG9wZW4gICBbLS10aXRsZSAuLl0gWy0taW50ZW50IC4uXSBbLS1uby1vcGVuXSBbLS10aW1lb3V0IFNdIFstLXJlc3RvcmUgPGlkfHBhdGg+XVxuICBzZXNzaW9ucyAgICAgICAgICAgICAgICAgICAgICAgICAgICBsaXN0IHNhdmVkIChyZXN1bWFibGUpIHNlc3Npb25zXG4gIHRhaWwgICBbLS1zaW5jZSBOXSAgICAgICAgICAgICAgICAgIFNTRSB1c2VyIGV2ZW50cyDihpIgSlNPTkwgKHdyYXAgd2l0aCBNb25pdG9yKVxuICBzdGF0ZSAgWy0tZnVsbF0gICAgICAgICAgICAgICAgICAgICBsZWFuIHN0YXRlIHNuYXBzaG90IChhZGQgLS1mdWxsIGZvciByYXcpXG4gIHNheSAgICBbdGV4dC4uLl0gWy0tc3RkaW5dICAgICAgICAgIHBvc3QgYWdlbnQgZGlhbG9ndWUgKHRleHQgYXJncyBPUiBwaXBlZCBzdGRpbilcbiAgYXNrICAgIDx0ZXh0Li4uPiBbLS1vcHRpb25zIFwiYXxifGNcIl0gICBhc2sgdGhlIHVzZXIgYSBxdWVzdGlvbiAoaW4tdGhyZWFkKVxuICBzdGF0dXMgb24gW3RleHQuLi5dIHwgc3RhdHVzIG9mZiAgICBzaG93L2hpZGUgdGhlIFwibWFncGllIHdvcmtpbmdcIiBzcGlubmVyXG4gIHNvdXJjZSA8aW1hZ2VQYXRoPiAgICAgICAgICAgICAgICAgIHJlZ2lzdGVyIHRoZSBjb21wb3NpdGUgdW5kZXIgcmV2aWV3IChjb21wdXRlcyBzaGEgKyBzaXplKVxuICBkaXNjb3ZlciAgICAgICAgICAgICAgICAgICAgICAgICAgICBydW4gZGlzY292ZXIgb24gdGhlIGN1cnJlbnQgc291cmNlIOKGkiBwb3N0IHRoZSBicmVha2Rvd24gKG5lZWRzIE9QRU5ST1VURVJfQVBJX0tFWSlcbiAgZXh0cmFjdCBbLS1pZHMgYSxiXSBbLS1yZW1vdmVdIFstLWFscGhhIGF1dG98YWxsfG5vbmVdIFstLXBhZCBOXSBbLS1tb2RlbCA8bT5dIFstLWxhYmVsIDxuYW1lPl1cbiAgICAgICAgICBjdXQgc2xpY2VzIChjcm9wLW9ubHk7IC0tcmVtb3ZlIGFkZHMgcmVtYmcpLiAtLW1vZGVsID0gYSByZW1iZyBtb2RlbCBuYW1lIChpc25ldC1nZW5lcmFsLXVzZSxcbiAgICAgICAgICBiaXJlZm5ldC1nZW5lcmFsLCDigKYpIE9SIGEgbWVkaWEtZm9yZ2UgYmctcmVtb3ZlIG1vZGVsIGlkIChhIHByb3ZpZGVyIHBhdGggbGlrZVxuICAgICAgICAgIGZhbC1haS9icmlhL2JhY2tncm91bmQvcmVtb3ZlIOKAlCBESVNDT1ZFUiB2aWEgXFxgbWVkaWEtZm9yZ2UgbW9kZWxzIGxpc3RcXGAsIG5ldmVyIGhhcmRjb2RlKTtcbiAgICAgICAgICAtLWxhYmVsIHNldHMgdGhlIHZlcnNpb24ncyBmcmllbmRseSBzdHJpcCBsYWJlbCAoZGVmYXVsdHMgc2Vuc2libHkpXG4gIGV4cG9ydCBbLS1pZHMgYSxiXSAgICAgICAgICAgICAgICAgIGJ1aWxkIG1hZ3BpZS1idW5kbGUuemlwIOKAlCBhc3NldHMvIChjaG9zZW4gZmluYWxzKSArIGNyb3BzLyAocmF3IGNyb3BzKSArIG1hbmlmZXN0Lmpzb24gKyBnYWxsZXJ5Lmh0bWwgKGJhY2tkcm9wIHRvZ2dsZSArIHR5cGUgZmlsdGVycylcbiAgZWxlbWVudC1hZGQgLS1iYm94IFwieDEseTEseDIseTJcIiBbLS1uYW1lIC4uXSBbLS10eXBlIC4uXSAgIGJveCBhIHJlZ2lvbiAoc291cmNlIHB4KVxuICBlbGVtZW50LXJlbW92ZSA8aWQ+ICAgICAgICAgICAgICAgICByZXRyYWN0IGEgYm94ZWQgcmVnaW9uXG4gIGNtZCAgICBbLS1zdGRpbl0gICAgICAgICAgICAgICAgICAgIFBPU1QgYSByYXcgQWdlbnRDb21tYW5kIEpTT04gYm9keSBmcm9tIHN0ZGluXG4gIGNsb3NlIHwgaW5mbyB8IGhlbHBcbiAgLS12ZXJzaW9uICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJpbnQgbWFncGllJ3MgdmVyc2lvbiBhcyBKU09OXG5cbiAgQWRkIC0tc2Vzc2lvbiA8aWQ+IHRvIHRhcmdldCBhIHNwZWNpZmljIHNlc3Npb24gKGRlZmF1bHQ6IG1vc3QgcmVjZW50KS4gSXQgaXNcbiAgYWNjZXB0ZWQgYnkgZXZlcnkgdmVyYiB0aGF0IGFjdHMgb24gYSBzZXNzaW9uIOKAlCBub3QgYnkgb3Blbiwgc2Vzc2lvbnMgb3IgaGVscCxcbiAgd2hpY2ggZG8gbm90IGhhdmUgb25lIHRvIHRhcmdldC5cblxuICBGbGFncyBhcmUgc2NvcGVkIHRvIHRoZWlyIHZlcmI6IGV4dHJhY3QncyAtLXBhZCBpcyBub3QgYWNjZXB0ZWQgYnkgc2F5LiBBXG4gIHJlamVjdGlvbiBsaXN0cyB3aGF0IHRoZSB2ZXJiIGl0IG5hbWVzIGRvZXMgYWNjZXB0LlxuXG4gIE91dHB1dDogbWFncGllIHByaW50cyBKU09OIGJ5IGRlZmF1bHQgb24gc3Rkb3V0LiBFdmVyeSB2ZXJiIHdyaXRlcyBPTkUgSlNPTlxuICBkb2N1bWVudCB0aGVyZSDigJQgZXhjZXB0IFxcYHRhaWxcXGAsIHdoaWNoIGlzIGEgc3RyZWFtIGFuZCB3cml0ZXMgb25lIHBlciBsaW5lXG4gIChKU09OTCkuIFByb3NlLCBsaXZlbmVzcyBhbmQgZGlhZ25vc3RpY3MgZ28gdG8gc3RkZXJyLiBcXGAtLWZ1bGxcXGBcbiAgd2lkZW5zIHRoZSBzdGF0ZSBwYXlsb2FkOyBpdCBkb2VzIG5vdCBzd2l0Y2ggZm9ybWF0cy5gO1xuXG5hc3luYyBmdW5jdGlvbiBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgW3ZlcmIsIC4uLnJlc3RdID0gYXJndjtcbiAgQ1VSUkVOVF9DT01NQU5EID0gdmVyYiA/PyBudWxsO1xuXG4gIC8vIFJPT1QgVE9LRU5TIEZJUlNULCBiZWZvcmUgYW55IGZsYWcgcGFyc2luZy4gVGhlc2UgYXJlIG5vdCB2ZXJicyBhbmQgdGhleVxuICAvLyBjYXJyeSBubyBmbGFncywgc28gcmVzb2x2aW5nIHRoZW0gaGVyZSBrZWVwcyB0aGVtIG91dCBvZiBldmVyeSB2ZXJiJ3Mgc2V0LlxuICBpZiAodmVyYiA9PT0gXCItLWhlbHBcIiB8fCB2ZXJiID09PSBcIi1oXCIpIHtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtIRUxQfVxcbmApO1xuICAgIHJldHVybiAwO1xuICB9XG4gIGlmICh2ZXJiID09PSBcIi0tdmVyc2lvblwiIHx8IHZlcmIgPT09IFwiLVZcIikge1xuICAgIHByaW50SnNvbih7IG5hbWU6IFwibWFncGllXCIsIHZlcnNpb246IFBMVUdJTl9WRVJTSU9OIH0pO1xuICAgIHJldHVybiAwO1xuICB9XG4gIGlmICh2ZXJiID09PSB1bmRlZmluZWQpIHtcbiAgICAvLyBBIGJhcmUgaW52b2NhdGlvbiBpcyBhIHVzYWdlIGVycm9yLCBub3QgYSBoZWxwIHBhdGgg4oCUIG1hZ3BpZSBpcyBkcml2ZW4gYnlcbiAgICAvLyBhbiBhZ2VudCwgYW5kIGFuIGVtcHR5IGFyZ3YgaXMgYW4gYWdlbnQgdGhhdCBmYWlsZWQgdG8gbmFtZSB3aGF0IGl0XG4gICAgLy8gd2FudGVkLiBzdGRvdXQgc3RheXMgZW1wdHk7IGl0IGNhcnJpZXMgZGF0YSBhbmQgdGhpcyBoYXMgbm9uZS5cbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgIGVycm9yRW52ZWxvcGUoXCJ1c2FnZVwiLCBcIm5vIHZlcmIgZ2l2ZW5cIiwgeyBoaW50OiBcInJ1bjogY2xpLnRzIGhlbHBcIiwgY2hvaWNlczogVkVSQlMgfSksXG4gICAgKTtcbiAgICByZXR1cm4gMjtcbiAgfVxuICAvLyBUSEUgVkVSQiBJUyBSRUpFQ1RFRCBCRUZPUkUgSVRTIEZMQUdTIEFSRSBSRUFELiBJdCBoYXMgdG8gYmU6IHdoaWNoIGZsYWdzXG4gIC8vIGFyZSBsZWdhbCBpcyBhIHF1ZXN0aW9uIGFib3V0IHRoZSB2ZXJiLCBzbyB0aGVyZSBpcyBubyBzZXQgdG8gY2hlY2sgYWdhaW5zdFxuICAvLyB1bnRpbCB3ZSBrbm93IGl0IGlzIGEgcmVhbCBvbmUuXG4gIGlmICghaXNWZXJiKHZlcmIpKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBlcnJvckVudmVsb3BlKFwidXNhZ2VcIiwgYHVua25vd24gdmVyYiBcIiR7dmVyYn1cImAsIHtcbiAgICAgICAgaGludDogXCJydW46IGNsaS50cyBoZWxwXCIsXG4gICAgICAgIGNob2ljZXM6IFZFUkJTLFxuICAgICAgfSksXG4gICAgKTtcbiAgICByZXR1cm4gMjtcbiAgfVxuXG4gIGxldCBwb3M6IHN0cmluZ1tdO1xuICBsZXQgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+O1xuICB0cnkge1xuICAgICh7IHBvcywgZmxhZ3MgfSA9IHBhcnNlQXJncyhyZXN0LCB2ZXJiKSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBpZiAoIShlIGluc3RhbmNlb2YgVXNhZ2VFcnJvcikpIHRocm93IGU7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBlcnJvckVudmVsb3BlKFwidXNhZ2VcIiwgZS5tZXNzYWdlLCB7XG4gICAgICAgIGhpbnQ6IGBmbGFncyBhcmUgc2NvcGVkIHRvIHRoZSB2ZXJiIOKAlCBjaG9pY2VzIGxpc3RzIHdoYXQgXFxgJHt2ZXJifVxcYCBhY2NlcHRzOyBmb3IgZnJlZSB0ZXh0IGNvbnRhaW5pbmcgZGFzaGVzIHVzZSAtLXN0ZGluLCBvciBwdXQgaXQgYWZ0ZXIgYSBiYXJlIC0tYCxcbiAgICAgICAgY2hvaWNlczogZmxhZ3NGb3IodmVyYiksXG4gICAgICB9KSxcbiAgICApO1xuICAgIHJldHVybiAyO1xuICB9XG4gIGNvbnN0IHNlc3Npb24gPSB0eXBlb2YgZmxhZ3Muc2Vzc2lvbiA9PT0gXCJzdHJpbmdcIiA/IGZsYWdzLnNlc3Npb24gOiB1bmRlZmluZWQ7XG5cbiAgc3dpdGNoICh2ZXJiKSB7XG4gICAgY2FzZSBcIm9wZW5cIjpcbiAgICAgIGF3YWl0IGNtZE9wZW4oZmxhZ3MpO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcInRhaWxcIjpcbiAgICAgIGF3YWl0IGNtZFRhaWwoc2Vzc2lvbiwgdHlwZW9mIGZsYWdzLnNpbmNlID09PSBcInN0cmluZ1wiID8gcGFyc2VJbnQoZmxhZ3Muc2luY2UsIDEwKSA6IC0xKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJzdGF0ZVwiOlxuICAgICAgYXdhaXQgY21kU3RhdGUoc2Vzc2lvbiwgZmxhZ3MuZnVsbCA9PT0gdHJ1ZSk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwic2F5XCI6IHtcbiAgICAgIGNvbnN0IHRleHQgPSBmbGFncy5zdGRpbiA9PT0gdHJ1ZSA/IGF3YWl0IHJlYWRTdGRpbigpIDogcG9zLmpvaW4oXCIgXCIpO1xuICAgICAgaWYgKCF0ZXh0KSBkaWUoXCJ1c2FnZTogc2F5IDx0ZXh0Li4uPiB8IHNheSAtLXN0ZGluXCIpO1xuICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwic2F5XCIsIHRleHQgfSk7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgY2FzZSBcImFza1wiOiB7XG4gICAgICBpZiAoIXBvcy5sZW5ndGgpIGRpZSgndXNhZ2U6IGFzayA8dGV4dC4uLj4gWy0tb3B0aW9ucyBcImF8YnxjXCJdJyk7XG4gICAgICBjb25zdCBtc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyB0eXBlOiBcImFza1wiLCB0ZXh0OiBwb3Muam9pbihcIiBcIikgfTtcbiAgICAgIGlmICh0eXBlb2YgZmxhZ3Mub3B0aW9ucyA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICBtc2cub3B0aW9ucyA9IGZsYWdzLm9wdGlvbnNcbiAgICAgICAgICAuc3BsaXQoXCJ8XCIpXG4gICAgICAgICAgLm1hcCgocykgPT4gcy50cmltKCkpXG4gICAgICAgICAgLmZpbHRlcihCb29sZWFuKTtcbiAgICAgIH1cbiAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgbXNnKTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBjYXNlIFwic3RhdHVzXCI6XG4gICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgdHlwZTogXCJzdGF0dXNcIixcbiAgICAgICAgYnVzeTogcG9zWzBdID09PSBcIm9uXCIsXG4gICAgICAgIHRleHQ6IHBvcy5zbGljZSgxKS5qb2luKFwiIFwiKSxcbiAgICAgIH0pO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcInNvdXJjZVwiOlxuICAgICAgaWYgKCFwb3MubGVuZ3RoKSBkaWUoXCJ1c2FnZTogc291cmNlIDxpbWFnZVBhdGg+XCIpO1xuICAgICAgYXdhaXQgY21kU291cmNlKHNlc3Npb24sIHBvc1swXSk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiZGlzY292ZXJcIjpcbiAgICAgIGF3YWl0IGNtZERpc2NvdmVyKHNlc3Npb24pO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcImV4dHJhY3RcIjpcbiAgICAgIGF3YWl0IGNtZEV4dHJhY3Qoc2Vzc2lvbiwgZmxhZ3MpO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcImV4cG9ydFwiOlxuICAgICAgYXdhaXQgY21kRXhwb3J0KHNlc3Npb24sIGZsYWdzKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJlbGVtZW50LWFkZFwiOlxuICAgICAgYXdhaXQgY21kRWxlbWVudEFkZChzZXNzaW9uLCBmbGFncyk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiZWxlbWVudC1yZW1vdmVcIjpcbiAgICAgIGlmICghcG9zLmxlbmd0aCkgZGllKFwidXNhZ2U6IGVsZW1lbnQtcmVtb3ZlIDxpZD5cIik7XG4gICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJlbGVtZW50LnJlbW92ZVwiLCBpZDogcG9zWzBdIH0pO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcImNtZFwiOiB7XG4gICAgICAvLyBQT1NUIGEgcmF3IEFnZW50Q29tbWFuZCBKU09OIGJvZHkgKGZyb20gc3RkaW4pIOKAlCB0aGUgZXNjYXBlIGhhdGNoIGZvclxuICAgICAgLy8gY29tbWFuZHMgY2FycnlpbmcgTkwgdGV4dCBvciByaWNoIHBheWxvYWRzIChlLmcuIGVsZW1lbnRzLnNldCkuXG4gICAgICBjb25zdCByYXcgPSBmbGFncy5zdGRpbiA9PT0gdHJ1ZSA/IGF3YWl0IHJlYWRTdGRpbigpIDogcG9zLmpvaW4oXCIgXCIpO1xuICAgICAgaWYgKCFyYXcpIGRpZShcInVzYWdlOiBjbWQgLS1zdGRpbiAgKHBpcGUgYSBKU09OIEFnZW50Q29tbWFuZCBib2R5KVwiKTtcbiAgICAgIGxldCBib2R5OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIHRyeSB7XG4gICAgICAgIGJvZHkgPSBKU09OLnBhcnNlKHJhdyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgZGllKFwiY21kOiBib2R5IGlzIG5vdCB2YWxpZCBKU09OXCIpO1xuICAgICAgfVxuICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCBib2R5KTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBjYXNlIFwiY2xvc2VcIjpcbiAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcImNsb3NlXCIgfSk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiaW5mb1wiOlxuICAgICAgY21kSW5mbyhzZXNzaW9uKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJzZXNzaW9uc1wiOlxuICAgICAgY21kU2Vzc2lvbnMoKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJoZWxwXCI6XG4gICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtIRUxQfVxcbmApO1xuICAgICAgYnJlYWs7XG4gICAgZGVmYXVsdDpcbiAgICAgIC8vIFVOUkVBQ0hBQkxFIEJZIENPTlNUUlVDVElPTiDigJQgYHZlcmJgIGlzIG5hcnJvd2VkIHRvIFZlcmIgYWJvdmUsIGFuZCBhXG4gICAgICAvLyB0ZXN0IGJpbmRzIFZFUkJfU1BFQydzIGtleXMgdG8gdGhpcyBzd2l0Y2gncyBjYXNlIGxhYmVscy4gS2VwdCBhbnl3YXk6XG4gICAgICAvLyBpZiB0aGF0IGJpbmRpbmcgZXZlciBicmVha3MsIHRoZSBhbHRlcm5hdGl2ZSBpcyBmYWxsaW5nIHRocm91Z2ggdG9cbiAgICAgIC8vIGByZXR1cm4gMGAgd2l0aCBlbXB0eSBzdGRvdXQsIHdoaWNoIHJlcG9ydHMgc3VjY2VzcyBmb3Igd29yayBuZXZlciBkb25lLlxuICAgICAgLy8gVGhhdCBpcyB0aGUgZmFpbHVyZSB0aGlzIGJyYW5jaCBleGlzdHMgdG8gcmVtb3ZlLCBhbmQgaXQgd291bGQgYmUgc2lsZW50LlxuICAgICAgZGllKGBubyBoYW5kbGVyIGZvciB2ZXJiIFwiJHt2ZXJifVwiYCwgXCJpbnRlcm5hbFwiKTtcbiAgfVxuXG4gIHJldHVybiAwO1xufVxuXG5pZiAoaW1wb3J0Lm1ldGEubWFpbikge1xuICAvLyBgcHJvY2Vzcy5leGl0Q29kZWAgKyBhIG5hdHVyYWwgcmV0dXJuLCBORVZFUiBgcHJvY2Vzcy5leGl0KGNvZGUpYDogQnVuJ3NcbiAgLy8gc3Rkb3V0IGlzIEFTWU5DSFJPTk9VUyBvbiBhIHBpcGUgKHN5bmNocm9ub3VzIG9uIGEgVFRZIG9yIGZpbGUpLCBzbyBhblxuICAvLyBleHBsaWNpdCBleGl0IGRpc2NhcmRzIHdoYXRldmVyIGhhcyBub3QgZHJhaW5lZCDigJQgbWVhc3VyZWQgYXQgZXhhY3RseVxuICAvLyA2NSw1MzYgYnl0ZXMuIFRoZSBwYXlsb2FkIGlzIGNvbXBsZXRlIGFuZCBvbmx5IHRoZSB3cml0ZSBpcyBsb3N0LCBzbyB0aGVcbiAgLy8gY2FsbGVyIGdldHMgd2VsbC1mb3JtZWQtbG9va2luZyBKU09OIHRoYXQgc3RvcHMgbWlkLXN0cmluZy4gUmVwcm9kdWNlZCxcbiAgLy8gZml4ZWQgYW5kIGdhdGVkIGluIGJvdW50eSBmaXJzdCAoUDAsICM3Ny8jNzgpOyBzYW1lIHNoYXBlLCBzYW1lIHJlYXNvbi5cbiAgLy8gRG8gbm90IHRpZHkgdGhpcyBiYWNrIGludG8gYW4gZXhwbGljaXQgZXhpdC5cbiAgcHJvY2Vzcy5leGl0Q29kZSA9IGF3YWl0IG1haW4ocHJvY2Vzcy5hcmd2LnNsaWNlKDIpKTtcbn1cblxuZXhwb3J0IHsgbWFpbiB9O1xuXG4vKipcbiAqIFRoZSBTSElQUEVEIEVOVFJZIFBPSU5ULCBjYWxsZWQgYnkgYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9tYWdwaWUvc2NyaXB0cy9jbGkudHNgXG4gKiBhZnRlciB0aGUgYnVuZGxlIGlzIGltcG9ydGVkLlxuICpcbiAqIOKblCBJVCBUQUtFUyBOTyBBUkdVTUVOVFMsIEFORCBUSEFUIElTIFRIRSBQT0lOVC4gYXJndiBiZWxvbmdzIHRvIHdoaWNoZXZlciBmaWxlXG4gKiBQQVJTRVMgaXQsIGFuZCB0aGF0IGlzIHRoaXMgb25lLiBBbiBlYXJsaWVyIGxhdW5jaGVyIHJlYWRcbiAqIGBwcm9jZXNzLmFyZ3Yuc2xpY2UoMilgIGl0c2VsZiBhbmQgcGFzc2VkIGl0IGluIOKAlCB3aGljaCBtYWRlIHRoZSBsYXVuY2hlciBtYXRjaFxuICogYGdyaW1vaXJlL2xpYi9lbnRyeS1wb2ludHMudHNgJ3MgUEFSU0VTX0FSR1MgcHJlZGljYXRlIChgcHJvY2Vzcy5hcmd2YCksIHNvIHRoZVxuICogcm9zdGVyIGNvdW50ZWQgYSAzLWxpbmUgZm9yd2FyZGVyIGFzIGFuIGFyZy1wYXJzaW5nIGVudHJ5IHBvaW50IGFuZCB0aGVuXG4gKiByZXBvcnRlZCB0aGUgc3BlbGwncyBkb2N1bWVudGVkIGZsYWdzIGFzIFVOUkVTT0xWRUQgYWdhaW5zdCBhIGZpbGUgdGhhdFxuICogcmVjb2duaXNlcyBub25lLiBLZWVwaW5nIGFyZ3Ygb24gdGhpcyBzaWRlIG1ha2VzIHRoZSBlbnVtZXJhdG9yJ3MgYW5zd2VyIHRydWVcbiAqIGluc3RlYWQgb2YgbWFraW5nIGl0cyByZWdleCBsb29zZXIuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW4oKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgcmV0dXJuIGF3YWl0IG1haW4ocHJvY2Vzcy5hcmd2LnNsaWNlKDIpKTtcbn1cbiIsCiAgICAiLy8gc2NyaXB0cy9iYWNrZW5kLnRzXG4vLyBSZW1vdmFsLWJhY2tlbmQgcmVnaXN0cnkuIFRoZSByZWJ1aWx0IG1hZ3BpZSBjb21wYXJlcyBiYWNrZ3JvdW5kLXJlbW92YWxcbi8vIHJlc3VsdHMgZnJvbSBtdWx0aXBsZSBiYWNrZW5kcyBwZXIgZWxlbWVudDsgdGhlIHVzZXIgcGlja3MgdGhlIHdpbm5lci4gVGhpc1xuLy8gZmlsZSBkZWZpbmVzIHRoZSBjb250cmFjdCwgdGhlIChsaXZlKSByZW1iZyBpbXBsLCBhIG1lZGlhLWZvcmdlIHN0dWIgZm9yIHRoZVxuLy8gbmV4dCBzdWItcGhhc2UsIGFuZCBhIHJlZ2lzdHJ5LlxuLy9cbi8vIElNQUdFIE9QUyBOT1RFOiBjcm9wcGluZyB0aGUgZWxlbWVudCdzIGJib3ggb3V0IG9mIHRoZSBzb3VyY2UgaXMgTk9UIGRvbmUgd2l0aFxuLy8gQnVuLkltYWdlIChpdCBoYXMgcmVzaXplL2VuY29kZS9tZXRhZGF0YSBidXQgTk8gY3JvcC9leHRyYWN0KS4gcmVtYmdCYWNrZW5kXG4vLyBzaGVsbHMgb3V0IHRvIHNjcmlwdHMvcmVtb3ZlLnB5IChQaWxsb3cgY3JvcCArIHJlbWJnKSDigJQgdGhlIGNhbGxlciBvd25zIHRoZVxuLy8gb3V0cHV0IHBhdGggKHRoZSBzZXNzaW9uIGZpbGVzIGRpcikuXG5cbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG4vLyDilIDilIAgYWxwaGEgcG9saWN5IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy8gVGhlIHR5cGUtZHJpdmVuIGFscGhhIHBvbGljeSBsaXZlcyBpbiBzaGFyZWQvYWxwaGEudHMgKGJyb3dzZXItc2FmZSwgc29cbi8vIHRoZSBzdXJmYWNlIHNoYXJlcyBvbmUgc291cmNlIG9mIHRydXRoIOKAlCBSZW1vdmVHYWxsZXJ5LnRzeCByZWFkcyBpdCB0b28sXG4vLyB3aGljaCBpcyB3aGF0IG1ha2VzIGl0IHR3by1zaWRlZCByYXRoZXIgdGhhbiBkYWVtb24tb25seSkuIFJlLWV4cG9ydGVkIGhlcmVcbi8vIGZvciB0aGUgYWdlbnQtc2lkZSBjb25zdW1lcnMgKGNsaS50cywgYmFja2VuZCB0ZXN0cykgdGhhdCBpbXBvcnQgaXQgZnJvbVxuLy8gdGhpcyBtb2R1bGUuXG5pbXBvcnQgdHlwZSB7IEFscGhhUG9saWN5IH0gZnJvbSBcIi4uL3NoYXJlZC9hbHBoYVwiO1xuaW1wb3J0IHR5cGUgeyBCYm94IH0gZnJvbSBcIi4uL3NoYXJlZC90eXBlc1wiO1xuXG5leHBvcnQge1xuICBBTFBIQV9BVVRPX1RZUEVTLFxuICBBTFBIQV9GT1JCSURERU5fVFlQRVMsXG4gIHR5cGUgQWxwaGFQb2xpY3ksXG4gIHNob3VsZFJlbW92ZSxcbn0gZnJvbSBcIi4uL3NoYXJlZC9hbHBoYVwiO1xuXG4vLyBBIHJlZ2lvbiBvZiB0aGUgc291cmNlIHRvIGN1dCBhIHRyYW5zcGFyZW50IGFzc2V0IGZyb20uXG5leHBvcnQgdHlwZSBDcm9wID0ge1xuICAvLyBvbi1kaXNrIHBhdGggdG8gdGhlIHNvdXJjZSBjb21wb3NpdGUgKG9yIGEgcHJlLWNyb3BwZWQgcmVnaW9uIOKAlCBzZWUgY3JvcCBub3RlKVxuICBzb3VyY2VQYXRoOiBzdHJpbmc7XG4gIC8vIHRoZSBlbGVtZW50J3MgcGl4ZWwgYmJveCBbeDEsIHkxLCB4MiwgeTJdIHdpdGhpbiB0aGUgc291cmNlXG4gIGJib3g6IEJib3g7XG4gIC8vIGVsZW1lbnQgdHlwZSBkcml2ZXMgd2hldGhlciByZW1vdmFsIGV2ZW4gbWFrZXMgc2Vuc2UgKHBhbGV0dGVzL3NjcmVlbnNob3RzXG4gIC8vIGdldCBkZXN0cm95ZWQgYnkgcmVtYmcg4oCUIHNlZSBtYWdwaWUncyBBbHBoYSBQb2xpY3kpXG4gIHR5cGU6IHN0cmluZztcbn07XG5cbi8vIFRoZSByZXN1bHQgb2YgYSByZW1vdmFsIHBhc3Mg4oCUIGEgY3V0b3V0IFBORyAod2l0aCBhbHBoYSkgdGhlIHN1cmZhY2UgZGlzcGxheXMuXG5leHBvcnQgdHlwZSBDdXRvdXQgPSB7XG4gIGlkOiBzdHJpbmc7XG4gIGJhY2tlbmQ6IHN0cmluZzsgLy8gd2hpY2ggUmVtb3ZhbEJhY2tlbmQgcHJvZHVjZWQgaXRcbiAgcGF0aDogc3RyaW5nOyAvLyBvbi1kaXNrIFBORyB0aGUgYWdlbnQgcmVhZHMgLyB0aGUgc3VyZmFjZSBzZXJ2ZXNcbiAgLy8gVE9ETyhtb2NrKTogd2lkdGgvaGVpZ2h0LCBhIHByZXZpZXcgc3JjLCB0aW1pbmcvY29zdCwgYSBxdWFsaXR5IHNpZ25hbFxufTtcblxuLy8gT3B0aW9uYWwga25vYnMgdGhyZWFkZWQgdGhyb3VnaCB0byByZW1vdmUucHkgKHRoZSBleHRyYWN0IGxvb3AgaG9ub3JzIC0tYWxwaGFcbi8vIC8gLS1wYWQgLyAtLW1vZGVsIGZyb20gdGhlIENMSSB2ZXJiKS4gQWxsIGhhdmUgc2Vuc2libGUgZGVmYXVsdHMgaW5zaWRlXG4vLyByZW1vdmUucHkuIGBtb2RlbGAgbmFtZXMgYSBzcGVjaWZpYyByZW1iZyBtb2RlbCBmb3IgdGhlIG1vZGVsLWFnbm9zdGljIHJldHJ5XG4vLyAob21pdCDihpIgcmVtYmcncyBkZWZhdWx0IHUybmV0KS5cbmV4cG9ydCB0eXBlIEN1dE9wdGlvbnMgPSB7IGFscGhhPzogQWxwaGFQb2xpY3k7IHBhZD86IG51bWJlcjsgbW9kZWw/OiBzdHJpbmcgfTtcblxuZXhwb3J0IGludGVyZmFjZSBSZW1vdmFsQmFja2VuZCB7XG4gIG5hbWU6IHN0cmluZztcbiAgLy8gQ3V0IHRoZSBiYm94IHJlZ2lvbiBvdXQgb2YgdGhlIHNvdXJjZSBpbnRvIGBvdXRQYXRoYCBhbmQgcmV0dXJuIHRoZSBjdXRvdXQuXG4gIC8vIFRoZSBjYWxsZXIgb3ducyBgb3V0UGF0aGAgKHRoZSBzZXNzaW9uIGZpbGVzIGRpcikuIGBvcHRzYCBjYXJyaWVzIHRoZVxuICAvLyBhbHBoYS1wb2xpY3kgLyBwYWRkaW5nIHRoZSBDTEkgZXh0cmFjdCB2ZXJiIHBhc3NlcyB0aHJvdWdoLlxuICBjdXQoY3JvcDogQ3JvcCwgb3V0UGF0aDogc3RyaW5nLCBvcHRzPzogQ3V0T3B0aW9ucyk6IFByb21pc2U8Q3V0b3V0Pjtcbn1cblxuLy8gUmVzb2x2ZSBzY3JpcHRzL3JlbW92ZS5weSByZWxhdGl2ZSB0byB0aGlzIG1vZHVsZSAobm90IGN3ZCkuXG5jb25zdCBSRU1PVkVfUFkgPSBqb2luKGltcG9ydC5tZXRhLmRpciwgXCJyZW1vdmUucHlcIik7XG5cbmZ1bmN0aW9uIHNob3J0SWQocHJlZml4OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBidWYgPSBuZXcgVWludDhBcnJheSg0KTtcbiAgY3J5cHRvLmdldFJhbmRvbVZhbHVlcyhidWYpO1xuICBjb25zdCBoZXggPSBBcnJheS5mcm9tKGJ1ZiwgKGIpID0+IGIudG9TdHJpbmcoMTYpLnBhZFN0YXJ0KDIsIFwiMFwiKSkuam9pbihcIlwiKTtcbiAgcmV0dXJuIGAke3ByZWZpeH0tJHtoZXh9YDtcbn1cblxuLy8gcmVtYmcgYmFja2VuZCDigJQgc2hlbGxzIG91dCB0byBzY3JpcHRzL3JlbW92ZS5weSAoUGlsbG93IGNyb3AgKyByZW1iZykuIFRoZVxuLy8gY2FsbGVyIHBhc3NlcyB0aGUgb3V0cHV0IGxvY2F0aW9uOyB3ZSBwYXJzZSByZW1vdmUucHkncyBvbmUgSlNPTiBsaW5lIGFuZFxuLy8gcmV0dXJuIHRoZSBjdXRvdXQuXG5leHBvcnQgY29uc3QgcmVtYmdCYWNrZW5kOiBSZW1vdmFsQmFja2VuZCA9IHtcbiAgbmFtZTogXCJyZW1iZ1wiLFxuICBhc3luYyBjdXQoY3JvcDogQ3JvcCwgb3V0UGF0aDogc3RyaW5nLCBvcHRzOiBDdXRPcHRpb25zID0ge30pOiBQcm9taXNlPEN1dG91dD4ge1xuICAgIGNvbnN0IFt4MSwgeTEsIHgyLCB5Ml0gPSBjcm9wLmJib3g7XG4gICAgY29uc3QgYXJncyA9IFtcbiAgICAgIFwicHl0aG9uM1wiLFxuICAgICAgUkVNT1ZFX1BZLFxuICAgICAgXCItLXNvdXJjZVwiLFxuICAgICAgY3JvcC5zb3VyY2VQYXRoLFxuICAgICAgXCItLWJib3hcIixcbiAgICAgIGAke3gxfSwke3kxfSwke3gyfSwke3kyfWAsXG4gICAgICBcIi0tdHlwZVwiLFxuICAgICAgY3JvcC50eXBlLFxuICAgICAgXCItLW91dFwiLFxuICAgICAgb3V0UGF0aCxcbiAgICBdO1xuICAgIGlmIChvcHRzLmFscGhhKSBhcmdzLnB1c2goXCItLWFscGhhXCIsIG9wdHMuYWxwaGEpO1xuICAgIGlmICh0eXBlb2Ygb3B0cy5wYWQgPT09IFwibnVtYmVyXCIpIGFyZ3MucHVzaChcIi0tcGFkXCIsIFN0cmluZyhvcHRzLnBhZCkpO1xuICAgIGlmIChvcHRzLm1vZGVsKSBhcmdzLnB1c2goXCItLW1vZGVsXCIsIG9wdHMubW9kZWwpO1xuXG4gICAgY29uc3QgcHJvYyA9IEJ1bi5zcGF3bihhcmdzLCB7IHN0ZG91dDogXCJwaXBlXCIsIHN0ZGVycjogXCJwaXBlXCIgfSk7XG4gICAgY29uc3QgW3N0ZG91dCwgc3RkZXJyLCBleGl0Q29kZV0gPSBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgICBuZXcgUmVzcG9uc2UocHJvYy5zdGRvdXQpLnRleHQoKSxcbiAgICAgIG5ldyBSZXNwb25zZShwcm9jLnN0ZGVycikudGV4dCgpLFxuICAgICAgcHJvYy5leGl0ZWQsXG4gICAgXSk7XG4gICAgaWYgKGV4aXRDb2RlICE9PSAwKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGByZW1iZyByZW1vdmUucHkgZmFpbGVkIChleGl0ICR7ZXhpdENvZGV9KTogJHtzdGRlcnIudHJpbSgpIHx8IHN0ZG91dC50cmltKCl9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IGxpbmUgPSBzdGRvdXQudHJpbSgpLnNwbGl0KFwiXFxuXCIpLmZpbHRlcihCb29sZWFuKS5wb3AoKSA/PyBcIlwiO1xuICAgIGxldCBwYXJzZWQ6IHsgb3V0Pzogc3RyaW5nOyByZW1vdmVkPzogYm9vbGVhbiB9O1xuICAgIHRyeSB7XG4gICAgICBwYXJzZWQgPSBKU09OLnBhcnNlKGxpbmUpIGFzIHsgb3V0Pzogc3RyaW5nOyByZW1vdmVkPzogYm9vbGVhbiB9O1xuICAgIH0gY2F0Y2gge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGByZW1iZyByZW1vdmUucHkgcHJvZHVjZWQgbm8gcGFyc2VhYmxlIEpTT04gbGluZTogJHtzdGRvdXQudHJpbSgpfWApO1xuICAgIH1cbiAgICByZXR1cm4geyBpZDogc2hvcnRJZChcImN1dFwiKSwgYmFja2VuZDogXCJyZW1iZ1wiLCBwYXRoOiBwYXJzZWQub3V0ID8/IG91dFBhdGggfTtcbiAgfSxcbn07XG5cbi8vIG1lZGlhLWZvcmdlIGJhY2tlbmQg4oCUIGNsb3VkIGJhY2tncm91bmQgcmVtb3ZhbCB2aWEgdGhlIG1lZGlhLWZvcmdlIENMSSAodGhlXG4vLyBzYW1lIG91dC1vZi1iYW5kIHRvb2wgaW1hZ28gdXNlcykuIGBtZWRpYS1mb3JnZSBnZW5lcmF0ZSBiZy1yZW1vdmVgIGlzIGFcbi8vIHNpbmdsZS1pbWFnZSB0cmFuc2Zvcm0gKHByb21wdC1sZXNzKTogaXQgdGFrZXMgT05FIGltYWdlIGFuZCByZXR1cm5zIGFcbi8vIHRyYW5zcGFyZW50IFBORy4gU28gYGNyb3Auc291cmNlUGF0aGAgaGVyZSBpcyB0aGUgZWxlbWVudCdzIEFMUkVBRFktQ1JPUFBFRFxuLy8gaW1hZ2UgKHRoZSBzdXJmYWNlJ3MgY3JvcCB2ZXJzaW9uKSwgTk9UIHRoZSBmdWxsIGJvYXJkIOKAlCB0aGUgY2FsbGVyIHBhc3NlcyBpdC5cbi8vIGBvcHRzLm1vZGVsYCBpcyB0aGUgbWVkaWEtZm9yZ2UgbW9kZWwgaWQgKGUuZy4gZmFsLWFpL2JyaWEvYmFja2dyb3VuZC9yZW1vdmUpLlxuLy8gV2UgcGFyc2UgdGhlIGpvYidzIHByZXNpZ25lZCBvdXRwdXQgVVJMIGFuZCBzdHJlYW0gaXQgdG8gb3V0UGF0aC5cbmV4cG9ydCBjb25zdCBtZWRpYUZvcmdlQmFja2VuZDogUmVtb3ZhbEJhY2tlbmQgPSB7XG4gIG5hbWU6IFwibWVkaWEtZm9yZ2VcIixcbiAgYXN5bmMgY3V0KGNyb3A6IENyb3AsIG91dFBhdGg6IHN0cmluZywgb3B0czogQ3V0T3B0aW9ucyA9IHt9KTogUHJvbWlzZTxDdXRvdXQ+IHtcbiAgICBjb25zdCBtb2RlbCA9IG9wdHMubW9kZWw7XG4gICAgaWYgKCFtb2RlbCkgdGhyb3cgbmV3IEVycm9yKFwibWVkaWFGb3JnZUJhY2tlbmQuY3V0IHJlcXVpcmVzIG9wdHMubW9kZWwgKGEgYmctcmVtb3ZlIG1vZGVsIGlkKVwiKTtcbiAgICBjb25zdCBhcmdzID0gW1xuICAgICAgXCJtZWRpYS1mb3JnZVwiLFxuICAgICAgXCJnZW5lcmF0ZVwiLFxuICAgICAgXCJiZy1yZW1vdmVcIixcbiAgICAgIGAtLW1vZGVsPSR7bW9kZWx9YCxcbiAgICAgIGAtLXJlZj0ke2Nyb3Auc291cmNlUGF0aH1gLFxuICAgICAgXCItLWZvcm1hdFwiLFxuICAgICAgXCJqc29uXCIsXG4gICAgXTtcbiAgICBjb25zdCBwcm9jID0gQnVuLnNwYXduKGFyZ3MsIHsgc3Rkb3V0OiBcInBpcGVcIiwgc3RkZXJyOiBcInBpcGVcIiB9KTtcbiAgICBjb25zdCBbc3Rkb3V0LCBzdGRlcnIsIGV4aXRDb2RlXSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICAgIG5ldyBSZXNwb25zZShwcm9jLnN0ZG91dCkudGV4dCgpLFxuICAgICAgbmV3IFJlc3BvbnNlKHByb2Muc3RkZXJyKS50ZXh0KCksXG4gICAgICBwcm9jLmV4aXRlZCxcbiAgICBdKTtcbiAgICBpZiAoZXhpdENvZGUgIT09IDApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYG1lZGlhLWZvcmdlIGJnLXJlbW92ZSBmYWlsZWQgKGV4aXQgJHtleGl0Q29kZX0pOiAke3N0ZGVyci50cmltKCkgfHwgc3Rkb3V0LnRyaW0oKX1gLFxuICAgICAgKTtcbiAgICB9XG4gICAgbGV0IHBhcnNlZDogeyBvaz86IGJvb2xlYW47IGRhdGE/OiB7IG91dHB1dHM/OiBBcnJheTx7IHByZXNpZ25lZFVybD86IHN0cmluZyB9PiB9IH07XG4gICAgdHJ5IHtcbiAgICAgIHBhcnNlZCA9IEpTT04ucGFyc2Uoc3Rkb3V0LnRyaW0oKS5zcGxpdChcIlxcblwiKS5maWx0ZXIoQm9vbGVhbikucG9wKCkgPz8gXCJcIik7XG4gICAgfSBjYXRjaCB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYG1lZGlhLWZvcmdlIHByb2R1Y2VkIG5vIHBhcnNlYWJsZSBKU09OIGxpbmU6ICR7c3Rkb3V0LnRyaW0oKX1gKTtcbiAgICB9XG4gICAgY29uc3QgdXJsID0gcGFyc2VkPy5kYXRhPy5vdXRwdXRzPy5bMF0/LnByZXNpZ25lZFVybDtcbiAgICBpZiAoIXVybCkgdGhyb3cgbmV3IEVycm9yKGBtZWRpYS1mb3JnZSByZXR1cm5lZCBubyBvdXRwdXQgdXJsOiAke3N0ZG91dC50cmltKCl9YCk7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2godXJsKTtcbiAgICBpZiAoIXJlcy5vaykgdGhyb3cgbmV3IEVycm9yKGBtZWRpYS1mb3JnZSBvdXRwdXQgZG93bmxvYWQgZmFpbGVkIChIVFRQICR7cmVzLnN0YXR1c30pYCk7XG4gICAgYXdhaXQgQnVuLndyaXRlKG91dFBhdGgsIHJlcyk7XG4gICAgcmV0dXJuIHsgaWQ6IHNob3J0SWQoXCJjdXRcIiksIGJhY2tlbmQ6IFwibWVkaWEtZm9yZ2VcIiwgcGF0aDogb3V0UGF0aCB9O1xuICB9LFxufTtcblxuLy8gSXMgdGhpcyBhIG1lZGlhLWZvcmdlIG1vZGVsIGlkIChhIHByb3ZpZGVyIHBhdGggbGlrZSBcImZhbC1haS9icmlhL2JhY2tncm91bmQvXG4vLyByZW1vdmVcIikgdnMgYSBiYXJlIHJlbWJnIG1vZGVsIG5hbWUgKGUuZy4gXCJpc25ldC1nZW5lcmFsLXVzZVwiKT8gV2Ugcm91dGUgYnlcbi8vIFNIQVBFLCBuZXZlciBhIGhhcmRjb2RlZCBtb2RlbCBsaXN0IOKAlCBtZWRpYS1mb3JnZSdzIGNhdGFsb2cgZHJpZnRzLCBzbyB0aGUgYWdlbnRcbi8vIERJU0NPVkVSUyBiZy1yZW1vdmUgbW9kZWwgaWRzIHZpYSBgbWVkaWEtZm9yZ2UgbW9kZWxzIGxpc3RgIChvcGVyYXRpb25zXG4vLyBbXCJiZy1yZW1vdmVcIl0pIGFuZCBwYXNzZXMgdGhlIGlkIHRocm91Z2guIFRoZSBtYWdwaWUgQ0xJIGFic3RyYWN0cyB0aGVcbi8vIG9yY2hlc3RyYXRpb24sIG5vdCB0aGUgbW9kZWwgaWRlbnRpdHkuXG5leHBvcnQgZnVuY3Rpb24gaXNNZWRpYUZvcmdlTW9kZWwobW9kZWw6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gbW9kZWwuaW5jbHVkZXMoXCIvXCIpO1xufVxuXG4vLyBUaGUgcmVnaXN0cnkgdGhlIGRhZW1vbi9zdXJmYWNlIHBpY2tzIGJhY2tlbmRzIGZyb20uXG5leHBvcnQgY29uc3QgUkVNT1ZBTF9CQUNLRU5EUzogUmVjb3JkPHN0cmluZywgUmVtb3ZhbEJhY2tlbmQ+ID0ge1xuICBbcmVtYmdCYWNrZW5kLm5hbWVdOiByZW1iZ0JhY2tlbmQsXG4gIFttZWRpYUZvcmdlQmFja2VuZC5uYW1lXTogbWVkaWFGb3JnZUJhY2tlbmQsXG59O1xuXG5leHBvcnQgZnVuY3Rpb24gZ2V0QmFja2VuZChuYW1lOiBzdHJpbmcpOiBSZW1vdmFsQmFja2VuZCB8IHVuZGVmaW5lZCB7XG4gIHJldHVybiBSRU1PVkFMX0JBQ0tFTkRTW25hbWVdO1xufVxuIiwKICAgICIvLyBzaGFyZWQvYWxwaGEudHNcbi8vIFRoZSB0eXBlLWRyaXZlbiBhbHBoYSBwb2xpY3kg4oCUIHdoaWNoIEVMRU1FTlQgVFlQRVMgZ2V0IGJhY2tncm91bmQgcmVtb3ZhbC5cbi8vIEJyb3dzZXItc2FmZSAobm8gbm9kZToqLCBubyBCdW4pOiB0aGUgc3VyZmFjZSByZWFkcyBpdCB0byBzaG93IFwiUmVtb3ZlIGJnXCIgdnMgYVxuLy8gXCJrZXB0IHdob2xlXCIgbm90ZTsgc2NyaXB0cy9iYWNrZW5kLnRzICsgcmVtb3ZlLnB5IG1pcnJvciB0aGUgc2FtZSBydWxlLiBUaGlzIGlzXG4vLyBhYm91dCBlbGVtZW50IFRZUEVTICh3aGljaCBsaXZlIGluIHRoZSBVSSksIE5PVCBtb2RlbHMgKHdoaWNoIG5ldmVyIGRvKS5cbmltcG9ydCB0eXBlIHsgRWxlbWVudFR5cGUgfSBmcm9tIFwiLi90eXBlc1wiO1xuXG5leHBvcnQgdHlwZSBBbHBoYVBvbGljeSA9IFwiYXV0b1wiIHwgXCJhbGxcIiB8IFwibm9uZVwiO1xuXG4vLyByZW1iZyByZWxpYWJseSBwcm9kdWNlcyB1c2FibGUgYWxwaGEgZm9yIHRoZXNlICh1bmRlciBgYXV0b2ApLlxuZXhwb3J0IGNvbnN0IEFMUEhBX0FVVE9fVFlQRVM6IFJlYWRvbmx5U2V0PEVsZW1lbnRUeXBlPiA9IG5ldyBTZXQoW1xuICBcImlsbHVzdHJhdGlvblwiLFxuICBcInN0aWNrZXJcIixcbiAgXCJpY29uXCIsXG4gIFwid29yZG1hcmtcIixcbl0pO1xuXG4vLyByZW1iZyBkZXN0cm95cyB0aGVzZSAoZmxhdC1jb2xvciBjb250ZW50KSDigJQgbmV2ZXIgYWxwaGEgdGhlbSwgZXZlbiB1bmRlciBgYWxsYC5cbmV4cG9ydCBjb25zdCBBTFBIQV9GT1JCSURERU5fVFlQRVM6IFJlYWRvbmx5U2V0PEVsZW1lbnRUeXBlPiA9IG5ldyBTZXQoW1xuICBcInBhbGV0dGVcIixcbiAgXCJzY3JlZW5zaG90XCIsXG4gIFwidHlwb2dyYXBoeVwiLFxuXSk7XG5cbi8vIFNob3VsZCBhbiBlbGVtZW50IG9mIGB0eXBlYCBnZXQgYmFja2dyb3VuZCByZW1vdmFsIHVuZGVyIGBwb2xpY3lgPyBNaXJyb3JzXG4vLyByZW1vdmUucHkncyBzaG91bGRfcmVtb3ZlIGV4YWN0bHkuXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkUmVtb3ZlKHR5cGU6IHN0cmluZywgcG9saWN5OiBBbHBoYVBvbGljeSk6IGJvb2xlYW4ge1xuICBpZiAocG9saWN5ID09PSBcIm5vbmVcIikgcmV0dXJuIGZhbHNlO1xuICBpZiAocG9saWN5ID09PSBcImFsbFwiKSByZXR1cm4gIUFMUEhBX0ZPUkJJRERFTl9UWVBFUy5oYXModHlwZSBhcyBFbGVtZW50VHlwZSk7XG4gIHJldHVybiBBTFBIQV9BVVRPX1RZUEVTLmhhcyh0eXBlIGFzIEVsZW1lbnRUeXBlKTsgLy8gYXV0byAoZGVmYXVsdClcbn1cblxuLy8gU3VyZmFjZSBoZWxwZXI6IGlzIHRoaXMgZWxlbWVudCB0eXBlIGEgY2FuZGlkYXRlIGZvciByZW1vdmFsIHVuZGVyIHRoZSBkZWZhdWx0XG4vLyBgYXV0b2AgcG9saWN5PyBEcml2ZXMgdGhlIFwiUmVtb3ZlIGJnXCIgYWN0aW9uIHZzIHRoZSBcImtlcHQgd2hvbGVcIiBleHBsYWluZXIuXG5leHBvcnQgZnVuY3Rpb24gaXNBbHBoYUVsaWdpYmxlKHR5cGU6IEVsZW1lbnRUeXBlKTogYm9vbGVhbiB7XG4gIHJldHVybiBBTFBIQV9BVVRPX1RZUEVTLmhhcyh0eXBlKTtcbn1cblxuLy8gSXMgdGhpcyB0eXBlIGV4cGxpY2l0bHkga2VwdCB3aG9sZSAoZmxhdCBjb2xvciByZW1iZyB3b3VsZCBkZXN0cm95KT9cbmV4cG9ydCBmdW5jdGlvbiBpc0tlcHRXaG9sZSh0eXBlOiBFbGVtZW50VHlwZSk6IGJvb2xlYW4ge1xuICByZXR1cm4gQUxQSEFfRk9SQklEREVOX1RZUEVTLmhhcyh0eXBlKTtcbn1cbiIsCiAgICAiIyEvdXNyL2Jpbi9lbnYgYnVuXG4vLyBtYWdwaWUg4oCUIGRpc2NvdmVyIHBoYXNlLiBUaGUgY2Fub25pY2FsIGVsZW1lbnQtZGlzY292ZXJ5IGltcGxlbWVudGF0aW9uLlxuLy9cbi8vIENhbGxzIEdlbWluaSAzLjUgRmxhc2ggdmlhIE9wZW5Sb3V0ZXIgb24gYSBtb29kYm9hcmQgLyBicmFuZGluZyBib2FyZCBpbWFnZSxcbi8vIGFza3MgdGhlIG1vZGVsIHRvIGlkZW50aWZ5IGV2ZXJ5IGRpc3RpbmN0IGV4dHJhY3RhYmxlIHZpc3VhbCBlbGVtZW50LCBhbmRcbi8vIHJldHVybnMgYSBtYW5pZmVzdCAobmFtZSArIHR5cGUgKyBzb3VyY2UtcGl4ZWwgYmJveCBwZXIgZWxlbWVudCwgKyBjb3N0L3Rva2VucykuXG4vLyBBIHBsYWluIGZ1bmN0aW9uIG1vZHVsZSB0aGUgZGFlbW9uL2NsaSBjYWxsOyBhIHNtYWxsIENMSSBlbnRyeSBsaXZlcyBhdCB0aGVcbi8vIGJvdHRvbS4gKFBvcnRlZCBmcm9tIGFuIGVhcmxpZXIgUHl0aG9uIG9yaWdpbmFsLCBzaW5jZSByZW1vdmVkLilcblxuaW1wb3J0IHsgZGlybmFtZSwgZXh0bmFtZSwgam9pbiwgcmVzb2x2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB0eXBlIHsgQmJveCwgRWxlbWVudFR5cGUgfSBmcm9tIFwiLi4vc2hhcmVkL3R5cGVzXCI7XG5cbmV4cG9ydCBjb25zdCBPUEVOUk9VVEVSX1VSTCA9IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MS9jaGF0L2NvbXBsZXRpb25zXCI7XG5leHBvcnQgY29uc3QgREVGQVVMVF9NT0RFTCA9IFwiZ29vZ2xlL2dlbWluaS0zLjUtZmxhc2hcIjtcblxuLy8gQ29waWVkIHZlcmJhdGltIGZyb20gdGhlIFB5dGhvbiBvcmlnaW5hbCdzIFBST01QVCAodGhlIGRpc2NvdmVyeSBpbnN0cnVjdGlvbikuXG5leHBvcnQgY29uc3QgUFJPTVBUID0gYElkZW50aWZ5IGV2ZXJ5IGRpc3RpbmN0IGV4dHJhY3RhYmxlIHZpc3VhbCBlbGVtZW50IGluIHRoaXMgaW1hZ2UuIFwiRGlzdGluY3QgZXh0cmFjdGFibGVcIiBtZWFuczogYSBzaW5nbGUgdmlzdWFsbHktY29oZXJlbnQgYXNzZXQgYSBkZXNpZ25lciB3b3VsZCB3YW50IHRvIHB1bGwgb3V0IGFzIGl0cyBvd24gZmlsZSDigJQgYSBsb2dvLCBhbiBpY29uLCBhIHN0aWNrZXIsIGEgY29sb3Igc3dhdGNoIHJvdywgYSBwaWVjZSBvZiBjb3ZlciBhcnQsIGEgVUkgc2NyZWVuc2hvdC4gRG8gTk9UIGluY2x1ZGUgYmFja2dyb3VuZCwgdGV4dHVyZSwgb3Igc3Vycm91bmRpbmcgY2FudmFzLlxuXG5Gb3IgZWFjaCBlbGVtZW50LCByZXR1cm4gYSBib3VuZGluZyBib3ggdXNpbmcgR29vZ2xlJ3Mgbm9ybWFsaXplZCBjb29yZGluYXRlIHN5c3RlbSAoaW1hZ2UgaXMgWzAsIDEwMDBdIG9uIGJvdGggYXhlcywgMCwwIHRvcC1sZWZ0KSBpbiB0aGUgZG9jdW1lbnRlZCBvcmRlcjogW3lfbWluLCB4X21pbiwgeV9tYXgsIHhfbWF4XS5cblxuUmV0dXJuIE9OTFkgYSBKU09OIGFycmF5LCBubyBwcm9zZSwgaW4gdGhpcyBleGFjdCBzaGFwZTpcbltcbiAge1wibmFtZVwiOiBcIjxzaG9ydF9zbmFrZV9jYXNlX25hbWU+XCIsIFwidHlwZVwiOiBcIjxvbmUgb2Y6IHdvcmRtYXJrLCB0YWdsaW5lLCBpY29uLCBpbGx1c3RyYXRpb24sIHN0aWNrZXIsIHBhbGV0dGUsIHR5cG9ncmFwaHksIHNjcmVlbnNob3QsIG90aGVyPlwiLCBcImJveF8yZFwiOiBbeV9taW4sIHhfbWluLCB5X21heCwgeF9tYXhdfVxuXVxuXG5OYW1pbmcgcnVsZXM6XG4tIFVzZSBkaXN0aW5jdGl2ZSBzbmFrZV9jYXNlIG5hbWVzOyBpZiB0aGVyZSBhcmUgbXVsdGlwbGUgb2YgdGhlIHNhbWUga2luZCwgZGlmZmVyZW50aWF0ZSBkZXNjcmlwdGl2ZWx5IChpY29uX21hbW1vdGgsIGljb25fZ2Vhciwgc3RpY2tlcl9jb2ZmZWUsIHN0aWNrZXJfc2thdGVib2FyZCkuXG4tIFRoZSBcXGB0eXBlXFxgIGZpZWxkIGlzIGNyaXRpY2FsIOKAlCB0aGUgZXh0cmFjdCBzdGVwIHVzZXMgaXQgdG8gZGVjaWRlIHdoZXRoZXIgdG8gcnVuIGJhY2tncm91bmQgcmVtb3ZhbC5cbmA7XG5cbi8vIE9wZW5Sb3V0ZXIgdmlzaW9uIGVuZHBvaW50cyByZWplY3QgdmVyeSBsYXJnZSBwYXlsb2FkcyB3aXRoIGEgbm9uLWFjdGlvbmFibGVcbi8vIDR4eDsgYmFpbCB3aXRoIGEgY2xlYXJlciBlcnJvciBmaXJzdCAobWF0Y2hlcyB0aGUgUHl0aG9uIG9yaWdpbmFsKS5cbmV4cG9ydCBjb25zdCBNQVhfSU1BR0VfQllURVMgPSAzMCAqIDEwMjQgKiAxMDI0O1xuZXhwb3J0IGNvbnN0IFdBUk5fSU1BR0VfQllURVMgPSAxNSAqIDEwMjQgKiAxMDI0O1xuXG5jb25zdCBNSU1FX0JZX0VYVDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgXCIuanBnXCI6IFwiaW1hZ2UvanBlZ1wiLFxuICBcIi5qcGVnXCI6IFwiaW1hZ2UvanBlZ1wiLFxuICBcIi5wbmdcIjogXCJpbWFnZS9wbmdcIixcbiAgXCIud2VicFwiOiBcImltYWdlL3dlYnBcIixcbiAgXCIuZ2lmXCI6IFwiaW1hZ2UvZ2lmXCIsXG59O1xuXG4vLyDilIDilIAgbWFuaWZlc3Qgc2NoZW1hIChtaXJyb3JzIHRoZSBQeXRob24gbWFuaWZlc3QpIOKUgOKUgFxuZXhwb3J0IHR5cGUgTWFuaWZlc3RFbGVtZW50ID0ge1xuICBuYW1lOiBzdHJpbmc7XG4gIHR5cGU6IEVsZW1lbnRUeXBlO1xuICBib3hfMmQ6IG51bWJlcltdOyAvLyBHZW1pbmkncyBub3JtYWxpemVkIFt5X21pbiwgeF9taW4sIHlfbWF4LCB4X21heF0sIDAuLjEwMDBcbiAgYmJveF9waXhlbDogQmJveDsgLy8gW3gxLCB5MSwgeDIsIHkyXSBpbiBzb3VyY2UgcGl4ZWxzICh1c2VkIGJ5IGV4dHJhY3QpXG59O1xuZXhwb3J0IHR5cGUgTWFuaWZlc3QgPSB7XG4gIHNvdXJjZTogc3RyaW5nO1xuICBzb3VyY2Vfc2l6ZTogW251bWJlciwgbnVtYmVyXTtcbiAgc291cmNlX3NoYTI1Nl8xNjogc3RyaW5nO1xuICBtb2RlbDogc3RyaW5nO1xuICBjb3N0X3VzZDogbnVtYmVyO1xuICB0b2tlbnM6IHsgcHJvbXB0OiBudW1iZXI7IGNvbXBsZXRpb246IG51bWJlcjsgcmVhc29uaW5nOiBudW1iZXIgfTtcbiAgZWxlbWVudHM6IE1hbmlmZXN0RWxlbWVudFtdO1xufTtcblxuLy8gUmFpc2VkIGZvciBhY3Rpb25hYmxlIHVzZXItZmFjaW5nIGZhaWx1cmVzIChiYWQgaW1hZ2Ugc2l6ZSwgbWlzc2luZyBrZXksIEhUVFBcbi8vIGVycm9yKS4gVGhlIENMSSBlbnRyeSBtYXBzIGl0IHRvIGEgY2xlYW4gc3RkZXJyIGxpbmUgKyBleGl0IGNvZGUuXG5leHBvcnQgY2xhc3MgRGlzY292ZXJFcnJvciBleHRlbmRzIEVycm9yIHt9XG5cbi8vIOKUgOKUgCBwdXJlIGhlbHBlcnMgKHVuaXQtdGVzdGVkOyBubyBuZXR3b3JrL2Rpc2spIOKUgOKUgFxuXG4vLyBTdHJpcCBvcHRpb25hbCBgYGBqc29uIGZlbmNlcyBhbmQgcGFyc2UgdGhlIEpTT04gYXJyYXkuIE1pcnJvcnNcbi8vIHRoZSBQeXRob24gb3JpZ2luYWwncyBwYXJzZV9iYm94ZXMuXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VCYm94ZXMoY29udGVudDogc3RyaW5nKTogdW5rbm93bltdIHtcbiAgbGV0IHMgPSBjb250ZW50LnRyaW0oKTtcbiAgY29uc3QgZmVuY2UgPSAvYGBgKD86anNvbik/XFxzKihbXFxzXFxTXSo/KVxccypgYGAvLmV4ZWMocyk7XG4gIGlmIChmZW5jZSkgcyA9IGZlbmNlWzFdO1xuICByZXR1cm4gSlNPTi5wYXJzZShzKTtcbn1cblxuLy8gQ29udmVydCBHZW1pbmkncyBbeV9taW4sIHhfbWluLCB5X21heCwgeF9tYXhdICgwLi4xMDAwKSB0byBzb3VyY2UgcGl4ZWxzXG4vLyBbeDEsIHkxLCB4MiwgeTJdLCBjbGFtcGVkIHRvIGltYWdlIGJvdW5kcy4gUmVwbGljYXRlcyB0aGUgUHl0aG9uIG9yaWdpbmFsJ3Ncbi8vIG5vcm1hbGl6ZWRfdG9fcGl4ZWwgZm9ybXVsYSBleGFjdGx5LlxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZWRUb1BpeGVsKGJveDogbnVtYmVyW10sIHdpZHRoOiBudW1iZXIsIGhlaWdodDogbnVtYmVyKTogQmJveCB7XG4gIGNvbnN0IFt5MSwgeDEsIHkyLCB4Ml0gPSBib3g7XG4gIGNvbnN0IHB4MSA9IE1hdGgubWF4KDAsIE1hdGgucm91bmQoKHgxIC8gMTAwMCkgKiB3aWR0aCkpO1xuICBjb25zdCBweTEgPSBNYXRoLm1heCgwLCBNYXRoLnJvdW5kKCh5MSAvIDEwMDApICogaGVpZ2h0KSk7XG4gIGNvbnN0IHB4MiA9IE1hdGgubWluKHdpZHRoLCBNYXRoLnJvdW5kKCh4MiAvIDEwMDApICogd2lkdGgpKTtcbiAgY29uc3QgcHkyID0gTWF0aC5taW4oaGVpZ2h0LCBNYXRoLnJvdW5kKCh5MiAvIDEwMDApICogaGVpZ2h0KSk7XG4gIHJldHVybiBbcHgxLCBweTEsIHB4MiwgcHkyXTtcbn1cblxuLy8gQnVpbGQgdGhlIG1hbmlmZXN0IGBlbGVtZW50c1tdYCBmcm9tIHRoZSBtb2RlbCdzIHBhcnNlZCBhcnJheSArIGltYWdlIHNpemUuXG4vLyBTa2lwcyBlbnRyaWVzIG1pc3NpbmcgYSBuYW1lIG9yIGJveCAobWF0Y2hlcyB0aGUgUHl0aG9uIG9yaWdpbmFsJ3MgZmlsdGVyKS5cbmV4cG9ydCBmdW5jdGlvbiBlbGVtZW50c0Zyb21SYXcocmF3OiB1bmtub3duW10sIHdpZHRoOiBudW1iZXIsIGhlaWdodDogbnVtYmVyKTogTWFuaWZlc3RFbGVtZW50W10ge1xuICBjb25zdCBlbGVtZW50czogTWFuaWZlc3RFbGVtZW50W10gPSBbXTtcbiAgZm9yIChjb25zdCBlbnRyeSBvZiByYXcpIHtcbiAgICBpZiAoIWVudHJ5IHx8IHR5cGVvZiBlbnRyeSAhPT0gXCJvYmplY3RcIikgY29udGludWU7XG4gICAgY29uc3QgZSA9IGVudHJ5IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIGNvbnN0IG5hbWUgPSBlLm5hbWU7XG4gICAgY29uc3Qga2luZCA9ICh0eXBlb2YgZS50eXBlID09PSBcInN0cmluZ1wiID8gZS50eXBlIDogXCJvdGhlclwiKSBhcyBFbGVtZW50VHlwZTtcbiAgICBjb25zdCBib3ggPSBlLmJveF8yZDtcbiAgICBpZiAoIW5hbWUgfHwgdHlwZW9mIG5hbWUgIT09IFwic3RyaW5nXCIgfHwgIUFycmF5LmlzQXJyYXkoYm94KSkgY29udGludWU7XG4gICAgZWxlbWVudHMucHVzaCh7XG4gICAgICBuYW1lLFxuICAgICAgdHlwZToga2luZCxcbiAgICAgIGJveF8yZDogYm94IGFzIG51bWJlcltdLFxuICAgICAgYmJveF9waXhlbDogbm9ybWFsaXplZFRvUGl4ZWwoYm94IGFzIG51bWJlcltdLCB3aWR0aCwgaGVpZ2h0KSxcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gZWxlbWVudHM7XG59XG5cbi8vIOKUgOKUgCBpbWFnZSByZWFkICsgZW5jb2RlIOKUgOKUgFxuXG5leHBvcnQgZnVuY3Rpb24gbWltZUZvclBhdGgocGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIE1JTUVfQllfRVhUW2V4dG5hbWUocGF0aCkudG9Mb3dlckNhc2UoKV0gPz8gXCJpbWFnZS9wbmdcIjtcbn1cblxuLy8gUmVhZCBhbiBpbWFnZSBmaWxlIOKGkiBhIGJhc2U2NCBkYXRhIFVSTCwgZW5mb3JjaW5nIHRoZSBzaXplIGd1YXJkLiBUaHJvd3Ncbi8vIERpc2NvdmVyRXJyb3IgYWJvdmUgTUFYX0lNQUdFX0JZVEVTOyB3YXJucyAoc3RkZXJyKSBhYm92ZSBXQVJOX0lNQUdFX0JZVEVTLlxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGVuY29kZUltYWdlRGF0YVVybChwYXRoOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCBmaWxlID0gQnVuLmZpbGUocGF0aCk7XG4gIGNvbnN0IHNpemUgPSBmaWxlLnNpemU7XG4gIGlmIChzaXplID4gTUFYX0lNQUdFX0JZVEVTKSB7XG4gICAgY29uc3QgbWIgPSAoc2l6ZSAvIDFfMDQ4XzU3NikudG9GaXhlZCgxKTtcbiAgICBjb25zdCBsaW1pdCA9IE1hdGguZmxvb3IoTUFYX0lNQUdFX0JZVEVTIC8gMV8wNDhfNTc2KTtcbiAgICB0aHJvdyBuZXcgRGlzY292ZXJFcnJvcihcbiAgICAgIGAke3BhdGh9IGlzICR7bWJ9IE1CLCBhYm92ZSB0aGUgJHtsaW1pdH0gTUIgbGltaXQuIFJlc2l6ZSBiZWZvcmUgcmV0cnlpbmcgYCArXG4gICAgICAgIGAoZS5nLiBJbWFnZU1hZ2ljazogXFxgbWFnaWNrIGluLnBuZyAtcmVzaXplIDIwMDB4MjAwMFxcXFw+IG91dC5wbmdcXGApLmAsXG4gICAgKTtcbiAgfVxuICBpZiAoc2l6ZSA+IFdBUk5fSU1BR0VfQllURVMpIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgIGBXQVJOOiAke3BhdGh9IGlzICR7KHNpemUgLyAxXzA0OF81NzYpLnRvRml4ZWQoMSl9IE1COyBsYXJnZSByZXF1ZXN0cyBzb21ldGltZXMgaGl0IE9wZW5Sb3V0ZXIncyBwYXlsb2FkIGxpbWl0cy5cXG5gLFxuICAgICk7XG4gIH1cbiAgY29uc3QgYnl0ZXMgPSBuZXcgVWludDhBcnJheShhd2FpdCBmaWxlLmFycmF5QnVmZmVyKCkpO1xuICBjb25zdCBiNjQgPSBCdWZmZXIuZnJvbShieXRlcykudG9TdHJpbmcoXCJiYXNlNjRcIik7XG4gIHJldHVybiBgZGF0YToke21pbWVGb3JQYXRoKHBhdGgpfTtiYXNlNjQsJHtiNjR9YDtcbn1cblxuLy8gSW1hZ2UgcGl4ZWwgc2l6ZSB2aWEgQnVuLkltYWdlIG1ldGFkYXRhIChyZXBsYWNlcyB0aGUgUHl0aG9uIG9yaWdpbmFsJ3MgUGlsbG93IHJlYWQpLlxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGltYWdlU2l6ZShwYXRoOiBzdHJpbmcpOiBQcm9taXNlPFtudW1iZXIsIG51bWJlcl0+IHtcbiAgY29uc3QgYnl0ZXMgPSBuZXcgVWludDhBcnJheShhd2FpdCBCdW4uZmlsZShwYXRoKS5hcnJheUJ1ZmZlcigpKTtcbiAgY29uc3QgbWV0YSA9IGF3YWl0IG5ldyBCdW4uSW1hZ2UoYnl0ZXMpLm1ldGFkYXRhKCk7XG4gIHJldHVybiBbbWV0YS53aWR0aCA/PyAwLCBtZXRhLmhlaWdodCA/PyAwXTtcbn1cblxuLy8gRmlyc3QgMTYgY2hhcnMgb2YgdGhlIGZpbGUncyBzaGEyNTYgKG1hdGNoZXMgdGhlIFB5dGhvbiBvcmlnaW5hbCkuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc291cmNlU2hhMjU2XzE2KHBhdGg6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IGJ5dGVzID0gbmV3IFVpbnQ4QXJyYXkoYXdhaXQgQnVuLmZpbGUocGF0aCkuYXJyYXlCdWZmZXIoKSk7XG4gIHJldHVybiBuZXcgQnVuLkNyeXB0b0hhc2hlcihcInNoYTI1NlwiKS51cGRhdGUoYnl0ZXMpLmRpZ2VzdChcImhleFwiKS5zbGljZSgwLCAxNik7XG59XG5cbi8vIOKUgOKUgCBPcGVuUm91dGVyIGNhbGwg4pSA4pSAXG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjYWxsT3BlblJvdXRlcihcbiAgYXBpS2V5OiBzdHJpbmcsXG4gIG1vZGVsOiBzdHJpbmcsXG4gIGltYWdlRGF0YVVybDogc3RyaW5nLFxuICBwcm9tcHQ6IHN0cmluZyxcbik6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgY29uc3QgYm9keSA9IHtcbiAgICBtb2RlbCxcbiAgICBtZXNzYWdlczogW1xuICAgICAge1xuICAgICAgICByb2xlOiBcInVzZXJcIixcbiAgICAgICAgY29udGVudDogW1xuICAgICAgICAgIHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IHByb21wdCB9LFxuICAgICAgICAgIHsgdHlwZTogXCJpbWFnZV91cmxcIiwgaW1hZ2VfdXJsOiB7IHVybDogaW1hZ2VEYXRhVXJsIH0gfSxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgXSxcbiAgICB0ZW1wZXJhdHVyZTogMCxcbiAgfTtcbiAgY29uc3QgY3RybCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IGN0cmwuYWJvcnQoKSwgMTgwXzAwMCk7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goT1BFTlJPVVRFUl9VUkwsIHtcbiAgICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgICBoZWFkZXJzOiB7XG4gICAgICAgIEF1dGhvcml6YXRpb246IGBCZWFyZXIgJHthcGlLZXl9YCxcbiAgICAgICAgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIsXG4gICAgICAgIFwiSFRUUC1SZWZlcmVyXCI6IFwiaHR0cHM6Ly9naXRodWIuY29tL2ljaGFib2Rjb2xlL3NwZWxsYm9va1wiLFxuICAgICAgICBcIlgtVGl0bGVcIjogXCJtYWdwaWVcIixcbiAgICAgIH0sXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSxcbiAgICAgIHNpZ25hbDogY3RybC5zaWduYWwsXG4gICAgfSk7XG4gICAgaWYgKCFyZXMub2spIHtcbiAgICAgIGNvbnN0IHRleHQgPSBhd2FpdCByZXMudGV4dCgpLmNhdGNoKCgpID0+IFwiXCIpO1xuICAgICAgdGhyb3cgbmV3IERpc2NvdmVyRXJyb3IoYE9wZW5Sb3V0ZXIgSFRUUCAke3Jlcy5zdGF0dXN9OiAke3RleHR9YCk7XG4gICAgfVxuICAgIHJldHVybiAoYXdhaXQgcmVzLmpzb24oKSkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgfVxufVxuXG4vLyDilIDilIAgb3JjaGVzdHJhdGlvbiDilIDilIBcblxuZXhwb3J0IHR5cGUgRGlzY292ZXJPcHRpb25zID0geyBtb2RlbD86IHN0cmluZzsgYXBpS2V5Pzogc3RyaW5nIH07XG5cbi8vIEZ1bGwgZGlzY292ZXI6IHJlYWQgaW1hZ2UsIGNhbGwgdGhlIG1vZGVsLCBwYXJzZSwgYnVpbGQgdGhlIG1hbmlmZXN0LiBUaHJvd3Ncbi8vIERpc2NvdmVyRXJyb3Igb24gYWN0aW9uYWJsZSBmYWlsdXJlcyAobWlzc2luZyBrZXksIG92ZXJzaXplZCBpbWFnZSwgSFRUUCAvXG4vLyBwYXJzZSBlcnJvcnMpLiBUaGUgT1BFTlJPVVRFUl9BUElfS0VZIG11c3QgYmUgaW4gdGhlIGVudmlyb25tZW50IOKAlCB3ZSBuZXZlclxuLy8gaW5zdGFsbCBhIGtleS5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBkaXNjb3ZlcihpbWFnZVBhdGg6IHN0cmluZywgb3B0czogRGlzY292ZXJPcHRpb25zID0ge30pOiBQcm9taXNlPE1hbmlmZXN0PiB7XG4gIGNvbnN0IG1vZGVsID0gb3B0cy5tb2RlbCA/PyBERUZBVUxUX01PREVMO1xuICBjb25zdCBhcGlLZXkgPSBvcHRzLmFwaUtleSA/PyBwcm9jZXNzLmVudi5PUEVOUk9VVEVSX0FQSV9LRVk7XG4gIGlmICghYXBpS2V5KSB7XG4gICAgdGhyb3cgbmV3IERpc2NvdmVyRXJyb3IoXCJPUEVOUk9VVEVSX0FQSV9LRVkgZW52IHZhciBub3Qgc2V0XCIpO1xuICB9XG4gIGlmICghKGF3YWl0IEJ1bi5maWxlKGltYWdlUGF0aCkuZXhpc3RzKCkpKSB7XG4gICAgdGhyb3cgbmV3IERpc2NvdmVyRXJyb3IoYGltYWdlIG5vdCBmb3VuZDogJHtpbWFnZVBhdGh9YCk7XG4gIH1cblxuICBjb25zdCBbc2l6ZSwgZGF0YVVybCwgc2hhXSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICBpbWFnZVNpemUoaW1hZ2VQYXRoKSxcbiAgICBlbmNvZGVJbWFnZURhdGFVcmwoaW1hZ2VQYXRoKSxcbiAgICBzb3VyY2VTaGEyNTZfMTYoaW1hZ2VQYXRoKSxcbiAgXSk7XG4gIGNvbnN0IFt3aWR0aCwgaGVpZ2h0XSA9IHNpemU7XG5cbiAgY29uc3QgcmVzcCA9IGF3YWl0IGNhbGxPcGVuUm91dGVyKGFwaUtleSwgbW9kZWwsIGRhdGFVcmwsIFBST01QVCk7XG5cbiAgY29uc3QgY2hvaWNlcyA9IHJlc3AuY2hvaWNlcyBhcyBBcnJheTx7IG1lc3NhZ2U/OiB7IGNvbnRlbnQ/OiB1bmtub3duIH0gfT4gfCB1bmRlZmluZWQ7XG4gIGNvbnN0IGNvbnRlbnQgPSBjaG9pY2VzPy5bMF0/Lm1lc3NhZ2U/LmNvbnRlbnQ7XG4gIGlmICh0eXBlb2YgY29udGVudCAhPT0gXCJzdHJpbmdcIikge1xuICAgIHRocm93IG5ldyBEaXNjb3ZlckVycm9yKFxuICAgICAgYHVuZXhwZWN0ZWQgcmVzcG9uc2Ugc2hhcGUgZnJvbSBPcGVuUm91dGVyIChubyBjaG9pY2VzWzBdLm1lc3NhZ2UuY29udGVudCk6XFxuJHtKU09OLnN0cmluZ2lmeShyZXNwKS5zbGljZSgwLCAyMDAwKX1gLFxuICAgICk7XG4gIH1cblxuICBjb25zdCB1c2FnZSA9IChyZXNwLnVzYWdlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA/PyB7fTtcbiAgY29uc3QgY29zdCA9IHR5cGVvZiB1c2FnZS5jb3N0ID09PSBcIm51bWJlclwiID8gdXNhZ2UuY29zdCA6IDA7XG4gIGNvbnN0IHByb21wdFRva2VucyA9IHR5cGVvZiB1c2FnZS5wcm9tcHRfdG9rZW5zID09PSBcIm51bWJlclwiID8gdXNhZ2UucHJvbXB0X3Rva2VucyA6IDA7XG4gIGNvbnN0IGNvbXBsZXRpb25Ub2tlbnMgPVxuICAgIHR5cGVvZiB1c2FnZS5jb21wbGV0aW9uX3Rva2VucyA9PT0gXCJudW1iZXJcIiA/IHVzYWdlLmNvbXBsZXRpb25fdG9rZW5zIDogMDtcbiAgY29uc3QgZGV0YWlscyA9ICh1c2FnZS5jb21wbGV0aW9uX3Rva2Vuc19kZXRhaWxzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA/PyB7fTtcbiAgY29uc3QgcmVhc29uaW5nVG9rZW5zID1cbiAgICB0eXBlb2YgZGV0YWlscy5yZWFzb25pbmdfdG9rZW5zID09PSBcIm51bWJlclwiID8gZGV0YWlscy5yZWFzb25pbmdfdG9rZW5zIDogMDtcblxuICBsZXQgcmF3OiB1bmtub3duW107XG4gIHRyeSB7XG4gICAgcmF3ID0gcGFyc2VCYm94ZXMoY29udGVudCk7XG4gIH0gY2F0Y2ggKGV4KSB7XG4gICAgdGhyb3cgbmV3IERpc2NvdmVyRXJyb3IoXG4gICAgICBgbW9kZWwgcmV0dXJuZWQgbm9uLUpTT04gb3V0cHV0OlxcbiR7Y29udGVudH1cXG5cXG5QYXJzZSBlcnJvcjogJHtleCBpbnN0YW5jZW9mIEVycm9yID8gZXgubWVzc2FnZSA6IFN0cmluZyhleCl9YCxcbiAgICApO1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBzb3VyY2U6IHJlc29sdmUoaW1hZ2VQYXRoKSxcbiAgICBzb3VyY2Vfc2l6ZTogW3dpZHRoLCBoZWlnaHRdLFxuICAgIHNvdXJjZV9zaGEyNTZfMTY6IHNoYSxcbiAgICBtb2RlbCxcbiAgICBjb3N0X3VzZDogY29zdCxcbiAgICB0b2tlbnM6IHsgcHJvbXB0OiBwcm9tcHRUb2tlbnMsIGNvbXBsZXRpb246IGNvbXBsZXRpb25Ub2tlbnMsIHJlYXNvbmluZzogcmVhc29uaW5nVG9rZW5zIH0sXG4gICAgZWxlbWVudHM6IGVsZW1lbnRzRnJvbVJhdyhyYXcsIHdpZHRoLCBoZWlnaHQpLFxuICB9O1xufVxuXG4vLyDilIDilIAgQ0xJIGVudHJ5IChwYXJpdHkgd2l0aCB0aGUgUHl0aG9uIG9yaWdpbmFsKSDilIDilIBcbmFzeW5jIGZ1bmN0aW9uIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCB7IHBhcnNlQXJncyB9ID0gYXdhaXQgaW1wb3J0KFwibm9kZTp1dGlsXCIpO1xuICBsZXQgcGFyc2VkOiBSZXR1cm5UeXBlPHR5cGVvZiBwYXJzZUFyZ3M+O1xuICB0cnkge1xuICAgIHBhcnNlZCA9IHBhcnNlQXJncyh7XG4gICAgICBhcmdzOiBhcmd2LFxuICAgICAgb3B0aW9uczoge1xuICAgICAgICBvdXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICAgICAgICBtb2RlbDogeyB0eXBlOiBcInN0cmluZ1wiLCBkZWZhdWx0OiBERUZBVUxUX01PREVMIH0sXG4gICAgICB9LFxuICAgICAgYWxsb3dQb3NpdGlvbmFsczogdHJ1ZSxcbiAgICAgIHN0cmljdDogdHJ1ZSxcbiAgICB9KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBlcnJvcjogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9XFxuYCk7XG4gICAgcmV0dXJuIDI7XG4gIH1cbiAgY29uc3QgaW1hZ2VQYXRoID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdO1xuICBpZiAoIWltYWdlUGF0aCkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFwidXNhZ2U6IGRpc2NvdmVyLnRzIDxpbWFnZT4gWy0tb3V0IDxtYW5pZmVzdC5qc29uPl0gWy0tbW9kZWwgPG1vZGVsPl1cXG5cIik7XG4gICAgcmV0dXJuIDI7XG4gIH1cbiAgdHJ5IHtcbiAgICBjb25zdCBtYW5pZmVzdCA9IGF3YWl0IGRpc2NvdmVyKGltYWdlUGF0aCwgeyBtb2RlbDogcGFyc2VkLnZhbHVlcy5tb2RlbCBhcyBzdHJpbmcgfSk7XG4gICAgY29uc3Qgb3V0ID1cbiAgICAgIChwYXJzZWQudmFsdWVzLm91dCBhcyBzdHJpbmcgfCB1bmRlZmluZWQpID8/XG4gICAgICBqb2luKGRpcm5hbWUocmVzb2x2ZShpbWFnZVBhdGgpKSwgYCR7YmFzZVN0ZW0oaW1hZ2VQYXRoKX0tbWFuaWZlc3QuanNvbmApO1xuICAgIGF3YWl0IEJ1bi53cml0ZShvdXQsIEpTT04uc3RyaW5naWZ5KG1hbmlmZXN0LCBudWxsLCAyKSk7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgICBgRGlzY292ZXJlZCAke21hbmlmZXN0LmVsZW1lbnRzLmxlbmd0aH0gZWxlbWVudChzKSDigJQgY29zdCAkJHttYW5pZmVzdC5jb3N0X3VzZC50b0ZpeGVkKDQpfVxcbmAsXG4gICAgKTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgbWFuaWZlc3QuZWxlbWVudHMpIHtcbiAgICAgIGNvbnN0IFt4MSwgeTEsIHgyLCB5Ml0gPSBlLmJib3hfcGl4ZWw7XG4gICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgICAke2UudHlwZX0gICR7ZS5uYW1lfSAgc3JjPSgke3gxfSwke3kxfSwke3gyfSwke3kyfSlcXG5gKTtcbiAgICB9XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYE1hbmlmZXN0IHdyaXR0ZW46ICR7b3V0fVxcbmApO1xuICAgIHJldHVybiAwO1xuICB9IGNhdGNoIChlKSB7XG4gICAgaWYgKGUgaW5zdGFuY2VvZiBEaXNjb3ZlckVycm9yKSB7XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgRVJST1I6ICR7ZS5tZXNzYWdlfVxcbmApO1xuICAgICAgcmV0dXJuIDE7XG4gICAgfVxuICAgIHRocm93IGU7XG4gIH1cbn1cblxuZnVuY3Rpb24gYmFzZVN0ZW0ocGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgYmFzZSA9IHBhdGguc3BsaXQoXCIvXCIpLnBvcCgpID8/IHBhdGg7XG4gIGNvbnN0IGRvdCA9IGJhc2UubGFzdEluZGV4T2YoXCIuXCIpO1xuICByZXR1cm4gZG90ID4gMCA/IGJhc2Uuc2xpY2UoMCwgZG90KSA6IGJhc2U7XG59XG5cbmlmIChpbXBvcnQubWV0YS5tYWluKSB7XG4gIC8vIGBwcm9jZXNzLmV4aXRDb2RlYCArIGEgbmF0dXJhbCByZXR1cm4sIE5FVkVSIGBwcm9jZXNzLmV4aXQoY29kZSlgOiBCdW4nc1xuICAvLyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGEgcGlwZSAoc3luY2hyb25vdXMgb24gYSBUVFkgb3IgZmlsZSksIHNvIGFuXG4gIC8vIGV4cGxpY2l0IGV4aXQgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlCBtZWFzdXJlZCBhdCBleGFjdGx5XG4gIC8vIDY1LDUzNiBieXRlcy4gVGhlIHBheWxvYWQgaXMgY29tcGxldGUgYW5kIG9ubHkgdGhlIHdyaXRlIGlzIGxvc3QsIHNvIHRoZVxuICAvLyBjYWxsZXIgZ2V0cyB3ZWxsLWZvcm1lZC1sb29raW5nIEpTT04gdGhhdCBzdG9wcyBtaWQtc3RyaW5nLiBSZXByb2R1Y2VkLFxuICAvLyBmaXhlZCBhbmQgZ2F0ZWQgaW4gYm91bnR5IGZpcnN0IChQMCwgIzc3LyM3OCk7IHNhbWUgc2hhcGUsIHNhbWUgcmVhc29uLlxuICAvLyBEbyBub3QgdGlkeSB0aGlzIGJhY2sgaW50byBhbiBleHBsaWNpdCBleGl0LlxuICBwcm9jZXNzLmV4aXRDb2RlID0gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuIiwKICAgICIvLyBzaGFyZWQvdHlwZXMudHNcbi8vIFRoZSBzaW5nbGUgc2hhcmVkIGNvbnRyYWN0IGZvciBtYWdwaWUncyBjb25qdXJhdGlvbi4gSW1wb3J0ZWQgYnkgc2VydmVyLnRzLFxuLy8gcmVkdWNlLnRzLCBjbGkudHMsIEFORCB0aGUgUmVhY3QgY2xpZW50LlxuLy9cbi8vIG1hZ3BpZSAocmVidWlsdCkgaXMgYSBTVEFORElORyBSRVZJRVcgU1VSRkFDRSBvdmVyIGEgY29tcG9zaXRlIGltYWdlOiB0aGVcbi8vIGRhZW1vbiBob2xkcyB0aGUgZXh0cmFjdGlvbiBzdGF0ZSwgdGhlIFJlYWN0IHN1cmZhY2Ugc2hvd3MgdGhlIGVsZW1lbnRcbi8vIGJyZWFrZG93biwgYW5kIHRoZSB1c2VyIGp1ZGdlcyBlYWNoIGN1dG91dCwgY29tcGFyZXMgcmVtb3ZhbC1tb2RlbCByZXN1bHRzLFxuLy8gYW5kIHNlbGVjdGl2ZWx5IHJldHJpZXMuIFRoZSBhZ2VudCBkcml2ZXMgZGlzY292ZXJ5ICsgZXh0cmFjdGlvbjsgdGhlIHN1cmZhY2Vcbi8vIGlzIHdoZXJlIHRoZSB1c2VyIHN0ZWVycy5cbi8vXG4vLyBQUk9WSVNJT05BTCDigJQgdGhpcyBzdGF0ZSBzaGFwZSBpcyBhIGRlc2lnbi1pbmRlcGVuZGVudCBza2VsZXRvbi4gVGhlXG4vLyBtYWdwaWUtc3BlY2lmaWMgc3VyZmFjZSArIHRoZSBmaW5hbCBzZXR0bGVkIHNoYXBlIGFyZSBiZWluZyBkZXNpZ25lZCBpblxuLy8gcGFyYWxsZWwuIEV2ZXJ5dGhpbmcgbWFya2VkIGAvLyBUT0RPKG1vY2spOiDigKZgIGlzIGEgZGVsaWJlcmF0ZSBwbGFjZWhvbGRlciB0aGVcbi8vIG1vY2sgdHJhY2sgd2lsbCByZXBsYWNlOyBrZWVwIG11dGF0b3JzIChyZWR1Y2UudHMpIHRoaW4gYXJvdW5kIGl0LlxuXG4vLyBUaGUgZWxlbWVudCB0eXBlIHRheG9ub215IHBvcnRlZCBmcm9tIHRoZSBQeXRob24gb3JpZ2luYWwg4oCUIGRyaXZlcyB0aGUgKGZ1dHVyZSlcbi8vIGJhY2tncm91bmQtcmVtb3ZhbCBkZWNpc2lvbiBpbiBleHRyYWN0LlxuZXhwb3J0IHR5cGUgRWxlbWVudFR5cGUgPVxuICB8IFwid29yZG1hcmtcIlxuICB8IFwidGFnbGluZVwiXG4gIHwgXCJpY29uXCJcbiAgfCBcImlsbHVzdHJhdGlvblwiXG4gIHwgXCJzdGlja2VyXCJcbiAgfCBcInBhbGV0dGVcIlxuICB8IFwidHlwb2dyYXBoeVwiXG4gIHwgXCJzY3JlZW5zaG90XCJcbiAgfCBcIm90aGVyXCI7XG5cbmV4cG9ydCBjb25zdCBFTEVNRU5UX1RZUEVTOiByZWFkb25seSBFbGVtZW50VHlwZVtdID0gW1xuICBcIndvcmRtYXJrXCIsXG4gIFwidGFnbGluZVwiLFxuICBcImljb25cIixcbiAgXCJpbGx1c3RyYXRpb25cIixcbiAgXCJzdGlja2VyXCIsXG4gIFwicGFsZXR0ZVwiLFxuICBcInR5cG9ncmFwaHlcIixcbiAgXCJzY3JlZW5zaG90XCIsXG4gIFwib3RoZXJcIixcbl0gYXMgY29uc3Q7XG5cbi8vIFRoZSBsaW5lYXIgcHJvY2VzcyBzcGluZSAodGhlIHRvcC1iYXIgc3RlcHBlcikuIE9uZSBhY3RpdmUgcGhhc2UgYXQgYSB0aW1lO1xuLy8gdGhlIGN1cnNvciBhZHZhbmNlcyB3aGVuIHRoZSB1c2VyIHNlYWxzIGEgcGhhc2UuIFN0YXR1cyBpcyBERVJJVkVEIGZyb20gdGhlXG4vLyBjdXJzb3Ig4oCUIHBoYXNlcyBiZWZvcmUgaXQgYXJlIHNlYWxlZCwgdGhlIGN1cnNvciBpcyBhY3RpdmUsIGFmdGVyIGlzIHVwY29taW5nLlxuZXhwb3J0IHR5cGUgUGhhc2VLZXkgPSBcImludGFrZVwiIHwgXCJzbGljZVwiIHwgXCJyZW1vdmVcIiB8IFwiZXhwb3J0XCI7XG5leHBvcnQgY29uc3QgUEhBU0VTOiByZWFkb25seSBQaGFzZUtleVtdID0gW1wiaW50YWtlXCIsIFwic2xpY2VcIiwgXCJyZW1vdmVcIiwgXCJleHBvcnRcIl0gYXMgY29uc3Q7XG5cbi8vIEEgcGl4ZWwgYm91bmRpbmcgYm94IFt4MSwgeTEsIHgyLCB5Ml0gaW4gc291cmNlLWltYWdlIGNvb3JkaW5hdGVzIChtYXRjaGVzXG4vLyB0aGUgUHl0aG9uIG9yaWdpbmFsJ3MgYGJib3hfcGl4ZWxgKS5cbmV4cG9ydCB0eXBlIEJib3ggPSBbbnVtYmVyLCBudW1iZXIsIG51bWJlciwgbnVtYmVyXTtcblxuLy8gVGhlIGJhY2tkcm9wIHRoZSBzdXJmYWNlIHByZXZpZXdzIGN1dG91dHMgYWdhaW5zdCAoYSBjaGVja2VyIGZvciB0cmFuc3BhcmVudCkuXG5leHBvcnQgdHlwZSBCYWNrZHJvcCA9IFwid2hpdGVcIiB8IFwiZ3JheVwiIHwgXCJibGFja1wiIHwgXCJ0cmFuc3BhcmVudFwiO1xuXG4vLyBPbmUgZXh0cmFjdGFibGUgZWxlbWVudC4gTUlOSU1BTCBwcm92aXNpb25hbCBzaGFwZSDigJQgdGhlIHJldmlldy9qdWRnbWVudFxuLy8gbWFjaGluZXJ5IGlzIG1vY2tlZCBvdXQgZm9yIG5vdy4gYGJib3hgIGlzIGNhbm9uaWNhbCBpbiBTT1VSQ0UgUElYRUxTICh3aGF0XG4vLyBkaXNjb3ZlciBwcm9kdWNlcyBhbmQgY3JvcCBjb25zdW1lcyk7IHRoZSBjYW52YXMgY29udmVydHMgcHjihpRmcmFjdGlvbiB2aWFcbi8vIGBzb3VyY2Uuc2l6ZWAgZm9yIHJlbmRlcmluZy9lZGl0aW5nLlxuZXhwb3J0IHR5cGUgRWxlbWVudFN0YXR1cyA9IFwicHJvcG9zZWRcIiB8IFwiY29uZmlybWVkXCIgfCBcImRyb3BwZWRcIjtcblxuLy8gQSBwcm9kdWNlZCBhc3NldCBmb3Igb25lIGVsZW1lbnQ6IHRoZSByYXcgY3JvcCAobW9kZWw6XCJjcm9wXCIpIG9yIGEgcmVtb3ZhbFxuLy8gcmVzdWx0LiBgcGF0aGAgaXMgdGhlIG9uLWRpc2sgUE5HIHNlcnZlZCB2aWEgL2Fzc2V0czsgYHJldmAgYnVtcHMgb24gZXZlcnlcbi8vIChyZS0pcnVuIG9mIHRoZSBTQU1FIG1vZGVsIOKAlCB0aGUgZmlsZSBpcyBvdmVyd3JpdHRlbiBpbiBwbGFjZSwgc28gdGhlIHN1cmZhY2Vcbi8vIGFwcGVuZHMgP3Y9PHJldj4gdG8gYnVzdCB0aGUgYnJvd3NlciBjYWNoZS4gYGtpbmRgIGlzIGEgbGFiZWwtY2hpcCBoaW50IHRoZVxuLy8gYWdlbnQgc3VwcGxpZXM7IG5ldmVyIGluZmVycmVkIGluIHRoZSBVSS5cbmV4cG9ydCB0eXBlIEVsZW1lbnRWZXJzaW9uID0ge1xuICBpZDogc3RyaW5nO1xuICBtb2RlbDogc3RyaW5nOyAvLyBcImNyb3BcIiB8IFwicmVtYmdcIiB8IFwiYnJpYVwiIHwgXCJpZGVvZ3JhbVwiIHwg4oCmIChhZ2VudC1kZWZpbmVkKVxuICBraW5kPzogXCJyYXdcIiB8IFwibG9jYWxcIiB8IFwiY2xvdWRcIjtcbiAgcGF0aDogc3RyaW5nO1xuICByZXY6IG51bWJlcjtcbiAgbm90ZT86IHN0cmluZztcbn07XG5cbmV4cG9ydCB0eXBlIEVsZW1lbnQgPSB7XG4gIGlkOiBzdHJpbmc7XG4gIG5hbWU6IHN0cmluZztcbiAgdHlwZTogRWxlbWVudFR5cGU7XG4gIGJib3g6IEJib3g7XG4gIHN0YXR1czogRWxlbWVudFN0YXR1cztcbiAgLy8g4pSA4pSAIGV4dHJhY3Rpb24g4pSA4pSAXG4gIC8vIFByb2R1Y2VkIGFzc2V0cywgb25lIHJvdyBwZXIgbW9kZWwuIGNyb3AgPSB2ZXJzaW9uc1swXSAobW9kZWw6XCJjcm9wXCIpLlxuICAvLyBBYnNlbnQgdW50aWwgdGhlIGZpcnN0IGN1dDsgdHJlYXQgdW5kZWZpbmVkIGFzIFtdLiBUaGUgY2hvc2VuIHZlcnNpb24gaXNcbiAgLy8gd2hhdCB0aGUgcmFpbC9nYWxsZXJ5IHJlbmRlciAoY2hvc2VuVmVyc2lvbigpIGZhbGxzIGJhY2sgdG8gdmVyc2lvbnNbMF0pLlxuICB2ZXJzaW9ucz86IEVsZW1lbnRWZXJzaW9uW107XG4gIGNob3NlblZlcnNpb25JZD86IHN0cmluZztcbiAgLy8gVGhlIHNvbGUgcmV2aWV3IHNpZ25hbDogdGhlIHVzZXIgZmxhZ2dlZCB0aGlzIGVsZW1lbnQgdG8gYmUgcmUtcnVuIChyZS1zbGljZVxuICAvLyBpbiB0aGUgc2xpY2VzIHBoYXNlLCByZS1yZW1vdmUgaW4gdGhlIGJnIHBoYXNlKS4gQXBwcm92YWwgaXMgdGhlIEFCU0VOQ0Ugb2YgYVxuICAvLyBmbGFnOyBkaXNjYXJkaW5nIGlzIHN0YXR1czpcImRyb3BwZWRcIi4gQ2xlYXJlZCB3aGVuIGEgZnJlc2ggdmVyc2lvbiBsYW5kcy5cbiAgZmxhZ2dlZD86IGJvb2xlYW47XG59O1xuXG4vLyDilIDilIAgdGhlIGNvbnZlcnNhdGlvbiAodGhlIHNwaW5lLCBwb3J0ZWQgc2V0dGxlZCBmcm9tIGltYWdvKSDilIDilIBcbmV4cG9ydCB0eXBlIE1lc3NhZ2VLaW5kID1cbiAgfCBcInRleHRcIiAvLyBwbGFpbiBkaWFsb2d1ZSAoZWl0aGVyIHJvbGUpXG4gIHwgXCJnZXN0dXJlXCIgLy8gYSBzdXJmYWNlIGFjdGlvbiBzdXJmYWNlZCBhcyBhIG1lc3NhZ2UgKHVzZXIganVkZ2VkL3JldHJpZWQv4oCmKVxuICB8IFwicXVlc3Rpb25cIjsgLy8gYWdlbnQgbmVlZHMgdGhlIHVzZXIgKGFuIHVuYW5zd2VyZWQgb25lIOKGkiBcImFza2luZ1wiIHByZXNlbmNlKVxuXG5leHBvcnQgdHlwZSBNZXNzYWdlID0ge1xuICBpZDogc3RyaW5nO1xuICByb2xlOiBcInVzZXJcIiB8IFwiYWdlbnRcIjtcbiAga2luZDogTWVzc2FnZUtpbmQ7XG4gIHRleHQ6IHN0cmluZztcbiAgdHM6IG51bWJlcjtcbiAgLy8ga2luZDogXCJxdWVzdGlvblwiIOKAlCBvcHRpb25hbCBxdWljayByZXBsaWVzICh0aGUgZnVsbCBhbnN3ZXIgY2FuIGJlIGZyZWUgdGV4dClcbiAgb3B0aW9ucz86IHN0cmluZ1tdO1xuICAvLyBraW5kOiBcImdlc3R1cmVcIiDigJQgd2hhdCB0aGUgdXNlciBkaWQsIGFuZCB0byB3aGF0XG4gIGdlc3R1cmU/OiB7IGtpbmQ6IHN0cmluZzsgdGFyZ2V0SWQ/OiBzdHJpbmcgfTtcbiAgLy8gQW4gb3B0aW9uYWwgb25lLWNsaWNrIENUQSB0aGUgYWdlbnQgYXR0YWNoZXMgdG8gYSBtZXNzYWdlIOKAlCBhIFNIT1JUQ1VUIGZvciBhXG4gIC8vIGNvbnZlcnNhdGlvbmFsIGFjdCAodGhlIHVzZXIgY291bGQgaGF2ZSBqdXN0IHNhaWQgaXQpLiBDbGlja2luZyBkaXNwYXRjaGVzXG4gIC8vIGBjb21tYW5kYCAoZS5nLiB7IHR5cGU6IFwicGhhc2UuYWR2YW5jZVwiIH0pLiBDb252ZXJzYXRpb24gc3RheXMgdGhlIHByaW1hcnlcbiAgLy8gY2FwYWJpbGl0eTsgdGhpcyBpcyBzdWdhciBvbiB0b3AsIHN1cmZhY2VkIGJ5IHRoZSBhZ2VudCBhdCBpdHMgZGlzY3JldGlvbi5cbiAgYWN0aW9uPzogeyBsYWJlbDogc3RyaW5nOyBjb21tYW5kOiBDbGllbnRUb1NlcnZlciB9O1xufTtcblxuLy8gQSBib3ggYmVmb3JlIHRoZSBkYWVtb24gYXNzaWducyBpdCBhbiBpZCDigJQgZHJhd24gYnkgdGhlIHVzZXIgKFwibWFyayBhIG1pc3NlZFxuLy8gcmVnaW9uXCIpIG9yIGJ5IHRoZSBhZ2VudCBib3hpbmcgaW5jcmVtZW50YWxseS4gVGhlIGRhZW1vbiBmaWxscyBgaWRgIGFuZFxuLy8gZGVmYXVsdHMgbmFtZS90eXBlL3N0YXR1cyBvbiBlbGVtZW50LmFkZC5cbmV4cG9ydCB0eXBlIE5ld0VsZW1lbnQgPSB7XG4gIGJib3g6IEJib3g7XG4gIG5hbWU/OiBzdHJpbmc7XG4gIHR5cGU/OiBFbGVtZW50VHlwZTtcbiAgc3RhdHVzPzogRWxlbWVudFN0YXR1cztcbn07XG5cbi8vIFRoZSBzb3VyY2UgY29tcG9zaXRlIGltYWdlIHVuZGVyIHJldmlldy4gYHBhdGhgIGlzIHRoZSBvbi1kaXNrIGZpbGUgdGhlIGFnZW50XG4vLyByZWFkczsgYHNpemVgIGlzIFt3LCBoXSBpbiBweDsgYHNoYWAgaXMgdGhlIGZpcnN0LTE2IG9mIHRoZSBzaGEyNTYgKG1hdGNoZXNcbi8vIHRoZSBQeXRob24gb3JpZ2luYWwncyBgc291cmNlX3NoYTI1Nl8xNmApLlxuZXhwb3J0IHR5cGUgU291cmNlID0ge1xuICBwYXRoOiBzdHJpbmc7XG4gIHNpemU6IFtudW1iZXIsIG51bWJlcl07XG4gIHNoYTogc3RyaW5nO1xufTtcblxuLy8g4pSA4pSAIHRoZSB3aG9sZSBzdGF0ZSAoUFJPVklTSU9OQUwpIOKUgOKUgFxuZXhwb3J0IHR5cGUgTWFncGllU3RhdGUgPSB7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIGludGVudDogc3RyaW5nOyAvLyB3aGF0IHRoZSB1c2VyIHdhbnRzIG91dCBvZiB0aGlzIGJvYXJkIChmcmVlIHRleHQgdGhlIGFnZW50IHNldHMpXG4gIHBoYXNlOiBQaGFzZUtleTsgLy8gdGhlIGxpbmVhciBwcm9jZXNzIGN1cnNvciAoSW50YWtlIOKGkiBTbGljZSDihpIgUmVtb3ZlIOKGkiBFeHBvcnQpXG4gIHNvdXJjZTogU291cmNlIHwgbnVsbDtcbiAgZWxlbWVudHM6IEVsZW1lbnRbXTtcbiAgY29udmVyc2F0aW9uOiBNZXNzYWdlW107XG4gIGJhY2tkcm9wOiBCYWNrZHJvcDtcbiAgc3RhdHVzOiB7IGJ1c3k6IGJvb2xlYW47IHRleHQ6IHN0cmluZyB9O1xuICAvLyBUaGUgYnVpbHQgZXhwb3J0IGJ1bmRsZSAoRXhwb3J0IHBoYXNlKSwgaWYgYW55IOKAlCBzZXJ2ZWQgdmlhIC9hc3NldHMvPG5hbWU+LlxuICBidW5kbGU/OiB7IG5hbWU6IHN0cmluZzsgY291bnQ6IG51bWJlciB9O1xuICAvLyBUaGUgY3VycmVudCBzZXNzaW9uIGlkIChydW50aW1lOyB0aGUgZGFlbW9uIHNldHMgaXQgYXQgc3RhcnQsIE5PVCBwZXJzaXN0ZWQtXG4gIC8vIG1lYW5pbmdmdWwgc2luY2UgcmVzdG9yZSBtaW50cyBhIG5ldyBvbmUpIOKAlCBzaG93biBpbiBFeHBvcnQncyByZW9wZW4gaGludC5cbiAgc2Vzc2lvbklkPzogc3RyaW5nO1xufTtcblxuZXhwb3J0IGZ1bmN0aW9uIGRlZmF1bHRTdGF0ZSh0aXRsZTogc3RyaW5nKTogTWFncGllU3RhdGUge1xuICByZXR1cm4ge1xuICAgIHRpdGxlLFxuICAgIGludGVudDogXCJcIixcbiAgICBwaGFzZTogXCJpbnRha2VcIixcbiAgICBzb3VyY2U6IG51bGwsXG4gICAgZWxlbWVudHM6IFtdLFxuICAgIGNvbnZlcnNhdGlvbjogW10sXG4gICAgYmFja2Ryb3A6IFwidHJhbnNwYXJlbnRcIixcbiAgICBzdGF0dXM6IHsgYnVzeTogZmFsc2UsIHRleHQ6IFwiXCIgfSxcbiAgfTtcbn1cblxuLy8g4pSA4pSAIFNlcnZlciDihpIgYnJvd3NlciAoV2ViU29ja2V0KS4gVGhlIGJyb3dzZXIgaGFuZGxlcyBleGFjdGx5IHRoZXNlLiDilIDilIBcbmV4cG9ydCB0eXBlIFNlcnZlclRvQ2xpZW50ID1cbiAgfCB7IHR5cGU6IFwic3RhdGVcIjsgc3RhdGU6IE1hZ3BpZVN0YXRlIH1cbiAgfCB7IHR5cGU6IFwibWVzc2FnZVwiOyB0ZXh0OiBzdHJpbmcgfVxuICAvLyBhZ2VudCBwcmVzZW5jZSDigJQgaXMgYXQgbGVhc3Qgb25lIGFnZW50IHRhaWxpbmcgL2V2ZW50cyAod2F0Y2hpbmcgdGhlIGJvYXJkKT9cbiAgLy8gcHVzaGVkIG9uIGNoYW5nZSArIG9uIGJyb3dzZXIgY29ubmVjdDsgcnVudGltZS1vbmx5LCBuZXZlciBwZXJzaXN0ZWQgaW4gc3RhdGUuXG4gIHwgeyB0eXBlOiBcInByZXNlbmNlXCI7IGFnZW50OiBib29sZWFuIH1cbiAgfCB7IHR5cGU6IFwic3VibWl0XCIgfVxuICB8IHsgdHlwZTogXCJjYW5jZWxcIiB9O1xuXG4vLyDilIDilIAgQnJvd3NlciDihpIgc2VydmVyIChXZWJTb2NrZXQpLiBUaGUgY2xpZW50IHNlbmRzIGV4YWN0bHkgdGhlc2UuIOKUgOKUgFxuLy8gRWFjaCBlaXRoZXIgbXV0YXRlcyBzdGF0ZSAocmUtYnJvYWRjYXN0KSBhbmQvb3IgZW1pdHMgYW4gU1NFIGV2ZW50IHRoZSBhZ2VudFxuLy8gcmVhY3RzIHRvLlxuZXhwb3J0IHR5cGUgQ2xpZW50VG9TZXJ2ZXIgPVxuICB8IHsgdHlwZTogXCJzYXlcIjsgdGV4dDogc3RyaW5nIH0gLy8gdXNlciBwb3N0cyBhIG1lc3NhZ2UgLyBpbnN0cnVjdGlvblxuICB8IHsgdHlwZTogXCJzb3VyY2UuaW1wb3J0XCI7IG5hbWU6IHN0cmluZzsgZGF0YVVybDogc3RyaW5nIH0gLy8gdXNlciBkcm9wcGVkIGEgY29tcG9zaXRlIOKGkiBkYWVtb24gbWF0ZXJpYWxpemVzIGl0XG4gIHwgeyB0eXBlOiBcImVsZW1lbnQuYWRkXCI7IGVsZW1lbnQ6IE5ld0VsZW1lbnQgfSAvLyB1c2VyIGRyZXcgYSBtaXNzZWQgcmVnaW9uIG9uIHRoZSBjYW52YXNcbiAgfCB7IHR5cGU6IFwiZWxlbWVudC51cGRhdGVcIjsgaWQ6IHN0cmluZzsgcGF0Y2g6IFBhcnRpYWw8RWxlbWVudD4gfSAvLyBtb3ZlIC8gcmVzaXplIC8gcmVuYW1lIC8gcmV0eXBlXG4gIHwgeyB0eXBlOiBcImVsZW1lbnQucmVtb3ZlXCI7IGlkOiBzdHJpbmcgfSAvLyBoYXJkLWRlbGV0ZSBhIGJveCAodXN1YWxseSBhIHVzZXItZHJhd24gb25lKVxuICB8IHsgdHlwZTogXCJlbGVtZW50Lmp1ZGdlXCI7IGlkOiBzdHJpbmc7IHN0YXR1czogRWxlbWVudFN0YXR1cyB9IC8vIHNvZnQgY29uZmlybS9kcm9wIGEgZGlzY292ZXJlZCBlbGVtZW50XG4gIHwgeyB0eXBlOiBcImV4dHJhY3RcIjsgaWRzPzogc3RyaW5nW10gfSAvLyBjdXQgc2xpY2VzIGZvciBhbGwgY29uZmlybWVkIGVsZW1lbnRzLCBvciBhIHN1YnNldCAocmUtY3V0KVxuICB8IHsgdHlwZTogXCJlbGVtZW50LmZsYWdcIjsgaWQ6IHN0cmluZzsgZmxhZ2dlZDogYm9vbGVhbiB9IC8vIGZsYWcvdW5mbGFnIGZvciByZS1ydW4gKHJlLXNsaWNlIG9yIHJlLXJlbW92ZSlcbiAgfCB7IHR5cGU6IFwidmVyc2lvbi5jaG9vc2VcIjsgaWQ6IHN0cmluZzsgdmVyc2lvbklkOiBzdHJpbmcgfSAvLyB1c2VyIHBpY2tlZCBhIHZlcnNpb24g4oaSIGl0IGJlY29tZXMgY2hvc2VuIChhbWJpZW50KVxuICB8IHsgdHlwZTogXCJyZW1vdmVCZ1wiOyBpZHM/OiBzdHJpbmdbXSB9IC8vIHJlbW92ZSBiYWNrZ3JvdW5kcyBmb3IgdGhlc2UgYWxwaGEtZWxpZ2libGUgZWxlbWVudHMgKGFic2VudCDihpIgYWxsIGVsaWdpYmxlKVxuICB8IHsgdHlwZTogXCJyZXRyeVJlbW92YWxcIjsgaWRzOiBzdHJpbmdbXSB9IC8vIFwidHJ5IGEgZGlmZmVyZW50IHJlbW92YWxcIiDigJQgYWdlbnQgcGlja3MgYW4gVU5VU0VEIG1vZGVsOyBwYXlsb2FkIGlzIGlkcyBvbmx5XG4gIHwgeyB0eXBlOiBcImJhY2tkcm9wLnNldFwiOyBiYWNrZHJvcDogQmFja2Ryb3AgfSAvLyBhbWJpZW50IHByZXZpZXcgYmFja2Ryb3BcbiAgfCB7IHR5cGU6IFwicGhhc2UuYWR2YW5jZVwiIH0gLy8gc2VhbCB0aGUgYWN0aXZlIHBoYXNlLCBtb3ZlIHRoZSBjdXJzb3IgdG8gdGhlIG5leHQgKGltcGVyYXRpdmUgaGFuZC1vZmYpXG4gIHwgeyB0eXBlOiBcInBoYXNlLnNldFwiOyBwaGFzZTogUGhhc2VLZXkgfSAvLyBiYWNrLW5hdiAvIGp1bXAgdG8gYSBwaGFzZSAoYW1iaWVudClcbiAgfCB7IHR5cGU6IFwiZXhwb3J0XCI7IGlkcz86IHN0cmluZ1tdIH0gLy8gYnVpbGQgdGhlIGRvd25sb2FkYWJsZSBhc3NldCBidW5kbGUgKGNob3NlbiB2ZXJzaW9ucyBvZiB0aGVzZSAvIGFsbCBub24tZHJvcHBlZClcbiAgfCB7IHR5cGU6IFwic3VibWl0XCIgfVxuICB8IHsgdHlwZTogXCJjYW5jZWxcIiB9O1xuXG4vLyDilIDilIAgQWdlbnQg4oaSIHNlcnZlciAoUE9TVCAvY21kKS4gVGhlIGFnZW50IGRyaXZlcyB0aGUgZGFlbW9uIHdpdGggZXhhY3RseSB0aGVzZS4g4pSA4pSAXG5leHBvcnQgdHlwZSBBZ2VudENvbW1hbmQgPVxuICB8IHsgdHlwZTogXCJpbml0XCI7IHRpdGxlPzogc3RyaW5nOyBpbnRlbnQ/OiBzdHJpbmcgfVxuICB8IHtcbiAgICAgIHR5cGU6IFwic2F5XCI7XG4gICAgICB0ZXh0OiBzdHJpbmc7XG4gICAgICBhY3Rpb24/OiB7IGxhYmVsOiBzdHJpbmc7IGNvbW1hbmQ6IENsaWVudFRvU2VydmVyIH07XG4gICAgfSAvLyBwb3N0IGFnZW50IGRpYWxvZ3VlIChraW5kOlwidGV4dFwiKTsgb3B0aW9uYWwgaW5saW5lIENUQSBzaG9ydGN1dFxuICB8IHsgdHlwZTogXCJhc2tcIjsgdGV4dDogc3RyaW5nOyBvcHRpb25zPzogc3RyaW5nW10gfSAvLyBwb3N0IGFuIGluLXRocmVhZCBxdWVzdGlvblxuICB8IHsgdHlwZTogXCJzb3VyY2Uuc2V0XCI7IHBhdGg6IHN0cmluZzsgc2l6ZTogW251bWJlciwgbnVtYmVyXTsgc2hhOiBzdHJpbmcgfSAvLyB0aGUgY29tcG9zaXRlIHVuZGVyIHJldmlld1xuICB8IHsgdHlwZTogXCJlbGVtZW50cy5zZXRcIjsgZWxlbWVudHM6IEVsZW1lbnRbXSB9IC8vIHBvc3QgdGhlIGRpc2NvdmVyZWQgYnJlYWtkb3duXG4gIHwgeyB0eXBlOiBcImVsZW1lbnQuYWRkXCI7IGVsZW1lbnQ6IE5ld0VsZW1lbnQgfSAvLyBhZ2VudCBib3hlcyBhIHJlZ2lvbiBpbmNyZW1lbnRhbGx5XG4gIHwgeyB0eXBlOiBcImVsZW1lbnQudXBkYXRlXCI7IGlkOiBzdHJpbmc7IHBhdGNoOiBQYXJ0aWFsPEVsZW1lbnQ+IH0gLy8gbW92ZS9yZXNpemUvcmVuYW1lL3JldHlwZSAodmVyc2lvbnMgYXBwZW5kIHZpYSBlbGVtZW50LmFkZFZlcnNpb24pXG4gIHwgeyB0eXBlOiBcImVsZW1lbnQucmVtb3ZlXCI7IGlkOiBzdHJpbmcgfSAvLyBhZ2VudCByZXRyYWN0cyBhIGJveFxuICB8IHsgdHlwZTogXCJlbGVtZW50LmFkZFZlcnNpb25cIjsgaWQ6IHN0cmluZzsgdmVyc2lvbjogRWxlbWVudFZlcnNpb247IGNob29zZT86IGJvb2xlYW4gfSAvLyBhZ2VudCBhcHBlbmRzIGEgcHJvZHVjZWQgdmVyc2lvblxuICB8IHsgdHlwZTogXCJwaGFzZS5zZXRcIjsgcGhhc2U6IFBoYXNlS2V5IH0gLy8gYWdlbnQgYWR2YW5jZXMvbW92ZXMgdGhlIGN1cnNvciBvbiB0aGUgdXNlcidzIGNvbnZlcnNhdGlvbmFsIHJlcXVlc3RcbiAgfCB7IHR5cGU6IFwiYnVuZGxlLnNldFwiOyBuYW1lOiBzdHJpbmc7IGNvdW50OiBudW1iZXIgfSAvLyBhZ2VudCBwb3N0cyB0aGUgYnVpbHQgZXhwb3J0IGJ1bmRsZSAoc2VydmVkIHZpYSAvYXNzZXRzLzxuYW1lPilcbiAgfCB7IHR5cGU6IFwic3RhdHVzXCI7IGJ1c3k6IGJvb2xlYW47IHRleHQ/OiBzdHJpbmcgfVxuICB8IHsgdHlwZTogXCJjbG9zZVwiIH07XG5cbi8vIFRoZSBhZ2VudCBldmVudCBzZXQgKHNlcnZlciDihpIgYWdlbnQgU1NFKSDigJQgSU1QRVJBVElWRVMgT05MWTogdGhlIG1vdmVzIHdoZXJlXG4vLyB0aGUgdXNlciAqaGFuZHMgd29yayB0byB0aGUgYWdlbnQqLCBwbHVzIGxpZmVjeWNsZS4gQW1iaWVudCBlZGl0aW5nIG9mIHRoZVxuLy8gYnJlYWtkb3duIGlzIGRlbGliZXJhdGVseSBOT1QgaGVyZSDigJQgYm94IG1vdmUvcmVzaXplL3JlbmFtZS9yZXR5cGVcbi8vIChlbGVtZW50LnVwZGF0ZSksIGRyYXcgKGVsZW1lbnQuYWRkKSwgZGVsZXRlIChlbGVtZW50LnJlbW92ZSksIGNvbmZpcm0vZHJvcFxuLy8gKGVsZW1lbnQuanVkZ2UpLCByZS1ydW4gZmxhZyAoZWxlbWVudC5mbGFnKSwgdmVyc2lvbiBwaWNrICh2ZXJzaW9uLmNob29zZSksIGFuZFxuLy8gYmFja2Ryb3AgYXJlIGFsbCByZWFjaGFibGUgZnJvbSAvc3RhdGUsIHdoaWNoIHRoZSBhZ2VudCByZWFkcyBhdCB0aGUgbW9tZW50IGFuXG4vLyBpbXBlcmF0aXZlIGZpcmVzLiBQdXNoaW5nIGVhY2ggZWRpdCB3b3VsZCBqdXN0IG5hcnJhdGUgdGhlIHVzZXIncyBidXN5IHdvcmsuXG4vLyBUaGUgaW1wZXJhdGl2ZXM6IGBzYXlgLCBgc291cmNlLmFkZGVkYCAo4oaSIGRpc2NvdmVyKSwgYGV4dHJhY3RgICjihpIgY3V0IHRoZVxuLy8gY3VycmVudCBib3hlcyksIGByZW1vdmVCZ2AgKOKGkiByZW1vdmUgYmFja2dyb3VuZHMsIGFnZW50IHBpY2tzIHRoZSBtb2RlbCksXG4vLyBgcmV0cnlSZW1vdmFsYCAo4oaSIHRyeSBhIGRpZmZlcmVudCByZW1vdmFsLCBhZ2VudCBwaWNrcyBhbiB1bnVzZWQgbW9kZWwpLFxuLy8gYHBoYXNlLmFkdmFuY2VgICjihpIgdXNlciBzZWFsZWQgYSBwaGFzZTsgYSBoYW5kLW9mZiB0byB0aGUgbmV4dCBsZWcpLFxuLy8gYHBoYXNlLnNldGAgKOKGkiB1c2VyIHN0ZXBwZWQgQkFDSyB0byBhIHBoYXNlIOKAlCBub3QgYW4gYWN0aW9uIHRvIHRha2UsIGJ1dFxuLy8gY29udGV4dCBmb3Igd2hhdCdzIGNvbWluZywgZS5nLiByZS1jdXRzKSwgYHN1Ym1pdGAsICsgbGlmZWN5Y2xlLiBBIHBoYXNlIHN3aXRjaFxuLy8gaXMgYSBkZWxpYmVyYXRlIHJlbG9jYXRpb24sIE5PVCBhbWJpZW50IGVkaXRpbmcg4oCUIHNvIGJvdGggZGlyZWN0aW9ucyBhcmUgcHVzaGVkLlxuZXhwb3J0IGNvbnN0IEFHRU5UX0VWRU5UX1RZUEVTID0gT2JqZWN0LmZyZWV6ZShbXG4gIFwicmVhZHlcIixcbiAgXCJjb25uZWN0ZWRcIixcbiAgXCJkaXNjb25uZWN0ZWRcIixcbiAgXCJzYXlcIixcbiAgXCJzb3VyY2UuYWRkZWRcIiwgLy8gdXNlciBkcm9wcGVkIGEgY29tcG9zaXRlIOKAlCB0aGUgYWdlbnQgcnVucyBkaXNjb3ZlciBvbiBpdFxuICBcImV4dHJhY3RcIiwgLy8gdXNlciBhc2tlZCB0byAocmUtKWN1dCDigJQgdGhlIGFnZW50IHJlYWRzIHRoZSBib3hlcyBmcm9tIC9zdGF0ZVxuICBcInJlbW92ZUJnXCIsIC8vIHVzZXIgYXNrZWQgdG8gcmVtb3ZlIGJhY2tncm91bmRzIOKAlCB0aGUgYWdlbnQgcGlja3MgdGhlIG1vZGVsXG4gIFwicmV0cnlSZW1vdmFsXCIsIC8vIHVzZXIgYXNrZWQgdG8gdHJ5IGEgZGlmZmVyZW50IHJlbW92YWwg4oCUIHRoZSBhZ2VudCBwaWNrcyBhbiBVTlVTRUQgbW9kZWxcbiAgXCJwaGFzZS5hZHZhbmNlXCIsIC8vIHVzZXIgc2VhbGVkIHRoZSBhY3RpdmUgcGhhc2Ug4oCUIGEgaGFuZC1vZmYgdG8gdGhlIG5leHQgbGVnIG9mIHdvcmtcbiAgXCJwaGFzZS5zZXRcIiwgLy8gdXNlciBzdGVwcGVkIEJBQ0sgdG8gYSBwaGFzZSDigJQgY29udGV4dCAocmUtY3V0cyBsaWtlbHkpLCBubyBhY3Rpb24gcmVxdWlyZWRcbiAgXCJleHBvcnRcIiwgLy8gdXNlciBhc2tlZCB0byBidWlsZCB0aGUgZG93bmxvYWRhYmxlIGFzc2V0IGJ1bmRsZSDigJQgdGhlIGFnZW50IHppcHMgaXRcbiAgXCJzdWJtaXRcIixcbiAgXCJjbG9zZWRcIixcbl0gYXMgY29uc3QpO1xuZXhwb3J0IHR5cGUgQWdlbnRFdmVudFR5cGUgPSAodHlwZW9mIEFHRU5UX0VWRU5UX1RZUEVTKVtudW1iZXJdO1xuXG4vLyBUeXBlZCBwYXlsb2FkcyBmb3IgdGhlIGV2ZW50cyB0aGF0IGNhcnJ5IGRhdGEuXG5leHBvcnQgdHlwZSBBZ2VudEV2ZW50UGF5bG9hZCA9IHtcbiAgc2F5OiB7IHRleHQ6IHN0cmluZyB9O1xuICBcInNvdXJjZS5hZGRlZFwiOiB7IHBhdGg6IHN0cmluZzsgc2l6ZTogW251bWJlciwgbnVtYmVyXTsgc2hhOiBzdHJpbmcgfTtcbiAgZXh0cmFjdDogeyBpZHM/OiBzdHJpbmdbXSB9OyAvLyB3aGljaCBlbGVtZW50cyB0byAocmUtKWN1dDsgYWJzZW50IOKGkiBhbGwgY29uZmlybWVkXG4gIHJlbW92ZUJnOiB7IGlkcz86IHN0cmluZ1tdIH07IC8vIHdoaWNoIGVsZW1lbnRzIHRvIHJlbW92ZSBiZyBmb3I7IGFic2VudCDihpIgYWxsIGVsaWdpYmxlXG4gIHJldHJ5UmVtb3ZhbDogeyBpZHM6IHN0cmluZ1tdIH07IC8vIHdoaWNoIChmbGFnZ2VkKSBlbGVtZW50cyB0byByZS1yZW1vdmU7IG1vZGVsIGlzIHRoZSBhZ2VudCdzIGNhbGxcbiAgXCJwaGFzZS5hZHZhbmNlXCI6IHsgcGhhc2U6IFBoYXNlS2V5IH07IC8vIHRoZSBORVcgcGhhc2UgdGhlIHVzZXIgYWR2YW5jZWQgdG9cbiAgXCJwaGFzZS5zZXRcIjogeyBwaGFzZTogUGhhc2VLZXkgfTsgLy8gdGhlIHBoYXNlIHRoZSB1c2VyIHN0ZXBwZWQgYmFjayB0b1xuICBleHBvcnQ6IHsgaWRzPzogc3RyaW5nW10gfTsgLy8gd2hpY2ggZWxlbWVudHMgdG8gYnVuZGxlIChhYnNlbnQg4oaSIGFsbCBub24tZHJvcHBlZClcbn07XG4iLAogICAgIi8vIHNjcmlwdHMvcmVkdWNlLnRzXG4vLyBQdXJlLCBpbi1wbGFjZSBtdXRhdG9ycyBvdmVyIE1hZ3BpZVN0YXRlICsgdGhlIGxlYW4gcHJvamVjdGlvbi4gVGhlIGRhZW1vblxuLy8gKHNlcnZlci50cykgb3JjaGVzdHJhdGVzIHRoZXNlIChpdCBvd25zIGlkcywgYnJvYWRjYXN0LCBTU0UpOyB0aGVzZSBmdW5jdGlvbnNcbi8vIGp1c3QgbXV0YXRlIGNhbm9uaWNhbCBzdGF0ZSBhbmQgcmVwb3J0IHdoZXRoZXIgYW55dGhpbmcgY2hhbmdlZCwgc28gdGhleSdyZVxuLy8gdW5pdC10ZXN0YWJsZSB3aXRoIG5vIHN1YnByb2Nlc3MuIEtlZXAgdGhlbSBUSElOIOKAlCB0aGUgbWFncGllLXNwZWNpZmljIHJldmlld1xuLy8gbWFjaGluZXJ5IChqdWRnbWVudCwgY3V0b3V0cykgaXMgbW9ja2VkIG91dCBmb3Igbm93OyB3aWRlbiB0aGVzZSBhcyBpdCBsYW5kcy5cblxuaW1wb3J0IHtcbiAgdHlwZSBCYWNrZHJvcCxcbiAgdHlwZSBFbGVtZW50LFxuICB0eXBlIEVsZW1lbnRTdGF0dXMsXG4gIHR5cGUgRWxlbWVudFZlcnNpb24sXG4gIHR5cGUgTWFncGllU3RhdGUsXG4gIHR5cGUgTWVzc2FnZSxcbiAgdHlwZSBOZXdFbGVtZW50LFxuICBQSEFTRVMsXG4gIHR5cGUgUGhhc2VLZXksXG4gIHR5cGUgU291cmNlLFxufSBmcm9tIFwiLi4vc2hhcmVkL3R5cGVzXCI7XG5cbi8vIOKUgOKUgCBpZCBoZWxwZXJzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuZnVuY3Rpb24gcmFuZEhleChieXRlczogbnVtYmVyKTogc3RyaW5nIHtcbiAgY29uc3QgYnVmID0gbmV3IFVpbnQ4QXJyYXkoYnl0ZXMpO1xuICBjcnlwdG8uZ2V0UmFuZG9tVmFsdWVzKGJ1Zik7XG4gIHJldHVybiBBcnJheS5mcm9tKGJ1ZiwgKGIpID0+IGIudG9TdHJpbmcoMTYpLnBhZFN0YXJ0KDIsIFwiMFwiKSkuam9pbihcIlwiKTtcbn1cbmV4cG9ydCBmdW5jdGlvbiBuZXdJZChwcmVmaXg6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtwcmVmaXh9LSR7cmFuZEhleCg0KX1gO1xufVxuXG4vLyDilIDilIAgbXV0YXRvcnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmV4cG9ydCBmdW5jdGlvbiBwdXNoTWVzc2FnZShcbiAgczogTWFncGllU3RhdGUsXG4gIG06IE9taXQ8TWVzc2FnZSwgXCJpZFwiIHwgXCJ0c1wiPiAmIHsgaWQ/OiBzdHJpbmcgfSxcbik6IE1lc3NhZ2Uge1xuICBjb25zdCBtc2c6IE1lc3NhZ2UgPSB7IGlkOiBtLmlkID8/IG5ld0lkKFwibVwiKSwgdHM6IERhdGUubm93KCksIC4uLm0gfSBhcyBNZXNzYWdlO1xuICBzLmNvbnZlcnNhdGlvbi5wdXNoKG1zZyk7XG4gIHJldHVybiBtc2c7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRTdGF0dXMoczogTWFncGllU3RhdGUsIGJ1c3k6IGJvb2xlYW4sIHRleHQgPSBcIlwiKTogdm9pZCB7XG4gIHMuc3RhdHVzID0geyBidXN5LCB0ZXh0IH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRJbnRlbnQoczogTWFncGllU3RhdGUsIGludGVudDogc3RyaW5nKTogdm9pZCB7XG4gIHMuaW50ZW50ID0gaW50ZW50O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2V0U291cmNlKHM6IE1hZ3BpZVN0YXRlLCBzb3VyY2U6IFNvdXJjZSk6IHZvaWQge1xuICBzLnNvdXJjZSA9IHNvdXJjZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNldEVsZW1lbnRzKHM6IE1hZ3BpZVN0YXRlLCBlbGVtZW50czogRWxlbWVudFtdKTogdm9pZCB7XG4gIC8vIFRydXN0IHRoZSBhZ2VudCdzIGRpc2NvdmVyZWQgYnJlYWtkb3duIHdob2xlc2FsZTsgZGVmYXVsdCBhbnkgbWlzc2luZ1xuICAvLyBzdGF0dXMgdG8gXCJwcm9wb3NlZFwiIHNvIHRoZSBzdXJmYWNlIGFsd2F5cyBoYXMgYSBqdWRnZWFibGUgZWxlbWVudCwgYW5kXG4gIC8vIChkZWZlbnNpdmVseSkgbWludCBhbiBpZCBmb3IgYW55IGVsZW1lbnQgcG9zdGVkIHdpdGhvdXQgb25lIOKAlCBkaXNjb3ZlclxuICAvLyBhc3NpZ25zIGlkcywgYnV0IGEgaGFuZC1yb2xsZWQgYGVsZW1lbnRzLnNldGAgYm9keSBtaWdodCBub3QuXG4gIHMuZWxlbWVudHMgPSBlbGVtZW50cy5tYXAoKGUpID0+ICh7XG4gICAgLi4uZSxcbiAgICBpZDogZS5pZCB8fCBuZXdJZChcImVcIiksXG4gICAgc3RhdHVzOiBlLnN0YXR1cyA/PyBcInByb3Bvc2VkXCIsXG4gIH0pKTtcbn1cblxuLy8gRGVmYXVsdCBuYW1lIGZvciBhbiB1bm5hbWVkIGRyYXduIHJlZ2lvbjogcmVnaW9uXzxuPiwgd2hlcmUgbiBpcyBvbmUgcGFzdCB0aGVcbi8vIGNvdW50IG9mIGV4aXN0aW5nIHJlZ2lvbl9cXGQrIG5hbWVzIChzbyBhIGRlbGV0ZS10aGVuLWRyYXcgZG9lc24ndCBjb2xsaWRlIHdpdGhcbi8vIGEgbGl2ZSBvbmUg4oCUIGl0IG51bWJlcnMgb2ZmIHRoZSBjdXJyZW50IHBvcHVsYXRpb24sIHRoZSBjaGVhcCBob3VzZSBoZXVyaXN0aWMpLlxuY29uc3QgUkVHSU9OX1JFID0gL15yZWdpb25fXFxkKyQvO1xuZnVuY3Rpb24gbmV4dFJlZ2lvbk5hbWUoczogTWFncGllU3RhdGUpOiBzdHJpbmcge1xuICBjb25zdCBuID0gcy5lbGVtZW50cy5maWx0ZXIoKGUpID0+IFJFR0lPTl9SRS50ZXN0KGUubmFtZSkpLmxlbmd0aCArIDE7XG4gIHJldHVybiBgcmVnaW9uXyR7bn1gO1xufVxuXG4vLyBBZGQgYSB1c2VyLWRyYXduIChvciBhZ2VudC1ib3hlZCkgcmVnaW9uOiBtaW50IGFuIGlkLCBkZWZhdWx0IG5hbWUvdHlwZS9zdGF0dXMuXG4vLyBSZXR1cm5zIHRoZSBtYXRlcmlhbGl6ZWQgRWxlbWVudCAodGhlIGRhZW1vbiBlbWl0cyBpdCBvbiB0aGUgU1NFL2Jyb2FkY2FzdCkuXG5leHBvcnQgZnVuY3Rpb24gYWRkRWxlbWVudChzOiBNYWdwaWVTdGF0ZSwgZHJhZnQ6IE5ld0VsZW1lbnQpOiBFbGVtZW50IHtcbiAgY29uc3QgZWw6IEVsZW1lbnQgPSB7XG4gICAgaWQ6IG5ld0lkKFwiZVwiKSxcbiAgICBuYW1lOiBkcmFmdC5uYW1lIHx8IG5leHRSZWdpb25OYW1lKHMpLFxuICAgIHR5cGU6IGRyYWZ0LnR5cGUgPz8gXCJvdGhlclwiLFxuICAgIGJib3g6IGRyYWZ0LmJib3gsXG4gICAgc3RhdHVzOiBkcmFmdC5zdGF0dXMgPz8gXCJjb25maXJtZWRcIixcbiAgfTtcbiAgcy5lbGVtZW50cy5wdXNoKGVsKTtcbiAgcmV0dXJuIGVsO1xufVxuXG4vLyBIYXJkLWRlbGV0ZSBhbiBlbGVtZW50IGJ5IGlkIChhIHVzZXIgcmV0cmFjdGluZyBhIGRyYXduIGJveCkuIFJldHVybnMgd2hldGhlclxuLy8gaXQgZXhpc3RlZC5cbmV4cG9ydCBmdW5jdGlvbiByZW1vdmVFbGVtZW50KHM6IE1hZ3BpZVN0YXRlLCBpZDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGkgPSBzLmVsZW1lbnRzLmZpbmRJbmRleCgoZSkgPT4gZS5pZCA9PT0gaWQpO1xuICBpZiAoaSA8IDApIHJldHVybiBmYWxzZTtcbiAgcy5lbGVtZW50cy5zcGxpY2UoaSwgMSk7XG4gIHJldHVybiB0cnVlO1xufVxuXG4vLyBQYXJ0aWFsLW1lcmdlIGFuIGVsZW1lbnQgKHRoZSBhZ2VudCBwb3N0aW5nIG5hbWUvdHlwZS9iYm94L3N0YXR1cyBlZGl0cyBsYW5kc1xuLy8gaGVyZSkuIE5ldmVyIGxldHMgYGlkYCBiZSBvdmVyd3JpdHRlbi4gUmV0dXJucyB0cnVlIGlmIHRoZSBlbGVtZW50IGV4aXN0ZWQuXG4vLyBWZXJzaW9uIHJlc3VsdHMgZG8gTk9UIGZsb3cgdGhyb3VnaCBoZXJlIOKAlCB0aGV5IGFwcGVuZCB2aWEgYWRkVmVyc2lvbiAoYSBsaXN0XG4vLyBvcCwgbm90IGEgZmllbGQgbWVyZ2UpLlxuZXhwb3J0IGZ1bmN0aW9uIHVwZGF0ZUVsZW1lbnQoczogTWFncGllU3RhdGUsIGlkOiBzdHJpbmcsIHBhdGNoOiBQYXJ0aWFsPEVsZW1lbnQ+KTogYm9vbGVhbiB7XG4gIGNvbnN0IGVsID0gcy5lbGVtZW50cy5maW5kKChlKSA9PiBlLmlkID09PSBpZCk7XG4gIGlmICghZWwpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgeyBpZDogX2Ryb3AsIC4uLnJlc3QgfSA9IHBhdGNoO1xuICBPYmplY3QuYXNzaWduKGVsLCByZXN0KTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmNvbnN0IEVMRU1FTlRfU1RBVFVTRVM6IHJlYWRvbmx5IEVsZW1lbnRTdGF0dXNbXSA9IFtcInByb3Bvc2VkXCIsIFwiY29uZmlybWVkXCIsIFwiZHJvcHBlZFwiXTtcblxuZXhwb3J0IGZ1bmN0aW9uIGp1ZGdlRWxlbWVudChzOiBNYWdwaWVTdGF0ZSwgaWQ6IHN0cmluZywgc3RhdHVzOiBFbGVtZW50U3RhdHVzKTogYm9vbGVhbiB7XG4gIGlmICghRUxFTUVOVF9TVEFUVVNFUy5pbmNsdWRlcyhzdGF0dXMpKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGVsID0gcy5lbGVtZW50cy5maW5kKChlKSA9PiBlLmlkID09PSBpZCk7XG4gIGlmICghZWwgfHwgZWwuc3RhdHVzID09PSBzdGF0dXMpIHJldHVybiBmYWxzZTtcbiAgZWwuc3RhdHVzID0gc3RhdHVzO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuLy8gRmxhZyAob3IgdW5mbGFnKSBhbiBlbGVtZW50IGZvciBhIHJlLXJ1biDigJQgdGhlIHNvbGUgcmV2aWV3IHNpZ25hbC4gQXBwcm92YWwgaXNcbi8vIHRoZSBhYnNlbmNlIG9mIGEgZmxhZzsgZGlzY2FyZGluZyBpcyBzdGF0dXM6XCJkcm9wcGVkXCIuIFJldHVybnMgd2hldGhlciB0aGUgZmxhZ1xuLy8gYWN0dWFsbHkgY2hhbmdlZCAodGhlIGRhZW1vbiBvbmx5IGJyb2FkY2FzdHMgb24gYSBjaGFuZ2UpLlxuZXhwb3J0IGZ1bmN0aW9uIGZsYWdFbGVtZW50KHM6IE1hZ3BpZVN0YXRlLCBpZDogc3RyaW5nLCBmbGFnZ2VkOiBib29sZWFuKTogYm9vbGVhbiB7XG4gIGNvbnN0IGVsID0gcy5lbGVtZW50cy5maW5kKChlKSA9PiBlLmlkID09PSBpZCk7XG4gIGlmICghZWwpIHJldHVybiBmYWxzZTtcbiAgaWYgKChlbC5mbGFnZ2VkID8/IGZhbHNlKSA9PT0gZmxhZ2dlZCkgcmV0dXJuIGZhbHNlO1xuICBlbC5mbGFnZ2VkID0gZmxhZ2dlZDtcbiAgcmV0dXJuIHRydWU7XG59XG5cbi8vIEFwcGVuZCBhIHByb2R1Y2VkIHZlcnNpb24sIFVQU0VSVElORyBieSBtb2RlbDogcmUtcnVubmluZyB0aGUgc2FtZSBtb2RlbFxuLy8gb3ZlcndyaXRlcyBpdHMgcGF0aCArIGJ1bXBzIHJldiAoY2FjaGUtYnVzdCkgYW5kIGtlZXBzIHRoZSBzdGFibGUgaWQ7IGEgbmV3XG4vLyBtb2RlbCBhcHBlbmRzIGEgcm93LiBBIGZyZXNoIHJlc3VsdCBjbGVhcnMgYGZsYWdnZWRgICh0aGUgcmVxdWVzdCBpcyBmdWxmaWxsZWQpXG4vLyBhbmQg4oCUIHVubGVzcyB7IGNob29zZTpmYWxzZSB9IOKAlCBiZWNvbWVzIHRoZSBjaG9zZW4gdmVyc2lvbi4gUmV0dXJucyB0aGUgc3RvcmVkXG4vLyB2ZXJzaW9uLCBvciBudWxsIGlmIHRoZSBlbGVtZW50IGlzIGdvbmUuXG5leHBvcnQgZnVuY3Rpb24gYWRkVmVyc2lvbihcbiAgczogTWFncGllU3RhdGUsXG4gIGlkOiBzdHJpbmcsXG4gIHY6IEVsZW1lbnRWZXJzaW9uLFxuICBvcHRzOiB7IGNob29zZT86IGJvb2xlYW4gfSA9IHt9LFxuKTogRWxlbWVudFZlcnNpb24gfCBudWxsIHtcbiAgY29uc3QgZWwgPSBzLmVsZW1lbnRzLmZpbmQoKGUpID0+IGUuaWQgPT09IGlkKTtcbiAgaWYgKCFlbCkgcmV0dXJuIG51bGw7XG4gIGlmICghZWwudmVyc2lvbnMpIGVsLnZlcnNpb25zID0gW107XG4gIGNvbnN0IGV4aXN0aW5nID0gZWwudmVyc2lvbnMuZmluZCgoeCkgPT4geC5tb2RlbCA9PT0gdi5tb2RlbCk7XG4gIGxldCBzdG9yZWQ6IEVsZW1lbnRWZXJzaW9uO1xuICBpZiAoZXhpc3RpbmcpIHtcbiAgICBleGlzdGluZy5wYXRoID0gdi5wYXRoO1xuICAgIGV4aXN0aW5nLnJldiA9IChleGlzdGluZy5yZXYgPz8gMCkgKyAxO1xuICAgIGlmICh2LmtpbmQgIT09IHVuZGVmaW5lZCkgZXhpc3Rpbmcua2luZCA9IHYua2luZDtcbiAgICBpZiAodi5ub3RlICE9PSB1bmRlZmluZWQpIGV4aXN0aW5nLm5vdGUgPSB2Lm5vdGU7XG4gICAgc3RvcmVkID0gZXhpc3Rpbmc7XG4gIH0gZWxzZSB7XG4gICAgc3RvcmVkID0geyAuLi52LCByZXY6IHYucmV2ID8/IDAgfTtcbiAgICBlbC52ZXJzaW9ucy5wdXNoKHN0b3JlZCk7XG4gIH1cbiAgaWYgKG9wdHMuY2hvb3NlID8/IHRydWUpIGVsLmNob3NlblZlcnNpb25JZCA9IHN0b3JlZC5pZDtcbiAgZWwuZmxhZ2dlZCA9IGZhbHNlO1xuICByZXR1cm4gc3RvcmVkO1xufVxuXG4vLyBUaGUgdXNlciBzZWxlY3RpbmcgYSB2ZXJzaW9uIOKGkiBpdCBiZWNvbWVzIGNob3NlbiAoYW1iaWVudCkuIFJldHVybnMgd2hldGhlciBpdFxuLy8gY2hhbmdlZDsgcmVqZWN0cyBhbiB1bmtub3duIGVsZW1lbnQgb3IgYSB2ZXJzaW9uSWQgbm90IHByZXNlbnQgb24gaXQuXG5leHBvcnQgZnVuY3Rpb24gY2hvb3NlVmVyc2lvbihzOiBNYWdwaWVTdGF0ZSwgaWQ6IHN0cmluZywgdmVyc2lvbklkOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgZWwgPSBzLmVsZW1lbnRzLmZpbmQoKGUpID0+IGUuaWQgPT09IGlkKTtcbiAgaWYgKCFlbCB8fCAhKGVsLnZlcnNpb25zID8/IFtdKS5zb21lKCh2KSA9PiB2LmlkID09PSB2ZXJzaW9uSWQpKSByZXR1cm4gZmFsc2U7XG4gIGlmIChlbC5jaG9zZW5WZXJzaW9uSWQgPT09IHZlcnNpb25JZCkgcmV0dXJuIGZhbHNlO1xuICBlbC5jaG9zZW5WZXJzaW9uSWQgPSB2ZXJzaW9uSWQ7XG4gIHJldHVybiB0cnVlO1xufVxuXG5jb25zdCBCQUNLRFJPUFM6IHJlYWRvbmx5IEJhY2tkcm9wW10gPSBbXCJ3aGl0ZVwiLCBcImdyYXlcIiwgXCJibGFja1wiLCBcInRyYW5zcGFyZW50XCJdO1xuXG5leHBvcnQgZnVuY3Rpb24gc2V0QmFja2Ryb3AoczogTWFncGllU3RhdGUsIGJhY2tkcm9wOiBCYWNrZHJvcCk6IGJvb2xlYW4ge1xuICBpZiAoIUJBQ0tEUk9QUy5pbmNsdWRlcyhiYWNrZHJvcCkgfHwgcy5iYWNrZHJvcCA9PT0gYmFja2Ryb3ApIHJldHVybiBmYWxzZTtcbiAgcy5iYWNrZHJvcCA9IGJhY2tkcm9wO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuLy8g4pSA4pSAIHBoYXNlIHNwaW5lIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4vLyBBZHZhbmNlIHRoZSBsaW5lYXIgcGhhc2UgY3Vyc29yIHRvIHRoZSBuZXh0IHBoYXNlIOKAlCB3aGF0IHRoZSBzZWFsLWFuZC1oYW5kLW9mZlxuLy8gZ2F0ZSBmaXJlcy4gUmV0dXJucyB0aGUgbmV3IHBoYXNlLCBvciBudWxsIGlmIGFscmVhZHkgYXQgdGhlIGxhc3QgKG5vLW9wKS5cbmV4cG9ydCBmdW5jdGlvbiBhZHZhbmNlUGhhc2UoczogTWFncGllU3RhdGUpOiBQaGFzZUtleSB8IG51bGwge1xuICBjb25zdCBpID0gUEhBU0VTLmluZGV4T2Yocy5waGFzZSk7XG4gIGlmIChpIDwgMCB8fCBpID49IFBIQVNFUy5sZW5ndGggLSAxKSByZXR1cm4gbnVsbDtcbiAgcy5waGFzZSA9IFBIQVNFU1tpICsgMV07XG4gIHJldHVybiBzLnBoYXNlO1xufVxuXG4vLyBTZXQgdGhlIHBoYXNlIGN1cnNvciBkaXJlY3RseSAoYmFjay1uYXYgLyBqdW1wKS4gVmFsaWRhdGVzIGFnYWluc3QgUEhBU0VTO1xuLy8gcmVwb3J0cyB3aGV0aGVyIGl0IGNoYW5nZWQuXG5leHBvcnQgZnVuY3Rpb24gc2V0UGhhc2UoczogTWFncGllU3RhdGUsIHBoYXNlOiBQaGFzZUtleSk6IGJvb2xlYW4ge1xuICBpZiAoIVBIQVNFUy5pbmNsdWRlcyhwaGFzZSkgfHwgcy5waGFzZSA9PT0gcGhhc2UpIHJldHVybiBmYWxzZTtcbiAgcy5waGFzZSA9IHBoYXNlO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuLy8gUmVjb3JkIHRoZSBidWlsdCBleHBvcnQgYnVuZGxlICh0aGUgYWdlbnQgcG9zdHMgaXQgYWZ0ZXIgemlwcGluZykuIFRoZSBzdXJmYWNlXG4vLyBvZmZlcnMgaXQgYXMgYSBkb3dubG9hZCB2aWEgL2Fzc2V0cy88bmFtZT4uXG5leHBvcnQgZnVuY3Rpb24gc2V0QnVuZGxlKHM6IE1hZ3BpZVN0YXRlLCBuYW1lOiBzdHJpbmcsIGNvdW50OiBudW1iZXIpOiB2b2lkIHtcbiAgcy5idW5kbGUgPSB7IG5hbWUsIGNvdW50IH07XG59XG5cbi8vIOKUgOKUgCBsZWFuIHByb2plY3Rpb24g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vLyBTdHJpcCBhbnkgKGV2ZW50dWFsbHkgaGVhdnkpIGlubGluZWQgYmxvYnMgZnJvbSB0aGUgYWdlbnQtZmFjaW5nIC9zdGF0ZSBzbyB0aGVcbi8vIHNuYXBzaG90IHN0YXlzIHNtYWxsOyB0aGUgYWdlbnQgcmVhZHMgb24tZGlzayB2ZXJzaW9uIHBhdGhzIGluc3RlYWQuIFZlcnNpb25zXG4vLyBjYXJyeSBvbmx5IGBwYXRoYCAobm90IGlubGluZWQgaW1hZ2UgZGF0YSksIHNvIHRoaXMgaXMgbmVhci1pZGVudGl0eSDigJQgYnV0IGl0XG4vLyBkZWZlbnNpdmVseSBkcm9wcyBhbnkgYHNyY2AvYGN1dG91dHNgIGZpZWxkcyBhbiBlbGVtZW50IG1pZ2h0IGlubGluZSwgYW5kIG5ldmVyXG4vLyBtdXRhdGVzIHRoZSBzb3VyY2Ugc3RhdGUuXG5leHBvcnQgZnVuY3Rpb24gbGVhblN0YXRlKHM6IE1hZ3BpZVN0YXRlKTogTWFncGllU3RhdGUge1xuICByZXR1cm4ge1xuICAgIC4uLnMsXG4gICAgZWxlbWVudHM6IHMuZWxlbWVudHMubWFwKChlKSA9PiB7XG4gICAgICBjb25zdCBsZWFuID0geyAuLi5lIH0gYXMgRWxlbWVudCAmIHsgc3JjPzogdW5rbm93bjsgY3V0b3V0cz86IHVua25vd24gfTtcbiAgICAgIGRlbGV0ZSBsZWFuLnNyYztcbiAgICAgIGRlbGV0ZSBsZWFuLmN1dG91dHM7XG4gICAgICByZXR1cm4gbGVhbjtcbiAgICB9KSxcbiAgfTtcbn1cbiIsCiAgICAiLy8gc2hhcmVkL3ZlcnNpb25zLnRzXG4vLyBQdXJlIHZlcnNpb24gaGVscGVycyBzaGFyZWQgYnkgdGhlIGJhY2tlbmQgQ0xJIChzcmMvbWFncGllL2JhY2tlbmQvY2xpLnRzLFxuLy8gd2hpY2ggcmVhZHMgY2hvc2VuVmVyc2lvbiBmb3IgZXhwb3J0KSBBTkQgdGhlIFJlYWN0IGNsaWVudCAoTWFncGllU2hlbGwsXG4vLyBFeHBvcnRWaWV3LCBSZW1vdmVHYWxsZXJ5KS4gc2VydmVyLnRzIGRvZXMgTk9UIGltcG9ydCB0aGVtIOKAlCB0aGUgZGFlbW9uLXNpZGVcbi8vIGNvbnN1bWVyIGlzIHRoZSBDTEksIGFuZCB0aGF0IGlzIHdoYXQgbWFrZXMgdGhpcyB0d28tc2lkZWQuIE5vIG5vZGU6KiDigJQga2VlcFxuLy8gYnJvd3Nlci1zYWZlLiBBbiBlbGVtZW50J3MgcHJvZHVjZWQgYXNzZXRzIGFyZSBhIG1vZGVsLXRhZ2dlZCBsaXN0ICh2ZXJzaW9uc1tdKTtcbi8vIHRoZXNlIHJlc29sdmUgXCJ3aGljaCBvbmUgaXMgc2hvd25cIiBhbmQgXCJpdHMgY2FjaGUtYnVzdGVkIFVSTFwiLlxuXG5pbXBvcnQgdHlwZSB7IEVsZW1lbnQsIEVsZW1lbnRWZXJzaW9uIH0gZnJvbSBcIi4vdHlwZXNcIjtcblxuLy8gVGhlIHZlcnNpb24gdGhlIHN1cmZhY2UgcmVuZGVyczogdGhlIGV4cGxpY2l0bHkgY2hvc2VuIG9uZSwgZWxzZSB0aGUgZmlyc3Rcbi8vICh0aGUgY3JvcCkuIFRvbGVyYXRlcyBhbiBhYnNlbnQvZW1wdHkgbGlzdCBhbmQgYSBzdGFsZSBjaG9zZW5WZXJzaW9uSWQuXG5leHBvcnQgZnVuY3Rpb24gY2hvc2VuVmVyc2lvbihlbDogRWxlbWVudCk6IEVsZW1lbnRWZXJzaW9uIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgdnMgPSBlbC52ZXJzaW9ucyA/PyBbXTtcbiAgcmV0dXJuIHZzLmZpbmQoKHYpID0+IHYuaWQgPT09IGVsLmNob3NlblZlcnNpb25JZCkgPz8gdnNbMF07XG59XG5cbi8vIFRoZSAvYXNzZXRzIFVSTCBmb3IgYSB2ZXJzaW9uLCBjYWNoZS1idXN0ZWQgYnkgaXRzIHJldi4gQSByZS1ydW4gb3ZlcndyaXRlcyB0aGVcbi8vIGZpbGUgaW4gcGxhY2UsIHNvIHdpdGhvdXQgP3Y9PHJldj4gdGhlIGJyb3dzZXIgc2hvd3MgdGhlIHN0YWxlIGNhY2hlZCBpbWFnZS5cbmV4cG9ydCBmdW5jdGlvbiB2ZXJzaW9uVXJsKHY6IEVsZW1lbnRWZXJzaW9uKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAvYXNzZXRzLyR7di5wYXRoLnNwbGl0KFwiL1wiKS5wb3AoKX0/dj0ke3YucmV2ID8/IDB9YDtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBvbmUtbGluZSBKU09OIGVtaXR0ZXIg4oCUIE9ORSBpbXBsZW1lbnRhdGlvbiwgaW1wb3J0ZWQgYnkgZXZlcnlcbiAqIHNwZWxsIHRoYXQgc3BlYWtzIHRoZSBhZ2VudCB3aXJlLlxuICpcbiAqIOKblCBUSElTIEZJTEUgSVMgYHNyYy9raXQvYCdzIEZJUlNUIElOSEFCSVRBTlQsIGFuZCB0aGF0IGlzIGxvYWQtYmVhcmluZyBiZXlvbmRcbiAqIHRoZSBzaGFyaW5nIGl0IGRvZXMuIFdhcmQgMiAoXCJ0aGUga2l0IGlzIGEgbGVhZlwiKSBoYXMgYmVlbiBncmVlbiBieVxuICogQ09OU1RSVUNUSU9OIHNpbmNlIFBoYXNlIDAg4oCUIGl0IGhhZCBub3RoaW5nIHRvIHdhbGssIGFuZCBzYWlkIHNvIG9uIGV2ZXJ5XG4gKiBydW4uIFRoaXMgbW9kdWxlIGlzIHRoZSBmaXJzdCB0aGluZyBpdCBhY3R1YWxseSBndWFyZHMsIHdoaWNoIGlzIHdoeSB0aGVcbiAqIHdhcmQncyB6ZXJvLWd1YXJkIGNlbGwgZGlzdGluZ3Vpc2hlcyBhbiBBQlNFTlQga2l0IGZyb20gYW4gRU1QVFkgb25lLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIG5vdCBhIHNwZWxsLFxuICogbm90IGEgc3VyZmFjZSwgbm90IGEgYmFja2VuZC4gVGhhdCBpcyB3YXJkIDIncyBhc3NlcnRpb24sIG5vdCBhIGNvbnZlbnRpb24sXG4gKiBhbmQgaXQgaXMgd2hhdCBtYWtlcyB0aGUga2l0IHNhZmUgdG8gaW5saW5lIGludG8gYW55IHNwZWxsJ3MgYnVuZGxlLlxuICpcbiAqIERlbGliZXJhdGVseSBkZXBlbmRlbmN5LWZyZWUgYW5kIGRlbGliZXJhdGVseSBkdWxsOiBpdCBpcyBidW5kbGVkIElOVE8gZWFjaFxuICogc3BlbGwncyBlbWl0dGVkIENMSSAoQ29udHJhY3QgNCdzIGJ1aWx0LWJhY2tlbmQgYW1lbmRtZW50KSwgc28gYW55dGhpbmcgaXRcbiAqIHJlYWNoZWQgZm9yIHdvdWxkIGJlY29tZSBhIGRlcGVuZGVuY3kgb2YgdHdvIHNoaXBwZWQgYXJ0aWZhY3RzIGF0IG9uY2UuXG4gKlxuICogVGhlIHdpcmUgY29udHJhY3QgaXQgZW5jb2RlczogZXhhY3RseSBvbmUgSlNPTiBkb2N1bWVudCwgb25lIHRyYWlsaW5nXG4gKiBuZXdsaW5lLCBub3RoaW5nIGVsc2Ugb24gc3Rkb3V0LiBBIGNhbGxlciByZWFkaW5nIG91ciBzdGRvdXQgd2l0aCBhXG4gKiBsaW5lLWRlbGltaXRlZCBwYXJzZXIgZGVwZW5kcyBvbiB0aGF0IG5ld2xpbmU7IGEgY2FsbGVyIHJlYWRpbmcgdG8gRU9GXG4gKiBkZXBlbmRzIG9uIHRoZXJlIGJlaW5nIG5vIHNlY29uZCBkb2N1bWVudC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByaW50SnNvbihkYXRhOiB1bmtub3duKTogdm9pZCB7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGRhdGEpfVxcbmApO1xufVxuIgogIF0sCiAgIm1hcHBpbmdzIjogIjs7OztBQXdCQTtBQUNBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBVUE7QUFDQSw4QkFBbUIsa0JBQVM7QUFDNUI7QUFDQSxzQkFBUzs7O0FDM0JUOzs7QUNETyxJQUFNLG1CQUE2QyxJQUFJLElBQUk7QUFBQSxFQUNoRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUNGLENBQUM7QUFHTSxJQUFNLHdCQUFrRCxJQUFJLElBQUk7QUFBQSxFQUNyRTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQ0YsQ0FBQztBQUlNLFNBQVMsWUFBWSxDQUFDLE1BQWMsUUFBOEI7QUFBQSxFQUN2RSxJQUFJLFdBQVc7QUFBQSxJQUFRLE9BQU87QUFBQSxFQUM5QixJQUFJLFdBQVc7QUFBQSxJQUFPLE9BQU8sQ0FBQyxzQkFBc0IsSUFBSSxJQUFtQjtBQUFBLEVBQzNFLE9BQU8saUJBQWlCLElBQUksSUFBbUI7QUFBQTs7O0FEaUNqRCxJQUFNLFlBQVksS0FBSyxZQUFZLEtBQUssV0FBVztBQUVuRCxTQUFTLE9BQU8sQ0FBQyxRQUF3QjtBQUFBLEVBQ3ZDLE1BQU0sTUFBTSxJQUFJLFdBQVcsQ0FBQztBQUFBLEVBQzVCLE9BQU8sZ0JBQWdCLEdBQUc7QUFBQSxFQUMxQixNQUFNLE1BQU0sTUFBTSxLQUFLLEtBQUssQ0FBQyxNQUFNLEVBQUUsU0FBUyxFQUFFLEVBQUUsU0FBUyxHQUFHLEdBQUcsQ0FBQyxFQUFFLEtBQUssRUFBRTtBQUFBLEVBQzNFLE9BQU8sR0FBRyxVQUFVO0FBQUE7QUFNZixJQUFNLGVBQStCO0FBQUEsRUFDMUMsTUFBTTtBQUFBLE9BQ0EsSUFBRyxDQUFDLE1BQVksU0FBaUIsT0FBbUIsQ0FBQyxHQUFvQjtBQUFBLElBQzdFLE9BQU8sSUFBSSxJQUFJLElBQUksTUFBTSxLQUFLO0FBQUEsSUFDOUIsTUFBTSxPQUFPO0FBQUEsTUFDWDtBQUFBLE1BQ0E7QUFBQSxNQUNBO0FBQUEsTUFDQSxLQUFLO0FBQUEsTUFDTDtBQUFBLE1BQ0EsR0FBRyxNQUFNLE1BQU0sTUFBTTtBQUFBLE1BQ3JCO0FBQUEsTUFDQSxLQUFLO0FBQUEsTUFDTDtBQUFBLE1BQ0E7QUFBQSxJQUNGO0FBQUEsSUFDQSxJQUFJLEtBQUs7QUFBQSxNQUFPLEtBQUssS0FBSyxXQUFXLEtBQUssS0FBSztBQUFBLElBQy9DLElBQUksT0FBTyxLQUFLLFFBQVE7QUFBQSxNQUFVLEtBQUssS0FBSyxTQUFTLE9BQU8sS0FBSyxHQUFHLENBQUM7QUFBQSxJQUNyRSxJQUFJLEtBQUs7QUFBQSxNQUFPLEtBQUssS0FBSyxXQUFXLEtBQUssS0FBSztBQUFBLElBRS9DLE1BQU0sT0FBTyxJQUFJLE1BQU0sTUFBTSxFQUFFLFFBQVEsUUFBUSxRQUFRLE9BQU8sQ0FBQztBQUFBLElBQy9ELE9BQU8sUUFBUSxRQUFRLFlBQVksTUFBTSxRQUFRLElBQUk7QUFBQSxNQUNuRCxJQUFJLFNBQVMsS0FBSyxNQUFNLEVBQUUsS0FBSztBQUFBLE1BQy9CLElBQUksU0FBUyxLQUFLLE1BQU0sRUFBRSxLQUFLO0FBQUEsTUFDL0IsS0FBSztBQUFBLElBQ1AsQ0FBQztBQUFBLElBQ0QsSUFBSSxhQUFhLEdBQUc7QUFBQSxNQUNsQixNQUFNLElBQUksTUFDUixnQ0FBZ0MsY0FBYyxPQUFPLEtBQUssS0FBSyxPQUFPLEtBQUssR0FDN0U7QUFBQSxJQUNGO0FBQUEsSUFDQSxNQUFNLE9BQU8sT0FBTyxLQUFLLEVBQUUsTUFBTTtBQUFBLENBQUksRUFBRSxPQUFPLE9BQU8sRUFBRSxJQUFJLEtBQUs7QUFBQSxJQUNoRSxJQUFJO0FBQUEsSUFDSixJQUFJO0FBQUEsTUFDRixTQUFTLEtBQUssTUFBTSxJQUFJO0FBQUEsTUFDeEIsTUFBTTtBQUFBLE1BQ04sTUFBTSxJQUFJLE1BQU0sb0RBQW9ELE9BQU8sS0FBSyxHQUFHO0FBQUE7QUFBQSxJQUVyRixPQUFPLEVBQUUsSUFBSSxRQUFRLEtBQUssR0FBRyxTQUFTLFNBQVMsTUFBTSxPQUFPLE9BQU8sUUFBUTtBQUFBO0FBRS9FO0FBU08sSUFBTSxvQkFBb0M7QUFBQSxFQUMvQyxNQUFNO0FBQUEsT0FDQSxJQUFHLENBQUMsTUFBWSxTQUFpQixPQUFtQixDQUFDLEdBQW9CO0FBQUEsSUFDN0UsTUFBTSxRQUFRLEtBQUs7QUFBQSxJQUNuQixJQUFJLENBQUM7QUFBQSxNQUFPLE1BQU0sSUFBSSxNQUFNLGtFQUFrRTtBQUFBLElBQzlGLE1BQU0sT0FBTztBQUFBLE1BQ1g7QUFBQSxNQUNBO0FBQUEsTUFDQTtBQUFBLE1BQ0EsV0FBVztBQUFBLE1BQ1gsU0FBUyxLQUFLO0FBQUEsTUFDZDtBQUFBLE1BQ0E7QUFBQSxJQUNGO0FBQUEsSUFDQSxNQUFNLE9BQU8sSUFBSSxNQUFNLE1BQU0sRUFBRSxRQUFRLFFBQVEsUUFBUSxPQUFPLENBQUM7QUFBQSxJQUMvRCxPQUFPLFFBQVEsUUFBUSxZQUFZLE1BQU0sUUFBUSxJQUFJO0FBQUEsTUFDbkQsSUFBSSxTQUFTLEtBQUssTUFBTSxFQUFFLEtBQUs7QUFBQSxNQUMvQixJQUFJLFNBQVMsS0FBSyxNQUFNLEVBQUUsS0FBSztBQUFBLE1BQy9CLEtBQUs7QUFBQSxJQUNQLENBQUM7QUFBQSxJQUNELElBQUksYUFBYSxHQUFHO0FBQUEsTUFDbEIsTUFBTSxJQUFJLE1BQ1Isc0NBQXNDLGNBQWMsT0FBTyxLQUFLLEtBQUssT0FBTyxLQUFLLEdBQ25GO0FBQUEsSUFDRjtBQUFBLElBQ0EsSUFBSTtBQUFBLElBQ0osSUFBSTtBQUFBLE1BQ0YsU0FBUyxLQUFLLE1BQU0sT0FBTyxLQUFLLEVBQUUsTUFBTTtBQUFBLENBQUksRUFBRSxPQUFPLE9BQU8sRUFBRSxJQUFJLEtBQUssRUFBRTtBQUFBLE1BQ3pFLE1BQU07QUFBQSxNQUNOLE1BQU0sSUFBSSxNQUFNLGdEQUFnRCxPQUFPLEtBQUssR0FBRztBQUFBO0FBQUEsSUFFakYsTUFBTSxNQUFNLFFBQVEsTUFBTSxVQUFVLElBQUk7QUFBQSxJQUN4QyxJQUFJLENBQUM7QUFBQSxNQUFLLE1BQU0sSUFBSSxNQUFNLHVDQUF1QyxPQUFPLEtBQUssR0FBRztBQUFBLElBQ2hGLE1BQU0sTUFBTSxNQUFNLE1BQU0sR0FBRztBQUFBLElBQzNCLElBQUksQ0FBQyxJQUFJO0FBQUEsTUFBSSxNQUFNLElBQUksTUFBTSw0Q0FBNEMsSUFBSSxTQUFTO0FBQUEsSUFDdEYsTUFBTSxJQUFJLE1BQU0sU0FBUyxHQUFHO0FBQUEsSUFDNUIsT0FBTyxFQUFFLElBQUksUUFBUSxLQUFLLEdBQUcsU0FBUyxlQUFlLE1BQU0sUUFBUTtBQUFBO0FBRXZFO0FBUU8sU0FBUyxpQkFBaUIsQ0FBQyxPQUF3QjtBQUFBLEVBQ3hELE9BQU8sTUFBTSxTQUFTLEdBQUc7QUFBQTtBQUlwQixJQUFNLG1CQUFtRDtBQUFBLEdBQzdELGFBQWEsT0FBTztBQUFBLEdBQ3BCLGtCQUFrQixPQUFPO0FBQzVCOzs7QUV4S0EsbUNBQTJCO0FBR3BCLElBQU0saUJBQWlCO0FBQ3ZCLElBQU0sZ0JBQWdCO0FBR3RCLElBQU0sU0FBUztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQWdCZixJQUFNLGtCQUFrQixLQUFLLE9BQU87QUFDcEMsSUFBTSxtQkFBbUIsS0FBSyxPQUFPO0FBRTVDLElBQU0sY0FBc0M7QUFBQSxFQUMxQyxRQUFRO0FBQUEsRUFDUixTQUFTO0FBQUEsRUFDVCxRQUFRO0FBQUEsRUFDUixTQUFTO0FBQUEsRUFDVCxRQUFRO0FBQ1Y7QUFBQTtBQXFCTyxNQUFNLHNCQUFzQixNQUFNO0FBQUM7QUFNbkMsU0FBUyxXQUFXLENBQUMsU0FBNEI7QUFBQSxFQUN0RCxJQUFJLElBQUksUUFBUSxLQUFLO0FBQUEsRUFDckIsTUFBTSxRQUFRLGtDQUFrQyxLQUFLLENBQUM7QUFBQSxFQUN0RCxJQUFJO0FBQUEsSUFBTyxJQUFJLE1BQU07QUFBQSxFQUNyQixPQUFPLEtBQUssTUFBTSxDQUFDO0FBQUE7QUFNZCxTQUFTLGlCQUFpQixDQUFDLEtBQWUsT0FBZSxRQUFzQjtBQUFBLEVBQ3BGLE9BQU8sSUFBSSxJQUFJLElBQUksTUFBTTtBQUFBLEVBQ3pCLE1BQU0sTUFBTSxLQUFLLElBQUksR0FBRyxLQUFLLE1BQU8sS0FBSyxPQUFRLEtBQUssQ0FBQztBQUFBLEVBQ3ZELE1BQU0sTUFBTSxLQUFLLElBQUksR0FBRyxLQUFLLE1BQU8sS0FBSyxPQUFRLE1BQU0sQ0FBQztBQUFBLEVBQ3hELE1BQU0sTUFBTSxLQUFLLElBQUksT0FBTyxLQUFLLE1BQU8sS0FBSyxPQUFRLEtBQUssQ0FBQztBQUFBLEVBQzNELE1BQU0sTUFBTSxLQUFLLElBQUksUUFBUSxLQUFLLE1BQU8sS0FBSyxPQUFRLE1BQU0sQ0FBQztBQUFBLEVBQzdELE9BQU8sQ0FBQyxLQUFLLEtBQUssS0FBSyxHQUFHO0FBQUE7QUFLckIsU0FBUyxlQUFlLENBQUMsS0FBZ0IsT0FBZSxRQUFtQztBQUFBLEVBQ2hHLE1BQU0sV0FBOEIsQ0FBQztBQUFBLEVBQ3JDLFdBQVcsU0FBUyxLQUFLO0FBQUEsSUFDdkIsSUFBSSxDQUFDLFNBQVMsT0FBTyxVQUFVO0FBQUEsTUFBVTtBQUFBLElBQ3pDLE1BQU0sSUFBSTtBQUFBLElBQ1YsTUFBTSxPQUFPLEVBQUU7QUFBQSxJQUNmLE1BQU0sT0FBUSxPQUFPLEVBQUUsU0FBUyxXQUFXLEVBQUUsT0FBTztBQUFBLElBQ3BELE1BQU0sTUFBTSxFQUFFO0FBQUEsSUFDZCxJQUFJLENBQUMsUUFBUSxPQUFPLFNBQVMsWUFBWSxDQUFDLE1BQU0sUUFBUSxHQUFHO0FBQUEsTUFBRztBQUFBLElBQzlELFNBQVMsS0FBSztBQUFBLE1BQ1o7QUFBQSxNQUNBLE1BQU07QUFBQSxNQUNOLFFBQVE7QUFBQSxNQUNSLFlBQVksa0JBQWtCLEtBQWlCLE9BQU8sTUFBTTtBQUFBLElBQzlELENBQUM7QUFBQSxFQUNIO0FBQUEsRUFDQSxPQUFPO0FBQUE7QUFLRixTQUFTLFdBQVcsQ0FBQyxNQUFzQjtBQUFBLEVBQ2hELE9BQU8sWUFBWSxRQUFRLElBQUksRUFBRSxZQUFZLE1BQU07QUFBQTtBQUtyRCxlQUFzQixrQkFBa0IsQ0FBQyxNQUErQjtBQUFBLEVBQ3RFLE1BQU0sT0FBTyxJQUFJLEtBQUssSUFBSTtBQUFBLEVBQzFCLE1BQU0sT0FBTyxLQUFLO0FBQUEsRUFDbEIsSUFBSSxPQUFPLGlCQUFpQjtBQUFBLElBQzFCLE1BQU0sTUFBTSxPQUFPLFNBQVcsUUFBUSxDQUFDO0FBQUEsSUFDdkMsTUFBTSxRQUFRLEtBQUssTUFBTSxrQkFBa0IsT0FBUztBQUFBLElBQ3BELE1BQU0sSUFBSSxjQUNSLEdBQUcsV0FBVyxvQkFBb0IsNENBQ2hDLHFFQUNKO0FBQUEsRUFDRjtBQUFBLEVBQ0EsSUFBSSxPQUFPLGtCQUFrQjtBQUFBLElBQzNCLFFBQVEsT0FBTyxNQUNiLFNBQVMsWUFBWSxPQUFPLFNBQVcsUUFBUSxDQUFDO0FBQUEsQ0FDbEQ7QUFBQSxFQUNGO0FBQUEsRUFDQSxNQUFNLFFBQVEsSUFBSSxXQUFXLE1BQU0sS0FBSyxZQUFZLENBQUM7QUFBQSxFQUNyRCxNQUFNLE1BQU0sT0FBTyxLQUFLLEtBQUssRUFBRSxTQUFTLFFBQVE7QUFBQSxFQUNoRCxPQUFPLFFBQVEsWUFBWSxJQUFJLFlBQVk7QUFBQTtBQUk3QyxlQUFzQixTQUFTLENBQUMsTUFBeUM7QUFBQSxFQUN2RSxNQUFNLFFBQVEsSUFBSSxXQUFXLE1BQU0sSUFBSSxLQUFLLElBQUksRUFBRSxZQUFZLENBQUM7QUFBQSxFQUMvRCxNQUFNLE9BQU8sTUFBTSxJQUFJLElBQUksTUFBTSxLQUFLLEVBQUUsU0FBUztBQUFBLEVBQ2pELE9BQU8sQ0FBQyxLQUFLLFNBQVMsR0FBRyxLQUFLLFVBQVUsQ0FBQztBQUFBO0FBSTNDLGVBQXNCLGVBQWUsQ0FBQyxNQUErQjtBQUFBLEVBQ25FLE1BQU0sUUFBUSxJQUFJLFdBQVcsTUFBTSxJQUFJLEtBQUssSUFBSSxFQUFFLFlBQVksQ0FBQztBQUFBLEVBQy9ELE9BQU8sSUFBSSxJQUFJLGFBQWEsUUFBUSxFQUFFLE9BQU8sS0FBSyxFQUFFLE9BQU8sS0FBSyxFQUFFLE1BQU0sR0FBRyxFQUFFO0FBQUE7QUFLL0UsZUFBc0IsY0FBYyxDQUNsQyxRQUNBLE9BQ0EsY0FDQSxRQUNrQztBQUFBLEVBQ2xDLE1BQU0sT0FBTztBQUFBLElBQ1g7QUFBQSxJQUNBLFVBQVU7QUFBQSxNQUNSO0FBQUEsUUFDRSxNQUFNO0FBQUEsUUFDTixTQUFTO0FBQUEsVUFDUCxFQUFFLE1BQU0sUUFBUSxNQUFNLE9BQU87QUFBQSxVQUM3QixFQUFFLE1BQU0sYUFBYSxXQUFXLEVBQUUsS0FBSyxhQUFhLEVBQUU7QUFBQSxRQUN4RDtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQUEsSUFDQSxhQUFhO0FBQUEsRUFDZjtBQUFBLEVBQ0EsTUFBTSxPQUFPLElBQUk7QUFBQSxFQUNqQixNQUFNLFFBQVEsV0FBVyxNQUFNLEtBQUssTUFBTSxHQUFHLE1BQU87QUFBQSxFQUNwRCxJQUFJO0FBQUEsSUFDRixNQUFNLE1BQU0sTUFBTSxNQUFNLGdCQUFnQjtBQUFBLE1BQ3RDLFFBQVE7QUFBQSxNQUNSLFNBQVM7QUFBQSxRQUNQLGVBQWUsVUFBVTtBQUFBLFFBQ3pCLGdCQUFnQjtBQUFBLFFBQ2hCLGdCQUFnQjtBQUFBLFFBQ2hCLFdBQVc7QUFBQSxNQUNiO0FBQUEsTUFDQSxNQUFNLEtBQUssVUFBVSxJQUFJO0FBQUEsTUFDekIsUUFBUSxLQUFLO0FBQUEsSUFDZixDQUFDO0FBQUEsSUFDRCxJQUFJLENBQUMsSUFBSSxJQUFJO0FBQUEsTUFDWCxNQUFNLE9BQU8sTUFBTSxJQUFJLEtBQUssRUFBRSxNQUFNLE1BQU0sRUFBRTtBQUFBLE1BQzVDLE1BQU0sSUFBSSxjQUFjLG1CQUFtQixJQUFJLFdBQVcsTUFBTTtBQUFBLElBQ2xFO0FBQUEsSUFDQSxPQUFRLE1BQU0sSUFBSSxLQUFLO0FBQUEsWUFDdkI7QUFBQSxJQUNBLGFBQWEsS0FBSztBQUFBO0FBQUE7QUFZdEIsZUFBc0IsUUFBUSxDQUFDLFdBQW1CLE9BQXdCLENBQUMsR0FBc0I7QUFBQSxFQUMvRixNQUFNLFFBQVEsS0FBSyxTQUFTO0FBQUEsRUFDNUIsTUFBTSxTQUFTLEtBQUssVUFBVSxRQUFRLElBQUk7QUFBQSxFQUMxQyxJQUFJLENBQUMsUUFBUTtBQUFBLElBQ1gsTUFBTSxJQUFJLGNBQWMsb0NBQW9DO0FBQUEsRUFDOUQ7QUFBQSxFQUNBLElBQUksQ0FBRSxNQUFNLElBQUksS0FBSyxTQUFTLEVBQUUsT0FBTyxHQUFJO0FBQUEsSUFDekMsTUFBTSxJQUFJLGNBQWMsb0JBQW9CLFdBQVc7QUFBQSxFQUN6RDtBQUFBLEVBRUEsT0FBTyxNQUFNLFNBQVMsT0FBTyxNQUFNLFFBQVEsSUFBSTtBQUFBLElBQzdDLFVBQVUsU0FBUztBQUFBLElBQ25CLG1CQUFtQixTQUFTO0FBQUEsSUFDNUIsZ0JBQWdCLFNBQVM7QUFBQSxFQUMzQixDQUFDO0FBQUEsRUFDRCxPQUFPLE9BQU8sVUFBVTtBQUFBLEVBRXhCLE1BQU0sT0FBTyxNQUFNLGVBQWUsUUFBUSxPQUFPLFNBQVMsTUFBTTtBQUFBLEVBRWhFLE1BQU0sVUFBVSxLQUFLO0FBQUEsRUFDckIsTUFBTSxVQUFVLFVBQVUsSUFBSSxTQUFTO0FBQUEsRUFDdkMsSUFBSSxPQUFPLFlBQVksVUFBVTtBQUFBLElBQy9CLE1BQU0sSUFBSSxjQUNSO0FBQUEsRUFBK0UsS0FBSyxVQUFVLElBQUksRUFBRSxNQUFNLEdBQUcsSUFBSSxHQUNuSDtBQUFBLEVBQ0Y7QUFBQSxFQUVBLE1BQU0sUUFBUyxLQUFLLFNBQXFDLENBQUM7QUFBQSxFQUMxRCxNQUFNLE9BQU8sT0FBTyxNQUFNLFNBQVMsV0FBVyxNQUFNLE9BQU87QUFBQSxFQUMzRCxNQUFNLGVBQWUsT0FBTyxNQUFNLGtCQUFrQixXQUFXLE1BQU0sZ0JBQWdCO0FBQUEsRUFDckYsTUFBTSxtQkFDSixPQUFPLE1BQU0sc0JBQXNCLFdBQVcsTUFBTSxvQkFBb0I7QUFBQSxFQUMxRSxNQUFNLFVBQVcsTUFBTSw2QkFBeUQsQ0FBQztBQUFBLEVBQ2pGLE1BQU0sa0JBQ0osT0FBTyxRQUFRLHFCQUFxQixXQUFXLFFBQVEsbUJBQW1CO0FBQUEsRUFFNUUsSUFBSTtBQUFBLEVBQ0osSUFBSTtBQUFBLElBQ0YsTUFBTSxZQUFZLE9BQU87QUFBQSxJQUN6QixPQUFPLElBQUk7QUFBQSxJQUNYLE1BQU0sSUFBSSxjQUNSO0FBQUEsRUFBb0M7QUFBQTtBQUFBLGVBQTJCLGNBQWMsUUFBUSxHQUFHLFVBQVUsT0FBTyxFQUFFLEdBQzdHO0FBQUE7QUFBQSxFQUdGLE9BQU87QUFBQSxJQUNMLFFBQVEsUUFBUSxTQUFTO0FBQUEsSUFDekIsYUFBYSxDQUFDLE9BQU8sTUFBTTtBQUFBLElBQzNCLGtCQUFrQjtBQUFBLElBQ2xCO0FBQUEsSUFDQSxVQUFVO0FBQUEsSUFDVixRQUFRLEVBQUUsUUFBUSxjQUFjLFlBQVksa0JBQWtCLFdBQVcsZ0JBQWdCO0FBQUEsSUFDekYsVUFBVSxnQkFBZ0IsS0FBSyxPQUFPLE1BQU07QUFBQSxFQUM5QztBQUFBO0FBd0RGLElBQUksT0FBa0IsQ0FTdEI7OztBQzVGTyxJQUFNLG9CQUFvQixPQUFPLE9BQU87QUFBQSxFQUM3QztBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUNGLENBQVU7OztBQzlOVixTQUFTLE9BQU8sQ0FBQyxPQUF1QjtBQUFBLEVBQ3RDLE1BQU0sTUFBTSxJQUFJLFdBQVcsS0FBSztBQUFBLEVBQ2hDLE9BQU8sZ0JBQWdCLEdBQUc7QUFBQSxFQUMxQixPQUFPLE1BQU0sS0FBSyxLQUFLLENBQUMsTUFBTSxFQUFFLFNBQVMsRUFBRSxFQUFFLFNBQVMsR0FBRyxHQUFHLENBQUMsRUFBRSxLQUFLLEVBQUU7QUFBQTtBQUVqRSxTQUFTLEtBQUssQ0FBQyxRQUF3QjtBQUFBLEVBQzVDLE9BQU8sR0FBRyxVQUFVLFFBQVEsQ0FBQztBQUFBOzs7QUNmeEIsU0FBUyxhQUFhLENBQUMsSUFBeUM7QUFBQSxFQUNyRSxNQUFNLEtBQUssR0FBRyxZQUFZLENBQUM7QUFBQSxFQUMzQixPQUFPLEdBQUcsS0FBSyxDQUFDLE1BQU0sRUFBRSxPQUFPLEdBQUcsZUFBZSxLQUFLLEdBQUc7QUFBQTs7O0FDU3BELFNBQVMsU0FBUyxDQUFDLE1BQXFCO0FBQUEsRUFDN0MsUUFBUSxPQUFPLE1BQU0sR0FBRyxLQUFLLFVBQVUsSUFBSTtBQUFBLENBQUs7QUFBQTs7O0FQNkJsRCxRQUFRLE9BQU8sR0FBRyxTQUFTLENBQUMsTUFBNkI7QUFBQSxFQUN2RCxJQUFJLEVBQUUsU0FBUztBQUFBLElBQVMsUUFBUSxLQUFLLENBQUM7QUFBQSxDQUN2QztBQUVELElBQU0sYUFBYSxTQUFRLGNBQWMsWUFBWSxHQUFHLENBQUM7QUFHekQsSUFBTSxnQkFBZ0IsTUFBSyxZQUFZLE1BQU0sV0FBVyxXQUFXO0FBT25FLFNBQVMsaUJBQWlCLEdBQWtCO0FBQUEsRUFDMUMsSUFBSTtBQUFBLElBQ0YsTUFBTSxpQkFBaUIsTUFBSyxZQUFZLE1BQU0sTUFBTSxNQUFNLGtCQUFrQixhQUFhO0FBQUEsSUFDekYsT0FBTyxLQUFLLE1BQU0sYUFBYSxnQkFBZ0IsT0FBTyxDQUFDLEVBQUUsV0FBVztBQUFBLElBQ3BFLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQTtBQUFBO0FBR1gsSUFBTSxpQkFBaUIsa0JBQWtCO0FBMEJ6QyxJQUFNLFdBQW9DO0FBQUEsRUFDeEMsT0FBTztBQUFBLEVBQ1AsVUFBVTtBQUFBLEVBQ1YsV0FBVztBQUFBLEVBQ1gsVUFBVTtBQUNaO0FBR0EsSUFBSSxrQkFBaUM7QUFFckMsU0FBUyxhQUFhLENBQ3BCLE1BQ0EsU0FDQSxPQUNRO0FBQUEsRUFDUixPQUFPLEdBQUcsS0FBSyxVQUFVO0FBQUEsSUFDdkIsSUFBSTtBQUFBLElBQ0osT0FBTztBQUFBLE1BQ0w7QUFBQSxNQUNBLFdBQVcsU0FBUztBQUFBLE1BRXBCLFdBQVc7QUFBQSxNQUNYO0FBQUEsU0FDSSxPQUFPLE9BQU8sRUFBRSxNQUFNLE1BQU0sS0FBSyxJQUFJLENBQUM7QUFBQSxTQUN0QyxPQUFPLFVBQVUsRUFBRSxTQUFTLE1BQU0sUUFBUSxJQUFJLENBQUM7QUFBQSxJQUNyRDtBQUFBLElBQ0EsTUFBTSxFQUFFLFNBQVMsZ0JBQWdCO0FBQUEsRUFDbkMsQ0FBQztBQUFBO0FBQUE7QUFHSCxTQUFTLEdBQUcsQ0FDVixLQUNBLE9BQWdCLFNBQ2hCLE9BQ087QUFBQSxFQUNQLFFBQVEsT0FBTyxNQUFNLGNBQWMsTUFBTSxLQUFLLEtBQUssQ0FBQztBQUFBLEVBQ3BELFFBQVEsS0FBSyxTQUFTLEtBQUs7QUFBQTtBQUc3QixTQUFTLEtBQUssQ0FBQyxJQUEyQjtBQUFBLEVBQ3hDLE9BQU8sSUFBSSxRQUFRLENBQUMsTUFBTSxXQUFXLEdBQUcsRUFBRSxDQUFDO0FBQUE7QUFHN0MsU0FBUyxlQUFlLENBQUMsU0FBMEI7QUFBQSxFQUNqRCxPQUFPLFVBQVUsTUFBSyxPQUFPLEdBQUcsVUFBVSxjQUFjLElBQUksTUFBSyxPQUFPLEdBQUcsb0JBQW9CO0FBQUE7QUFHakcsU0FBUyxXQUFXLENBQUMsU0FBa0M7QUFBQSxFQUNyRCxJQUFJO0FBQUEsSUFDRixPQUFPLEtBQUssTUFBTSxhQUFhLGdCQUFnQixPQUFPLEdBQUcsTUFBTSxDQUFDO0FBQUEsSUFDaEUsTUFBTTtBQUFBLElBQ04sT0FBTztBQUFBO0FBQUE7QUFJWCxTQUFTLGNBQWMsQ0FBQyxTQUEyQjtBQUFBLEVBQ2pELE1BQU0sSUFBSSxZQUFZLE9BQU87QUFBQSxFQUM3QixJQUFJLENBQUM7QUFBQSxJQUFHLElBQUkscURBQStDLFdBQVc7QUFBQSxFQUN0RSxPQUFPO0FBQUE7QUFHVCxlQUFlLEdBQUcsQ0FDaEIsTUFDQSxRQUNBLE1BQ0EsTUFDNEM7QUFBQSxFQUM1QyxNQUFNLE1BQU0sTUFBTSxNQUFNLG9CQUFvQixPQUFPLFFBQVE7QUFBQSxJQUN6RDtBQUFBLElBQ0EsU0FBUyxTQUFTLFlBQVksRUFBRSxnQkFBZ0IsbUJBQW1CLElBQUk7QUFBQSxJQUN2RSxNQUFNLFNBQVMsWUFBWSxLQUFLLFVBQVUsSUFBSSxJQUFJO0FBQUEsRUFDcEQsQ0FBQztBQUFBLEVBQ0QsSUFBSSxPQUFnQjtBQUFBLEVBQ3BCLElBQUk7QUFBQSxJQUNGLE9BQU8sTUFBTSxJQUFJLEtBQUs7QUFBQSxJQUN0QixNQUFNO0FBQUEsRUFDUixPQUFPLEVBQUUsUUFBUSxJQUFJLFFBQVEsS0FBSztBQUFBO0FBZXBDLElBQU0sY0FBYztBQUFBLEVBQ2xCLE9BQU8sRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN4QixNQUFNLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDdkIsS0FBSyxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQ3RCLFFBQVEsRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN6QixPQUFPLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDeEIsT0FBTyxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQ3hCLE1BQU0sRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUN2QixTQUFTLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDMUIsS0FBSyxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQ3RCLFNBQVMsRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUMxQixTQUFTLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDMUIsT0FBTyxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQ3hCLFNBQVMsRUFBRSxNQUFNLFNBQVM7QUFBQSxFQUMxQixPQUFPLEVBQUUsTUFBTSxTQUFTO0FBQUEsRUFDeEIsTUFBTSxFQUFFLE1BQU0sU0FBUztBQUFBLEVBQ3ZCLE1BQU0sRUFBRSxNQUFNLFVBQVU7QUFBQSxFQUN4QixXQUFXLEVBQUUsTUFBTSxVQUFVO0FBQUEsRUFDN0IsUUFBUSxFQUFFLE1BQU0sVUFBVTtBQUFBLEVBQzFCLE9BQU8sRUFBRSxNQUFNLFVBQVU7QUFDM0I7QUFnQk8sSUFBTSxZQUFZO0FBQUEsRUFDdkIsTUFBTSxDQUFDLFNBQVMsVUFBVSxXQUFXLFdBQVcsU0FBUztBQUFBLEVBQ3pELFVBQVUsQ0FBQztBQUFBLEVBQ1gsTUFBTSxDQUFDLFdBQVcsT0FBTztBQUFBLEVBQ3pCLE9BQU8sQ0FBQyxXQUFXLE1BQU07QUFBQSxFQUN6QixLQUFLLENBQUMsV0FBVyxPQUFPO0FBQUEsRUFDeEIsS0FBSyxDQUFDLFdBQVcsU0FBUztBQUFBLEVBQzFCLFFBQVEsQ0FBQyxTQUFTO0FBQUEsRUFDbEIsUUFBUSxDQUFDLFNBQVM7QUFBQSxFQUNsQixVQUFVLENBQUMsU0FBUztBQUFBLEVBQ3BCLFNBQVMsQ0FBQyxXQUFXLE9BQU8sVUFBVSxTQUFTLE9BQU8sU0FBUyxPQUFPO0FBQUEsRUFDdEUsUUFBUSxDQUFDLFdBQVcsS0FBSztBQUFBLEVBQ3pCLGVBQWUsQ0FBQyxXQUFXLFFBQVEsUUFBUSxNQUFNO0FBQUEsRUFDakQsa0JBQWtCLENBQUMsU0FBUztBQUFBLEVBQzVCLEtBQUssQ0FBQyxXQUFXLE9BQU87QUFBQSxFQUN4QixPQUFPLENBQUMsU0FBUztBQUFBLEVBQ2pCLE1BQU0sQ0FBQyxTQUFTO0FBQUEsRUFDaEIsTUFBTSxDQUFDO0FBQ1Q7QUFJQSxJQUFNLFFBQVEsT0FBTyxLQUFLLFNBQVM7QUFFbkMsSUFBTSxTQUFTLENBQUMsTUFBeUIsT0FBTyxPQUFPLFdBQVcsQ0FBQztBQUduRSxJQUFNLFdBQVcsQ0FBQyxTQUF5QixVQUFVLE1BQU0sSUFBSSxDQUFDLE1BQU0sS0FBSyxHQUFHLEVBQUUsS0FBSztBQUFBO0FBRXJGLE1BQU0sbUJBQW1CLE1BQU07QUFBQztBQUV6QixTQUFTLFNBQVMsQ0FDdkIsTUFDQSxNQUlBO0FBQUEsRUFrQkEsSUFBSTtBQUFBLEVBQ0osSUFBSTtBQUFBLElBQ0YsU0FBUyxjQUFjO0FBQUEsTUFDckI7QUFBQSxNQUNBLFNBQVM7QUFBQSxNQUNULFFBQVE7QUFBQSxNQUNSLGtCQUFrQjtBQUFBLElBQ3BCLENBQUM7QUFBQSxJQUNELE9BQU8sR0FBRztBQUFBLElBQ1YsTUFBTSxJQUFJLFdBQVcsYUFBYSxRQUFRLEVBQUUsVUFBVSxPQUFPLENBQUMsQ0FBQztBQUFBO0FBQUEsRUFHakUsSUFBSSxNQUFNO0FBQUEsSUFDUixNQUFNLFVBQVUsSUFBSSxJQUFZLFVBQVUsS0FBSztBQUFBLElBQy9DLE1BQU0sUUFBUSxPQUFPLEtBQUssT0FBTyxNQUFNLEVBQUUsS0FBSyxDQUFDLE1BQU0sQ0FBQyxRQUFRLElBQUksQ0FBQyxDQUFDO0FBQUEsSUFDcEUsSUFBSSxPQUFPO0FBQUEsTUFDVCxNQUFNLElBQUksV0FDUixLQUFLLDhCQUE4QiwrREFDckM7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUFBLEVBRUEsT0FBTztBQUFBLElBQ0wsS0FBSyxPQUFPO0FBQUEsSUFDWixPQUFPLE9BQU87QUFBQSxFQUNoQjtBQUFBO0FBS0YsZUFBZSxTQUFTLEdBQW9CO0FBQUEsRUFDMUMsUUFBUSxNQUFNLElBQUksTUFBTSxLQUFLLEdBQUcsS0FBSztBQUFBO0FBR3ZDLGVBQWUsT0FBTyxDQUFDLFNBQTZCLEtBQThCO0FBQUEsRUFDaEYsTUFBTSxJQUFJLGVBQWUsT0FBTztBQUFBLEVBQ2hDLFFBQVEsV0FBVyxNQUFNLElBQUksRUFBRSxNQUFNLFFBQVEsUUFBUSxHQUFHO0FBQUEsRUFDeEQsSUFBSSxXQUFXO0FBQUEsSUFBSyxJQUFJLG9CQUFvQiw4Q0FBd0MsVUFBVTtBQUFBLEVBQzlGLFVBQVUsRUFBRSxJQUFJLE1BQU0sTUFBTSxJQUFJLEtBQUssQ0FBQztBQUFBO0FBS3hDLGVBQWUsT0FBTyxDQUFDLE9BQXlDO0FBQUEsRUFDOUQsTUFBTSxPQUFPLENBQUMsT0FBTyxhQUFhO0FBQUEsRUFDbEMsSUFBSSxNQUFNO0FBQUEsSUFBTyxLQUFLLEtBQUssV0FBVyxPQUFPLE1BQU0sS0FBSyxDQUFDO0FBQUEsRUFDekQsSUFBSSxNQUFNO0FBQUEsSUFBUSxLQUFLLEtBQUssWUFBWSxPQUFPLE1BQU0sTUFBTSxDQUFDO0FBQUEsRUFDNUQsSUFBSSxNQUFNO0FBQUEsSUFBUyxLQUFLLEtBQUssYUFBYSxPQUFPLE1BQU0sT0FBTyxDQUFDO0FBQUEsRUFDL0QsSUFBSSxNQUFNO0FBQUEsSUFBUyxLQUFLLEtBQUssYUFBYSxPQUFPLE1BQU0sT0FBTyxDQUFDO0FBQUEsRUFDL0QsSUFBSSxNQUFNO0FBQUEsSUFBWSxLQUFLLEtBQUssV0FBVztBQUFBLEVBRTNDLE1BQU0sU0FBUyxZQUFZLEdBQUc7QUFBQSxFQUk5QixNQUFNLE9BQU8sTUFBTSxRQUFRLFVBQVUsTUFBTTtBQUFBLElBQ3pDLFVBQVU7QUFBQSxJQUNWLE9BQU8sQ0FBQyxVQUFVLFVBQVUsUUFBUTtBQUFBLElBQ3BDLEtBQUssUUFBUTtBQUFBLElBQ2IsS0FBSyxNQUFLLFlBQVksSUFBSTtBQUFBLEVBQzVCLENBQUM7QUFBQSxFQUNELEtBQUssTUFBTTtBQUFBLEVBRVgsTUFBTSxXQUFXLEtBQUssSUFBSSxJQUFJO0FBQUEsRUFDOUIsT0FBTyxLQUFLLElBQUksSUFBSSxVQUFVO0FBQUEsSUFDNUIsTUFBTSxNQUFNLEVBQUU7QUFBQSxJQUNkLE1BQU0sSUFBSSxZQUFZO0FBQUEsSUFDdEIsSUFBSSxLQUFLLEVBQUUsZUFBZSxRQUFRO0FBQUEsTUFDaEMsSUFBSTtBQUFBLFFBQ0YsTUFBTSxJQUFJLE1BQU0sTUFBTSxvQkFBb0IsRUFBRSxZQUFZO0FBQUEsUUFDeEQsSUFBSSxFQUFFLElBQUk7QUFBQSxVQUNSLFVBQVUsQ0FBQztBQUFBLFVBQ1g7QUFBQSxRQUNGO0FBQUEsUUFDQSxNQUFNO0FBQUEsSUFHVjtBQUFBLEVBQ0Y7QUFBQSxFQUNBLElBQUksMkNBQTJDLFVBQVU7QUFBQTtBQUczRCxlQUFlLFFBQVEsQ0FBQyxTQUFrQixPQUFPLE9BQU87QUFBQSxFQUN0RCxNQUFNLElBQUksZUFBZSxPQUFPO0FBQUEsRUFDaEMsUUFBUSxRQUFRLFNBQVMsTUFBTSxJQUFJLEVBQUUsTUFBTSxPQUFPLFNBQVMsT0FBTyxLQUFLLFdBQVc7QUFBQSxFQUNsRixJQUFJLFdBQVc7QUFBQSxJQUFLLElBQUksc0JBQXNCLFdBQVcsVUFBVTtBQUFBLEVBQ25FLFVBQVUsSUFBSTtBQUFBO0FBR2hCLGVBQWUsT0FBTyxDQUFDLFNBQTZCLFVBQWtCO0FBQUEsRUFDcEUsSUFBSSxRQUFRO0FBQUEsRUFDWixJQUFJLFFBQVE7QUFBQSxFQUNaLElBQUksVUFBVTtBQUFBLEVBQ2QsSUFBSSxVQUFVO0FBQUEsRUFDZCxJQUFJLFdBQVc7QUFBQSxFQUNmLE1BQU0sT0FBTyxNQUFNO0FBQUEsSUFDakIsVUFBVTtBQUFBLElBQ1YsUUFBUSxLQUFLLENBQUM7QUFBQTtBQUFBLEVBRWhCLFFBQVEsR0FBRyxVQUFVLElBQUk7QUFBQSxFQUN6QixRQUFRLEdBQUcsV0FBVyxJQUFJO0FBQUEsRUFFMUIsT0FBTyxDQUFDLFNBQVM7QUFBQSxJQUNmLE1BQU0sSUFBSSxZQUFZLE9BQU87QUFBQSxJQUM3QixJQUFJLENBQUMsR0FBRztBQUFBLE1BQ04sSUFBSTtBQUFBLFFBQVUsUUFBUSxLQUFLLENBQUM7QUFBQSxNQUM1QixRQUFRLE9BQU8sTUFBTTtBQUFBLENBQThCO0FBQUEsTUFDbkQsTUFBTSxNQUFNLEtBQUs7QUFBQSxNQUNqQixRQUFRLEtBQUssSUFBSSxRQUFRLEdBQUcsSUFBSTtBQUFBLE1BQ2hDO0FBQUEsSUFDRjtBQUFBLElBQ0EsSUFBSSxDQUFDO0FBQUEsTUFBUyxVQUFVLEVBQUU7QUFBQSxJQUMxQixJQUFJLENBQUMsVUFBVTtBQUFBLE1BQ2IsV0FBVztBQUFBLE1BRVgsUUFBUSxPQUFPLE1BQ2IsR0FBRyxLQUFLLFVBQVUsRUFBRSxNQUFNLGFBQWEsWUFBWSxFQUFFLFlBQVksTUFBTSxFQUFFLEtBQUssQ0FBQztBQUFBLENBQ2pGO0FBQUEsSUFDRjtBQUFBLElBQ0EsSUFBSTtBQUFBLElBQ0osSUFBSTtBQUFBLE1BQ0YsTUFBTSxNQUFNLE1BQU0sb0JBQW9CLEVBQUUscUJBQXFCLE9BQU87QUFBQSxNQUNwRSxNQUFNO0FBQUEsTUFDTixNQUFNLE1BQU0sS0FBSztBQUFBLE1BQ2pCLFFBQVEsS0FBSyxJQUFJLFFBQVEsR0FBRyxJQUFJO0FBQUEsTUFDaEM7QUFBQTtBQUFBLElBRUYsSUFBSSxDQUFDLElBQUksTUFBTSxDQUFDLElBQUksTUFBTTtBQUFBLE1BQ3hCLE1BQU0sTUFBTSxLQUFLO0FBQUEsTUFDakIsUUFBUSxLQUFLLElBQUksUUFBUSxHQUFHLElBQUk7QUFBQSxNQUNoQztBQUFBLElBQ0Y7QUFBQSxJQUNBLFFBQVE7QUFBQSxJQUNSLE1BQU0sU0FBUyxJQUFJLEtBQUssVUFBVTtBQUFBLElBQ2xDLE1BQU0sTUFBTSxJQUFJO0FBQUEsSUFDaEIsSUFBSSxNQUFNO0FBQUEsSUFDVixPQUFPLE1BQU07QUFBQSxNQUNYLElBQUk7QUFBQSxNQUNKLElBQUk7QUFBQSxRQUNGLFFBQVEsTUFBTSxPQUFPLEtBQUs7QUFBQSxRQUMxQixNQUFNO0FBQUEsUUFDTjtBQUFBO0FBQUEsTUFFRixJQUFJLE1BQU07QUFBQSxRQUFNO0FBQUEsTUFDaEIsT0FBTyxJQUFJLE9BQU8sTUFBTSxPQUFPLEVBQUUsUUFBUSxLQUFLLENBQUM7QUFBQSxNQUMvQyxTQUFTLE1BQU0sSUFBSSxRQUFRO0FBQUE7QUFBQSxDQUFNLEVBQUcsT0FBTyxHQUFHLE1BQU0sSUFBSSxRQUFRO0FBQUE7QUFBQSxDQUFNLEdBQUc7QUFBQSxRQUN2RSxNQUFNLFFBQVEsSUFBSSxNQUFNLEdBQUcsR0FBRztBQUFBLFFBQzlCLE1BQU0sSUFBSSxNQUFNLE1BQU0sQ0FBQztBQUFBLFFBQ3ZCLE1BQU0sWUFBc0IsQ0FBQztBQUFBLFFBQzdCLFdBQVcsUUFBUSxNQUFNLE1BQU07QUFBQSxDQUFJLEdBQUc7QUFBQSxVQUNwQyxJQUFJLEtBQUssV0FBVyxHQUFHLEdBQUc7QUFBQSxZQUN4QixRQUFRLE9BQU8sTUFBTTtBQUFBLENBQXNCO0FBQUEsWUFDM0M7QUFBQSxVQUNGO0FBQUEsVUFDQSxJQUFJLEtBQUssV0FBVyxPQUFPO0FBQUEsWUFBRyxVQUFVLEtBQUssS0FBSyxNQUFNLENBQUMsRUFBRSxLQUFLLENBQUM7QUFBQSxRQUNuRTtBQUFBLFFBQ0EsSUFBSSxDQUFDLFVBQVU7QUFBQSxVQUFRO0FBQUEsUUFDdkIsTUFBTSxVQUFVLFVBQVUsS0FBSztBQUFBLENBQUk7QUFBQSxRQUNuQyxJQUFJO0FBQUEsVUFDRixNQUFNLEtBQUssS0FBSyxNQUFNLE9BQU87QUFBQSxVQUM3QixJQUFJLE9BQU8sR0FBRyxPQUFPLFlBQVksR0FBRyxLQUFLO0FBQUEsWUFBTyxRQUFRLEdBQUc7QUFBQSxVQUMzRCxJQUFJLEdBQUcsU0FBUyxVQUFVO0FBQUEsWUFjeEIsUUFBUSxPQUFPLE1BQU0sR0FBRztBQUFBLEdBQWEsTUFBTSxRQUFRLEtBQUssQ0FBQyxDQUFDO0FBQUEsWUFDMUQsVUFBVTtBQUFBLFlBQ1Y7QUFBQSxVQUNGO0FBQUEsVUFDQSxRQUFRLE9BQU8sTUFBTSxHQUFHO0FBQUEsQ0FBVztBQUFBLFVBQ25DLE1BQU07QUFBQSxNQUdWO0FBQUEsSUFDRjtBQUFBLElBQ0EsTUFBTSxNQUFNLEtBQUs7QUFBQSxFQUNuQjtBQUFBO0FBR0YsU0FBUyxPQUFPLENBQUMsU0FBa0I7QUFBQSxFQUNqQyxNQUFNLElBQUksWUFBWSxPQUFPO0FBQUEsRUFDN0IsSUFBSSxDQUFDO0FBQUEsSUFBRyxJQUFJLDZCQUE2QixXQUFXO0FBQUEsRUFDcEQsVUFBVSxDQUFDO0FBQUE7QUFHYixTQUFTLFdBQVcsR0FBRztBQUFBLEVBR3JCLE1BQU0sT0FBTyxRQUFRLElBQUksZUFBZSxNQUFLLFFBQVEsSUFBSSxRQUFRLElBQUksU0FBUztBQUFBLEVBQzlFLE1BQU0sTUFBTSxNQUFLLE1BQU0sV0FBVztBQUFBLEVBQ2xDLElBQUk7QUFBQSxFQUNKLElBQUk7QUFBQSxJQUNGLFFBQVEsWUFBWSxHQUFHLEVBQUUsT0FBTyxDQUFDLE1BQU0sRUFBRSxTQUFTLE9BQU8sQ0FBQztBQUFBLElBQzFELE1BQU07QUFBQSxJQUNOLFVBQVUsRUFBRSxVQUFVLENBQUMsRUFBRSxDQUFDO0FBQUEsSUFDMUI7QUFBQTtBQUFBLEVBR0YsTUFBTSxPQUFjLENBQUM7QUFBQSxFQUNyQixXQUFXLEtBQUssT0FBTztBQUFBLElBQ3JCLE1BQU0sT0FBTyxNQUFLLEtBQUssQ0FBQztBQUFBLElBQ3hCLElBQUk7QUFBQSxNQUNGLE1BQU0sS0FBSyxLQUFLLE1BQU0sYUFBYSxNQUFNLE1BQU0sQ0FBQztBQUFBLE1BQ2hELEtBQUssS0FBSztBQUFBLFFBQ1IsSUFBSSxFQUFFLFFBQVEsV0FBVyxFQUFFO0FBQUEsUUFDM0IsT0FBTyxHQUFHO0FBQUEsUUFDVixVQUFVLE1BQU0sUUFBUSxHQUFHLFFBQVEsSUFBSSxHQUFHLFNBQVMsU0FBUztBQUFBLFFBQzVELE9BQU8sU0FBUyxJQUFJLEVBQUU7QUFBQSxNQUN4QixDQUFDO0FBQUEsTUFDRCxNQUFNO0FBQUEsRUFHVjtBQUFBLEVBQ0EsS0FBSyxLQUFLLENBQUMsR0FBRyxNQUFNLEVBQUUsUUFBUSxFQUFFLEtBQUs7QUFBQSxFQUtyQyxVQUFVLEVBQUUsVUFBVSxLQUFLLENBQUM7QUFBQTtBQUs5QixlQUFlLFNBQVMsQ0FBQyxTQUE2QixXQUFtQjtBQUFBLEVBQ3ZFLE1BQU0sT0FBTyxJQUFJLEtBQUssU0FBUztBQUFBLEVBQy9CLElBQUksQ0FBRSxNQUFNLEtBQUssT0FBTztBQUFBLElBQUksSUFBSSxvQkFBb0IsYUFBYSxXQUFXO0FBQUEsRUFDNUUsTUFBTSxRQUFRLElBQUksV0FBVyxNQUFNLEtBQUssWUFBWSxDQUFDO0FBQUEsRUFDckQsTUFBTSxNQUFNLElBQUksSUFBSSxhQUFhLFFBQVEsRUFBRSxPQUFPLEtBQUssRUFBRSxPQUFPLEtBQUssRUFBRSxNQUFNLEdBQUcsRUFBRTtBQUFBLEVBQ2xGLE1BQU0sT0FBTyxNQUFNLElBQUksSUFBSSxNQUFNLEtBQUssRUFBRSxTQUFTO0FBQUEsRUFDakQsTUFBTSxRQUFRLFNBQVM7QUFBQSxJQUNyQixNQUFNO0FBQUEsSUFDTixNQUFNO0FBQUEsSUFDTixNQUFNLENBQUMsS0FBSyxTQUFTLEdBQUcsS0FBSyxVQUFVLENBQUM7QUFBQSxJQUN4QztBQUFBLEVBQ0YsQ0FBQztBQUFBO0FBS0gsZUFBZSxhQUFhLENBQUMsU0FBNkIsT0FBeUM7QUFBQSxFQUNqRyxNQUFNLE1BQU0sT0FBTyxNQUFNLFNBQVMsV0FBVyxNQUFNLE9BQU87QUFBQSxFQUMxRCxNQUFNLFFBQVEsSUFBSSxNQUFNLEdBQUcsRUFBRSxJQUFJLENBQUMsTUFBTSxTQUFTLEVBQUUsS0FBSyxHQUFHLEVBQUUsQ0FBQztBQUFBLEVBQzlELElBQUksTUFBTSxXQUFXLEtBQUssTUFBTSxLQUFLLENBQUMsTUFBTSxPQUFPLE1BQU0sQ0FBQyxDQUFDLEdBQUc7QUFBQSxJQUM1RCxJQUFJLHlFQUF5RTtBQUFBLEVBQy9FO0FBQUEsRUFDQSxNQUFNLFVBQW1DLEVBQUUsTUFBTSxNQUFNO0FBQUEsRUFDdkQsSUFBSSxPQUFPLE1BQU0sU0FBUztBQUFBLElBQVUsUUFBUSxPQUFPLE1BQU07QUFBQSxFQUN6RCxJQUFJLE9BQU8sTUFBTSxTQUFTO0FBQUEsSUFBVSxRQUFRLE9BQU8sTUFBTTtBQUFBLEVBQ3pELE1BQU0sUUFBUSxTQUFTLEVBQUUsTUFBTSxlQUFlLFFBQVEsQ0FBQztBQUFBO0FBT3pELGVBQWUsV0FBVyxDQUFDLFNBQWtCO0FBQUEsRUFDM0MsTUFBTSxJQUFJLGVBQWUsT0FBTztBQUFBLEVBQ2hDLFFBQVEsUUFBUSxTQUFTLE1BQU0sSUFBSSxFQUFFLE1BQU0sT0FBTyxRQUFRO0FBQUEsRUFDMUQsSUFBSSxXQUFXO0FBQUEsSUFBSyxJQUFJLHNCQUFzQixXQUFXLFVBQVU7QUFBQSxFQUNuRSxNQUFNLE1BQU8sS0FBb0QsT0FBTztBQUFBLEVBQ3hFLE1BQU0sT0FBTyxLQUFLO0FBQUEsRUFDbEIsSUFBSSxDQUFDO0FBQUEsSUFBTSxJQUFJLDRFQUFzRSxVQUFVO0FBQUEsRUFDL0YsSUFBSTtBQUFBLEVBQ0osSUFBSTtBQUFBLElBQ0YsV0FBVyxNQUFNLFNBQVMsSUFBSTtBQUFBLElBQzlCLE9BQU8sR0FBRztBQUFBLElBQ1YsSUFBSSxhQUFhO0FBQUEsTUFBZSxJQUFJLG9CQUFvQixFQUFFLFdBQVcsVUFBVTtBQUFBLElBQy9FLE1BQU07QUFBQTtBQUFBLEVBRVIsTUFBTSxXQUFzQixTQUFTLFNBQVMsSUFBSSxDQUFDLE9BQU87QUFBQSxJQUN4RCxJQUFJLE1BQU0sR0FBRztBQUFBLElBQ2IsTUFBTSxFQUFFO0FBQUEsSUFDUixNQUFNLEVBQUU7QUFBQSxJQUNSLE1BQU0sRUFBRTtBQUFBLElBQ1IsUUFBUTtBQUFBLEVBQ1YsRUFBRTtBQUFBLEVBQ0YsTUFBTSxPQUFPLFNBQVMsV0FBVyxZQUFNLFNBQVMsU0FBUyxRQUFRLENBQUMsTUFBTTtBQUFBLEVBQ3hFLFFBQVEsT0FBTyxNQUFNLHNCQUFzQixTQUFTLHdCQUF3QixPQUFPO0FBQUEsQ0FBUTtBQUFBLEVBQzNGLE1BQU0sUUFBUSxTQUFTLEVBQUUsTUFBTSxnQkFBZ0IsU0FBUyxDQUFDO0FBQUE7QUFLM0QsU0FBUyxRQUFRLENBQUMsTUFBc0I7QUFBQSxFQUN0QyxNQUFNLFVBQVUsTUFBTSxLQUFLLFFBQVEsRUFBRSxFQUNsQyxJQUFJLENBQUMsTUFBTyxrQkFBa0IsS0FBSyxDQUFDLElBQUksSUFBSSxHQUFJLEVBQ2hELEtBQUssRUFBRSxFQUNQLFFBQVEsUUFBUSxFQUFFO0FBQUEsRUFDckIsT0FBTyxXQUFXO0FBQUE7QUFPYixTQUFTLGNBQWMsQ0FBQyxNQUFjLFNBQXlCO0FBQUEsRUFDcEUsT0FBTyxHQUFHLFNBQVMsSUFBSSxJQUFJLFlBQVksU0FBUyxLQUFLLElBQUk7QUFBQTtBQVczRCxlQUFlLFVBQVUsQ0FBQyxTQUE2QixPQUF5QztBQUFBLEVBQzlGLE1BQU0sSUFBSSxlQUFlLE9BQU87QUFBQSxFQUNoQyxJQUFJLENBQUMsRUFBRTtBQUFBLElBQVcsSUFBSSw4REFBd0QsVUFBVTtBQUFBLEVBR3hGLElBQUksUUFBcUIsTUFBTSxXQUFXLE9BQU8sU0FBUztBQUFBLEVBQzFELElBQUksT0FBTyxNQUFNLFVBQVUsVUFBVTtBQUFBLElBQ25DLElBQUksQ0FBQyxDQUFDLFFBQVEsT0FBTyxNQUFNLEVBQUUsU0FBUyxNQUFNLEtBQUssR0FBRztBQUFBLE1BQ2xELElBQUksc0NBQXNDLE1BQU0sUUFBUTtBQUFBLElBQzFEO0FBQUEsSUFDQSxRQUFRLE1BQU07QUFBQSxFQUNoQjtBQUFBLEVBS0EsTUFBTSxXQUFXLE9BQU8sTUFBTSxVQUFVLFdBQVcsTUFBTSxRQUFRO0FBQUEsRUFJakUsTUFBTSxnQkFBZ0IsV0FBVyxrQkFBa0IsUUFBUSxJQUFJO0FBQUEsRUFDL0QsTUFBTSxhQUFhLFlBQVksQ0FBQyxnQkFBZ0IsV0FBVztBQUFBLEVBSTNELE1BQU0sZ0JBQWdCLE9BQU8sTUFBTSxVQUFVLFdBQVcsTUFBTSxRQUFRO0FBQUEsRUFDdEUsTUFBTSxRQUNKLFVBQVUsU0FDTixTQUNDLGtCQUNBLGdCQUFrQixTQUFvQixNQUFNLEdBQUcsRUFBRSxNQUFNLFVBQVksWUFBWTtBQUFBLEVBSXRGLE1BQU0sTUFBTSxPQUFPLE1BQU0sUUFBUSxXQUFXLFNBQVMsTUFBTSxLQUFLLEVBQUUsSUFBSTtBQUFBLEVBQ3RFLElBQUksT0FBTyxNQUFNLEdBQUc7QUFBQSxJQUFHLElBQUksd0JBQXdCO0FBQUEsRUFDbkQsTUFBTSxXQUNKLE9BQU8sTUFBTSxRQUFRLFdBQ2pCLElBQUksSUFDRixNQUFNLElBQ0gsTUFBTSxHQUFHLEVBQ1QsSUFBSSxDQUFDLE1BQU0sRUFBRSxLQUFLLENBQUMsRUFDbkIsT0FBTyxPQUFPLENBQ25CLElBQ0E7QUFBQSxFQUVOLFFBQVEsUUFBUSxTQUFTLE1BQU0sSUFBSSxFQUFFLE1BQU0sT0FBTyxRQUFRO0FBQUEsRUFDMUQsSUFBSSxXQUFXO0FBQUEsSUFBSyxJQUFJLHNCQUFzQixXQUFXLFVBQVU7QUFBQSxFQUNuRSxNQUFNLEtBQU0sS0FBMEU7QUFBQSxFQUN0RixNQUFNLGFBQWEsSUFBSSxRQUFRO0FBQUEsRUFDL0IsSUFBSSxDQUFDO0FBQUEsSUFDSCxJQUFJLDRFQUFzRSxVQUFVO0FBQUEsRUFDdEYsSUFBSSxZQUFZLElBQUksWUFBWSxDQUFDLEdBQUcsT0FBTyxDQUFDLE1BQU0sRUFBRSxXQUFXLFNBQVM7QUFBQSxFQUN4RSxJQUFJO0FBQUEsSUFBVSxXQUFXLFNBQVMsT0FBTyxDQUFDLE1BQU0sU0FBUyxJQUFJLEVBQUUsRUFBRSxDQUFDO0FBQUEsRUFJbEUsSUFBSSxZQUFZO0FBQUEsRUFDaEIsSUFBSSxVQUFVLFFBQVE7QUFBQSxJQUNwQixNQUFNLFNBQVMsU0FBUztBQUFBLElBQ3hCLFdBQVcsU0FBUyxPQUFPLENBQUMsTUFBTSxhQUFhLEVBQUUsTUFBTSxLQUFLLENBQUM7QUFBQSxJQUM3RCxZQUFZLFNBQVMsU0FBUztBQUFBLEVBQ2hDO0FBQUEsRUFDQSxJQUFJLENBQUMsU0FBUyxRQUFRO0FBQUEsSUFDcEIsSUFDRSxZQUFZLElBQ1IsNEJBQXNCLDZCQUE2QixjQUFjLElBQUksVUFBVSwwQkFBMEIsY0FBYyxJQUFJLEtBQUssd0NBQ2hJLFdBQ0UsK0NBQ0EsMERBQ1I7QUFBQSxFQUNGO0FBQUEsRUFFQSxNQUFNLElBQUksRUFBRSxNQUFNLFFBQVEsUUFBUSxFQUFFLE1BQU0sVUFBVSxNQUFNLE1BQU0sTUFBTSxtQkFBYSxDQUFDO0FBQUEsRUFDcEYsSUFBSSxPQUFPO0FBQUEsRUFDWCxJQUFJLFNBQVM7QUFBQSxFQUNiLElBQUk7QUFBQSxJQUNGLFdBQVcsTUFBTSxVQUFVO0FBQUEsTUFDekIsTUFBTSxVQUFVLE1BQUssRUFBRSxXQUFXLGVBQWUsR0FBRyxNQUFNLEtBQUssQ0FBQztBQUFBLE1BQ2hFLElBQUk7QUFBQSxRQUdGLE1BQU0sU0FBUyxnQkFDWCxNQUFNLGtCQUFrQixJQUN0QjtBQUFBLFVBQ0UsWUFBWSxNQUFLLEVBQUUsV0FBVyxlQUFlLEdBQUcsTUFBTSxNQUFNLENBQUM7QUFBQSxVQUM3RCxNQUFNLEdBQUc7QUFBQSxVQUNULE1BQU0sR0FBRztBQUFBLFFBQ1gsR0FDQSxTQUNBLEVBQUUsT0FBTyxTQUFTLENBQ3BCLElBQ0EsTUFBTSxhQUFhLElBQUksRUFBRSxZQUFZLE1BQU0sR0FBRyxNQUFNLE1BQU0sR0FBRyxLQUFLLEdBQUcsU0FBUztBQUFBLFVBQzVFO0FBQUEsVUFDQTtBQUFBLFVBQ0EsT0FBTztBQUFBLFFBQ1QsQ0FBQztBQUFBLFFBQ0wsTUFBTSxJQUFJLEVBQUUsTUFBTSxRQUFRLFFBQVE7QUFBQSxVQUNoQyxNQUFNO0FBQUEsVUFDTixJQUFJLEdBQUc7QUFBQSxVQUdQLFNBQVM7QUFBQSxZQUNQLElBQUksTUFBTSxHQUFHO0FBQUEsWUFDYixPQUFPO0FBQUEsWUFDUCxNQUFNLFVBQVUsU0FBUyxRQUFRLGdCQUFnQixVQUFVO0FBQUEsWUFDM0QsTUFBTSxPQUFPO0FBQUEsWUFDYixLQUFLO0FBQUEsVUFDUDtBQUFBLFVBQ0EsUUFBUTtBQUFBLFFBQ1YsQ0FBQztBQUFBLFFBQ0Q7QUFBQSxRQUNBLFFBQVEsT0FBTyxNQUFNLGVBQWUsR0FBRyxTQUFTLEdBQUcsU0FBUyxpQkFBVyxPQUFPO0FBQUEsQ0FBUTtBQUFBLFFBQ3RGLE9BQU8sR0FBRztBQUFBLFFBQ1Y7QUFBQSxRQUNBLFFBQVEsT0FBTyxNQUNiLDBCQUEwQixHQUFHLFNBQVMsYUFBYSxRQUFRLEVBQUUsVUFBVSxPQUFPLENBQUM7QUFBQSxDQUNqRjtBQUFBO0FBQUEsSUFFSjtBQUFBLFlBQ0E7QUFBQSxJQUNBLE1BQU0sSUFBSSxFQUFFLE1BQU0sUUFBUSxRQUFRLEVBQUUsTUFBTSxVQUFVLE1BQU0sTUFBTSxDQUFDO0FBQUE7QUFBQSxFQUVuRSxVQUFVLEVBQUUsSUFBSSxNQUFNLEtBQUssTUFBTSxRQUFRLE9BQU8sU0FBUyxRQUFRLFdBQVcsT0FBTyxNQUFNLENBQUM7QUFBQTtBQUc1RixTQUFTLFVBQVUsQ0FBQyxHQUFtQjtBQUFBLEVBQ3JDLE9BQU8sRUFBRSxRQUNQLFdBQ0EsQ0FBQyxPQUFPLEVBQUUsS0FBSyxTQUFTLEtBQUssUUFBUSxLQUFLLFFBQVEsS0FBSyxTQUFTLEdBQUcsRUFDckU7QUFBQTtBQWlCRixTQUFTLGdCQUFnQixDQUFDLE9BQWUsUUFBaUM7QUFBQSxFQUN4RSxNQUFNLFFBQVEsQ0FBQyxHQUFHLElBQUksSUFBSSxPQUFPLElBQUksQ0FBQyxNQUFNLEVBQUUsSUFBSSxDQUFDLENBQUMsRUFBRSxLQUFLO0FBQUEsRUFDM0QsTUFBTSxZQUFZLENBQUMsT0FBTyxHQUFHLEtBQUssRUFDL0IsSUFBSSxDQUFDLE1BQU07QUFBQSxJQUNWLE1BQU0sSUFBSSxNQUFNLFFBQVEsT0FBTyxTQUFTLE9BQU8sT0FBTyxDQUFDLE1BQU0sRUFBRSxTQUFTLENBQUMsRUFBRTtBQUFBLElBQzNFLE9BQU8sc0JBQXNCLE1BQU0sUUFBUSxZQUFZLG9CQUFvQixXQUFXLENBQUMsTUFBTSxXQUFXLENBQUMscUJBQXFCO0FBQUEsR0FDL0gsRUFDQSxLQUFLLEVBQUU7QUFBQSxFQUNWLE1BQU0sUUFBUSxPQUNYLElBQ0MsQ0FBQyxNQUFNLHlDQUF5QyxXQUFXLEVBQUUsSUFBSTtBQUFBLHVDQUNoQyxXQUFXLEVBQUUsSUFBSSxXQUFXLFdBQVcsRUFBRSxJQUFJO0FBQUE7QUFBQSwrQkFFckQsV0FBVyxFQUFFLElBQUk7QUFBQSwrQkFDakIsV0FBVyxFQUFFLElBQUksVUFBTSxXQUFXLEVBQUUsS0FBSyxJQUFJLEVBQUUsT0FBTyxLQUFLLFdBQVcsRUFBRSxJQUFJLE9BQU87QUFBQTtBQUFBLGdCQUc5RyxFQUNDLEtBQUs7QUFBQSxDQUFJO0FBQUEsRUFDWixPQUFPO0FBQUE7QUFBQSxTQUVBLFdBQVcsS0FBSztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLHFCQXFDZixXQUFXLEtBQUssZ0NBQTJCLE9BQU8sZUFBZSxPQUFPLFdBQVcsSUFBSSxLQUFLO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsd0RBYTlDO0FBQUE7QUFBQTtBQUFBLEVBR3REO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUF1QkYsZUFBZSxTQUFTLENBQUMsU0FBNkIsT0FBeUM7QUFBQSxFQUM3RixNQUFNLElBQUksZUFBZSxPQUFPO0FBQUEsRUFDaEMsSUFBSSxDQUFDLEVBQUU7QUFBQSxJQUFXLElBQUkseURBQW1ELFVBQVU7QUFBQSxFQUNuRixNQUFNLFdBQ0osT0FBTyxNQUFNLFFBQVEsV0FDakIsSUFBSSxJQUNGLE1BQU0sSUFDSCxNQUFNLEdBQUcsRUFDVCxJQUFJLENBQUMsTUFBTSxFQUFFLEtBQUssQ0FBQyxFQUNuQixPQUFPLE9BQU8sQ0FDbkIsSUFDQTtBQUFBLEVBRU4sUUFBUSxRQUFRLFNBQVMsTUFBTSxJQUFJLEVBQUUsTUFBTSxPQUFPLFFBQVE7QUFBQSxFQUMxRCxJQUFJLFdBQVc7QUFBQSxJQUFLLElBQUksc0JBQXNCLFdBQVcsVUFBVTtBQUFBLEVBQ25FLE1BQU0sS0FBTSxLQUE4RDtBQUFBLEVBQzFFLElBQUksWUFBWSxJQUFJLFlBQVksQ0FBQyxHQUFHLE9BQU8sQ0FBQyxNQUFNLEVBQUUsV0FBVyxTQUFTO0FBQUEsRUFDeEUsSUFBSTtBQUFBLElBQVUsV0FBVyxTQUFTLE9BQU8sQ0FBQyxNQUFNLFNBQVMsSUFBSSxFQUFFLEVBQUUsQ0FBQztBQUFBLEVBQ2xFLElBQUksQ0FBQyxTQUFTO0FBQUEsSUFDWixJQUFJLFdBQVcsbUNBQW1DLHVCQUF1QixVQUFVO0FBQUEsRUFDckYsTUFBTSxRQUFRLElBQUksU0FBUztBQUFBLEVBRTNCLE1BQU0sV0FBVyxNQUFLLEVBQUUsV0FBVyxjQUFjO0FBQUEsRUFDakQsTUFBTSxVQUFVO0FBQUEsRUFDaEIsSUFBSSxTQUFtQztBQUFBLEVBQ3ZDLElBQUksVUFBeUI7QUFBQSxFQUc3QixJQUFJO0FBQUEsSUFDRixPQUFPLFVBQVUsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUlqRCxNQUFNLFlBQVksTUFBSyxVQUFVLFFBQVE7QUFBQSxJQUN6QyxNQUFNLFdBQVcsTUFBSyxVQUFVLE9BQU87QUFBQSxJQUN2QyxVQUFVLFdBQVcsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUFBLElBRXhDLE1BQU0sV0FBNEIsQ0FBQztBQUFBLElBQ25DLFdBQVcsTUFBTSxVQUFVO0FBQUEsTUFDekIsTUFBTSxTQUFTLGNBQWMsRUFBRTtBQUFBLE1BQy9CLElBQUksQ0FBQztBQUFBLFFBQVE7QUFBQSxNQUNiLE1BQU0sYUFBYSxNQUFLLEVBQUUsV0FBVyxTQUFTLE9BQU8sSUFBSSxDQUFDO0FBQUEsTUFDMUQsSUFBSSxDQUFDLFdBQVcsVUFBVSxHQUFHO0FBQUEsUUFDM0IsUUFBUSxPQUFPLE1BQU0sbUNBQW1DLEdBQUcsU0FBUyxPQUFPO0FBQUEsQ0FBVTtBQUFBLFFBQ3JGO0FBQUEsTUFDRjtBQUFBLE1BQ0EsTUFBTSxXQUFXLEdBQUcsU0FBUyxHQUFHLElBQUk7QUFBQSxNQUNwQyxhQUFhLFlBQVksTUFBSyxXQUFXLFFBQVEsQ0FBQztBQUFBLE1BR2xELElBQUksV0FBMEI7QUFBQSxNQUM5QixJQUFJLE9BQU8sVUFBVSxRQUFRO0FBQUEsUUFDM0IsTUFBTSxXQUFXLE1BQUssRUFBRSxXQUFXLGVBQWUsR0FBRyxNQUFNLE1BQU0sQ0FBQztBQUFBLFFBQ2xFLElBQUksV0FBVyxRQUFRLEdBQUc7QUFBQSxVQUN4QixVQUFVLFVBQVUsRUFBRSxXQUFXLEtBQUssQ0FBQztBQUFBLFVBQ3ZDLGFBQWEsVUFBVSxNQUFLLFVBQVUsUUFBUSxDQUFDO0FBQUEsVUFDL0MsV0FBVyxTQUFTO0FBQUEsUUFDdEI7QUFBQSxNQUNGO0FBQUEsTUFDQSxTQUFTLEtBQUs7QUFBQSxRQUNaLE1BQU0sR0FBRztBQUFBLFFBQ1QsTUFBTSxHQUFHO0FBQUEsUUFDVCxPQUFPLE9BQU87QUFBQSxRQUNkLE1BQU0sT0FBTyxRQUFRO0FBQUEsUUFDckIsTUFBTSxHQUFHO0FBQUEsUUFDVCxNQUFNLFVBQVU7QUFBQSxRQUNoQixNQUFNO0FBQUEsTUFDUixDQUFDO0FBQUEsSUFDSDtBQUFBLElBQ0EsSUFBSSxDQUFDLFNBQVM7QUFBQSxNQUFRLE1BQU0sSUFBSSxNQUFNLG1EQUFtRDtBQUFBLElBRXpGLGNBQ0UsTUFBSyxVQUFVLGVBQWUsR0FDOUIsS0FBSyxVQUFVLEVBQUUsT0FBTyxPQUFPLFNBQVMsUUFBUSxRQUFRLFNBQVMsR0FBRyxNQUFNLENBQUMsQ0FDN0U7QUFBQSxJQUNBLGNBQWMsTUFBSyxVQUFVLGNBQWMsR0FBRyxpQkFBaUIsT0FBTyxRQUFRLENBQUM7QUFBQSxJQUcvRSxNQUFNLFVBQVUsTUFBSyxFQUFFLFdBQVcsT0FBTztBQUFBLElBQ3pDLE9BQU8sU0FBUyxFQUFFLE9BQU8sS0FBSyxDQUFDO0FBQUEsSUFDL0IsTUFBTSxPQUFPLElBQUksTUFBTSxDQUFDLE9BQU8sTUFBTSxNQUFNLFNBQVMsR0FBRyxHQUFHO0FBQUEsTUFDeEQsS0FBSztBQUFBLE1BQ0wsUUFBUTtBQUFBLE1BQ1IsUUFBUTtBQUFBLElBQ1YsQ0FBQztBQUFBLElBQ0QsT0FBTyxNQUFNLFNBQVMsTUFBTSxRQUFRLElBQUksQ0FBQyxJQUFJLFNBQVMsS0FBSyxNQUFNLEVBQUUsS0FBSyxHQUFHLEtBQUssTUFBTSxDQUFDO0FBQUEsSUFDdkYsSUFBSSxVQUFVO0FBQUEsTUFBRyxNQUFNLElBQUksTUFBTSxvQkFBb0IsV0FBVyxLQUFLLEtBQUssR0FBRztBQUFBLElBRTdFLE1BQU0sSUFBSSxFQUFFLE1BQU0sUUFBUSxRQUFRO0FBQUEsTUFDaEMsTUFBTTtBQUFBLE1BQ04sTUFBTTtBQUFBLE1BQ04sT0FBTyxTQUFTO0FBQUEsSUFDbEIsQ0FBQztBQUFBLElBQ0QsUUFBUSxPQUFPLE1BQU0sbUJBQW1CLFNBQVMsMEJBQW9CO0FBQUEsQ0FBVztBQUFBLElBQ2hGLFNBQVMsRUFBRSxPQUFPLFNBQVMsT0FBTztBQUFBLElBQ2xDLE9BQU8sR0FBRztBQUFBLElBQ1YsVUFBVSxhQUFhLFFBQVEsRUFBRSxVQUFVLE9BQU8sQ0FBQztBQUFBLFlBQ25EO0FBQUEsSUFDQSxPQUFPLFVBQVUsRUFBRSxXQUFXLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxJQUNqRCxNQUFNLElBQUksRUFBRSxNQUFNLFFBQVEsUUFBUSxFQUFFLE1BQU0sVUFBVSxNQUFNLE1BQU0sQ0FBQztBQUFBO0FBQUEsRUFHbkUsSUFBSSxXQUFXLENBQUM7QUFBQSxJQUFRLElBQUksa0JBQWtCLFdBQVcsYUFBYSxVQUFVO0FBQUEsRUFDaEYsVUFBVSxFQUFFLElBQUksTUFBTSxRQUFRLFNBQVMsT0FBTyxPQUFPLE1BQU0sQ0FBQztBQUFBO0FBRzlELElBQU0sT0FBTztBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQW1DYixlQUFlLElBQUksQ0FBQyxNQUFpQztBQUFBLEVBQ25ELE9BQU8sU0FBUyxRQUFRO0FBQUEsRUFDeEIsa0JBQWtCLFFBQVE7QUFBQSxFQUkxQixJQUFJLFNBQVMsWUFBWSxTQUFTLE1BQU07QUFBQSxJQUN0QyxRQUFRLE9BQU8sTUFBTSxHQUFHO0FBQUEsQ0FBUTtBQUFBLElBQ2hDLE9BQU87QUFBQSxFQUNUO0FBQUEsRUFDQSxJQUFJLFNBQVMsZUFBZSxTQUFTLE1BQU07QUFBQSxJQUN6QyxVQUFVLEVBQUUsTUFBTSxVQUFVLFNBQVMsZUFBZSxDQUFDO0FBQUEsSUFDckQsT0FBTztBQUFBLEVBQ1Q7QUFBQSxFQUNBLElBQUksU0FBUyxXQUFXO0FBQUEsSUFJdEIsUUFBUSxPQUFPLE1BQ2IsY0FBYyxTQUFTLGlCQUFpQixFQUFFLE1BQU0sb0JBQW9CLFNBQVMsTUFBTSxDQUFDLENBQ3RGO0FBQUEsSUFDQSxPQUFPO0FBQUEsRUFDVDtBQUFBLEVBSUEsSUFBSSxDQUFDLE9BQU8sSUFBSSxHQUFHO0FBQUEsSUFDakIsUUFBUSxPQUFPLE1BQ2IsY0FBYyxTQUFTLGlCQUFpQixTQUFTO0FBQUEsTUFDL0MsTUFBTTtBQUFBLE1BQ04sU0FBUztBQUFBLElBQ1gsQ0FBQyxDQUNIO0FBQUEsSUFDQSxPQUFPO0FBQUEsRUFDVDtBQUFBLEVBRUEsSUFBSTtBQUFBLEVBQ0osSUFBSTtBQUFBLEVBQ0osSUFBSTtBQUFBLEtBQ0QsRUFBRSxLQUFLLE1BQU0sSUFBSSxVQUFVLE1BQU0sSUFBSTtBQUFBLElBQ3RDLE9BQU8sR0FBRztBQUFBLElBQ1YsSUFBSSxFQUFFLGFBQWE7QUFBQSxNQUFhLE1BQU07QUFBQSxJQUN0QyxRQUFRLE9BQU8sTUFDYixjQUFjLFNBQVMsRUFBRSxTQUFTO0FBQUEsTUFDaEMsTUFBTSw0REFBc0Q7QUFBQSxNQUM1RCxTQUFTLFNBQVMsSUFBSTtBQUFBLElBQ3hCLENBQUMsQ0FDSDtBQUFBLElBQ0EsT0FBTztBQUFBO0FBQUEsRUFFVCxNQUFNLFVBQVUsT0FBTyxNQUFNLFlBQVksV0FBVyxNQUFNLFVBQVU7QUFBQSxFQUVwRSxRQUFRO0FBQUEsU0FDRDtBQUFBLE1BQ0gsTUFBTSxRQUFRLEtBQUs7QUFBQSxNQUNuQjtBQUFBLFNBQ0c7QUFBQSxNQUNILE1BQU0sUUFBUSxTQUFTLE9BQU8sTUFBTSxVQUFVLFdBQVcsU0FBUyxNQUFNLE9BQU8sRUFBRSxJQUFJLEVBQUU7QUFBQSxNQUN2RjtBQUFBLFNBQ0c7QUFBQSxNQUNILE1BQU0sU0FBUyxTQUFTLE1BQU0sU0FBUyxJQUFJO0FBQUEsTUFDM0M7QUFBQSxTQUNHLE9BQU87QUFBQSxNQUNWLE1BQU0sT0FBTyxNQUFNLFVBQVUsT0FBTyxNQUFNLFVBQVUsSUFBSSxJQUFJLEtBQUssR0FBRztBQUFBLE1BQ3BFLElBQUksQ0FBQztBQUFBLFFBQU0sSUFBSSxvQ0FBb0M7QUFBQSxNQUNuRCxNQUFNLFFBQVEsU0FBUyxFQUFFLE1BQU0sT0FBTyxLQUFLLENBQUM7QUFBQSxNQUM1QztBQUFBLElBQ0Y7QUFBQSxTQUNLLE9BQU87QUFBQSxNQUNWLElBQUksQ0FBQyxJQUFJO0FBQUEsUUFBUSxJQUFJLDBDQUEwQztBQUFBLE1BQy9ELE1BQU0sTUFBK0IsRUFBRSxNQUFNLE9BQU8sTUFBTSxJQUFJLEtBQUssR0FBRyxFQUFFO0FBQUEsTUFDeEUsSUFBSSxPQUFPLE1BQU0sWUFBWSxVQUFVO0FBQUEsUUFDckMsSUFBSSxVQUFVLE1BQU0sUUFDakIsTUFBTSxHQUFHLEVBQ1QsSUFBSSxDQUFDLE1BQU0sRUFBRSxLQUFLLENBQUMsRUFDbkIsT0FBTyxPQUFPO0FBQUEsTUFDbkI7QUFBQSxNQUNBLE1BQU0sUUFBUSxTQUFTLEdBQUc7QUFBQSxNQUMxQjtBQUFBLElBQ0Y7QUFBQSxTQUNLO0FBQUEsTUFDSCxNQUFNLFFBQVEsU0FBUztBQUFBLFFBQ3JCLE1BQU07QUFBQSxRQUNOLE1BQU0sSUFBSSxPQUFPO0FBQUEsUUFDakIsTUFBTSxJQUFJLE1BQU0sQ0FBQyxFQUFFLEtBQUssR0FBRztBQUFBLE1BQzdCLENBQUM7QUFBQSxNQUNEO0FBQUEsU0FDRztBQUFBLE1BQ0gsSUFBSSxDQUFDLElBQUk7QUFBQSxRQUFRLElBQUksMkJBQTJCO0FBQUEsTUFDaEQsTUFBTSxVQUFVLFNBQVMsSUFBSSxFQUFFO0FBQUEsTUFDL0I7QUFBQSxTQUNHO0FBQUEsTUFDSCxNQUFNLFlBQVksT0FBTztBQUFBLE1BQ3pCO0FBQUEsU0FDRztBQUFBLE1BQ0gsTUFBTSxXQUFXLFNBQVMsS0FBSztBQUFBLE1BQy9CO0FBQUEsU0FDRztBQUFBLE1BQ0gsTUFBTSxVQUFVLFNBQVMsS0FBSztBQUFBLE1BQzlCO0FBQUEsU0FDRztBQUFBLE1BQ0gsTUFBTSxjQUFjLFNBQVMsS0FBSztBQUFBLE1BQ2xDO0FBQUEsU0FDRztBQUFBLE1BQ0gsSUFBSSxDQUFDLElBQUk7QUFBQSxRQUFRLElBQUksNEJBQTRCO0FBQUEsTUFDakQsTUFBTSxRQUFRLFNBQVMsRUFBRSxNQUFNLGtCQUFrQixJQUFJLElBQUksR0FBRyxDQUFDO0FBQUEsTUFDN0Q7QUFBQSxTQUNHLE9BQU87QUFBQSxNQUdWLE1BQU0sTUFBTSxNQUFNLFVBQVUsT0FBTyxNQUFNLFVBQVUsSUFBSSxJQUFJLEtBQUssR0FBRztBQUFBLE1BQ25FLElBQUksQ0FBQztBQUFBLFFBQUssSUFBSSxxREFBcUQ7QUFBQSxNQUNuRSxJQUFJO0FBQUEsTUFDSixJQUFJO0FBQUEsUUFDRixPQUFPLEtBQUssTUFBTSxHQUFHO0FBQUEsUUFDckIsTUFBTTtBQUFBLFFBQ04sSUFBSSw2QkFBNkI7QUFBQTtBQUFBLE1BRW5DLE1BQU0sUUFBUSxTQUFTLElBQUk7QUFBQSxNQUMzQjtBQUFBLElBQ0Y7QUFBQSxTQUNLO0FBQUEsTUFDSCxNQUFNLFFBQVEsU0FBUyxFQUFFLE1BQU0sUUFBUSxDQUFDO0FBQUEsTUFDeEM7QUFBQSxTQUNHO0FBQUEsTUFDSCxRQUFRLE9BQU87QUFBQSxNQUNmO0FBQUEsU0FDRztBQUFBLE1BQ0gsWUFBWTtBQUFBLE1BQ1o7QUFBQSxTQUNHO0FBQUEsTUFDSCxRQUFRLE9BQU8sTUFBTSxHQUFHO0FBQUEsQ0FBUTtBQUFBLE1BQ2hDO0FBQUE7QUFBQSxNQU9BLElBQUksd0JBQXdCLFNBQVMsVUFBVTtBQUFBO0FBQUEsRUFHbkQsT0FBTztBQUFBO0FBR1QsSUFBSSxrQkFBa0I7QUFBQSxFQVFwQixRQUFRLFdBQVcsTUFBTSxLQUFLLFFBQVEsS0FBSyxNQUFNLENBQUMsQ0FBQztBQUNyRDtBQWlCQSxlQUFzQixHQUFHLEdBQW9CO0FBQUEsRUFDM0MsT0FBTyxNQUFNLEtBQUssUUFBUSxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQUE7IiwKICAiZGVidWdJZCI6ICJFNjRBQkExMjI1MEU0NjZCNjQ3NTZFMjE2NDc1NkUyMSIsCiAgIm5hbWVzIjogW10KfQ==
