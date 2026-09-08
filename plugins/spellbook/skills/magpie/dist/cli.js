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
function sleep2(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function sessionFilePath(session) {
  return session ? join3(tmpdir(), `magpie-${session}.json`) : join3(tmpdir(), "magpie-latest.json");
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
    await sleep2(80);
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
  let boundId = session;
  let grounded = false;
  return await tailEvents({
    resolve: () => {
      const s = readSession(boundId);
      if (!s)
        return null;
      if (!boundId)
        boundId = s.session_id;
      if (!grounded) {
        grounded = true;
        process.stdout.write(`${JSON.stringify({ type: "grounding", session_id: s.session_id, port: s.port })}
`);
      }
      return `http://127.0.0.1:${s.port}`;
    },
    onUnresolved: ({ everResolved }) => {
      if (everResolved)
        return "stop";
      process.stderr.write(`# no session yet, retrying\u2026
`);
      return "retry";
    },
    path: "/events",
    since: sinceArg,
    cursorOf: (ev) => ev.id,
    terminal: (ev) => ev.type === "closed",
    idleMs: 45000,
    onComment: () => process.stderr.write(`: magpie-keepalive
`)
  });
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
  const [verb, ...rest] = argv;
  setCurrentCommand(verb ?? null);
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
      return await cmdTail(session, typeof flags.since === "string" ? parseInt(flags.since, 10) : -1);
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

//# debugId=501FF9E44B8E457864756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL21hZ3BpZS9iYWNrZW5kL2NsaS50cyIsICIuLi9zY3JpcHRzL2JhY2tlbmQudHMiLCAiLi4vc2hhcmVkL2FscGhhLnRzIiwgIi4uL3NjcmlwdHMvZGlzY292ZXIudHMiLCAiLi4vc2hhcmVkL3R5cGVzLnRzIiwgIi4uL3NjcmlwdHMvcmVkdWNlLnRzIiwgIi4uL3NoYXJlZC92ZXJzaW9ucy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L2xpYi9wcmludEpzb24udHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2Vycm9ycy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvdGFpbEV2ZW50cy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsKICAgICIjIS91c3IvYmluL2VudiBidW5cblxuLy8gbWFncGllIENMSSDigJQgdGhpbiwgc3RhdGVsZXNzIHdyYXBwZXIgYXJvdW5kIHRoZSBwZXItc2Vzc2lvbiBkYWVtb24ncyBIVFRQXG4vLyBzdXJmYWNlIChzZXJ2ZXIudHMpLiBPbmUgSFRUUCByb3VuZC10cmlwIHBlciB2ZXJiLiBgdGFpbGAgc3RyZWFtcyBTU0UgdXNlclxuLy8gZXZlbnRzIGFzIEpTT05MIGZvciBNb25pdG9yIHRvIHdyYXAgKGEgYGdyb3VuZGluZ2AgYW5jaG9yIGxpbmUgZmlyc3QpLlxuLy9cbi8vIExpZmVjeWNsZTpcbi8vICAgYnVuIGNsaS50cyBvcGVuIFstLXRpdGxlIC4uXSBbLS1pbnRlbnQgLi5dIFstLXJlc3RvcmUgPGlkPl0gWy0tdGltZW91dCBTXSBbLS1uby1vcGVuXVxuLy8gICBidW4gY2xpLnRzIHRhaWwgWy0tc2luY2UgTl0gICAgICAgICAgICAjIFNTRSB1c2VyIGV2ZW50cyDihpIgSlNPTkwgKE1vbml0b3IgdGhpcylcbi8vICAgYnVuIGNsaS50cyBzdGF0ZSBbLS1mdWxsXSAgICAgICAgICAgICAgIyBsZWFuIHN0YXRlIHNuYXBzaG90IChhZGQgLS1mdWxsIGZvciByYXcpXG4vL1xuLy8gRHJpdmluZyB0aGUgc3VyZmFjZSAoUE9TVCAvY21kKTpcbi8vICAgYnVuIGNsaS50cyBzYXkgW3RleHQuLi5dIFstLXN0ZGluXSAgICAgICAgICAgICAgICAgIyBwb3N0IGFnZW50IGRpYWxvZ3VlICh0ZXh0IG9yIHBpcGVkIHN0ZGluKVxuLy8gICBidW4gY2xpLnRzIGFzayA8dGV4dC4uLj4gWy0tb3B0aW9ucyBcImF8YnxjXCJdICAgICAgICMgYXNrIHRoZSB1c2VyIChpbi10aHJlYWQpXG4vLyAgIGJ1biBjbGkudHMgc3RhdHVzIG9uIFt0ZXh0Li4uXSB8IHN0YXR1cyBvZmYgICAgICAgICMgdGhlIHdvcmtpbmcgc3Bpbm5lclxuLy8gICBidW4gY2xpLnRzIHNvdXJjZSA8aW1hZ2VQYXRoPiAgICAgICAgICAgICAgICAgICAgICAjIHNldCB0aGUgY29tcG9zaXRlIHVuZGVyIHJldmlldyAoY29tcHV0ZXMgc2hhICsgc2l6ZSlcbi8vICAgYnVuIGNsaS50cyBjbWQgWy0tc3RkaW5dICAgICAgICAgICAgICAgICAgICAgICAgICAgICMgUE9TVCBhIHJhdyBBZ2VudENvbW1hbmQgSlNPTiBib2R5IChmcm9tIHN0ZGluKVxuLy8gICBidW4gY2xpLnRzIGNsb3NlIHwgaW5mbyB8IHNlc3Npb25zIHwgaGVscFxuLy9cbi8vIGAtLXN0ZGluYCByZWFkcyB0aGUgYm9keSBmcm9tIHN0ZGluIHNvIG5hdHVyYWwtbGFuZ3VhZ2UgdGV4dCBpcyBuZXZlciBpbmxpbmVkXG4vLyBpbnRvIGEgc2hlbGwtcGFyc2VkIGFyZy4gUGF5bG9hZCBvbiBzdGRvdXQsIGxpdmVuZXNzL2VjaG8gb24gc3RkZXJyLlxuLy9cbi8vIEFsbCB2ZXJicyB0YXJnZXQgdGhlIG1vc3QgcmVjZW50IHNlc3Npb24gYnkgZGVmYXVsdDsgcGFzcyAtLXNlc3Npb24gPGlkPi5cblxuaW1wb3J0IHsgc3Bhd24gfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQge1xuICBjb3B5RmlsZVN5bmMsXG4gIGV4aXN0c1N5bmMsXG4gIG1rZGlyU3luYyxcbiAgcmVhZGRpclN5bmMsXG4gIHJlYWRGaWxlU3luYyxcbiAgcm1TeW5jLFxuICBzdGF0U3luYyxcbiAgd3JpdGVGaWxlU3luYyxcbn0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgZGlybmFtZSwgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcbmltcG9ydCB7IHBhcnNlQXJncyBhcyBub2RlUGFyc2VBcmdzIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuaW1wb3J0IHtcbiAgdHlwZSBBbHBoYVBvbGljeSxcbiAgaXNNZWRpYUZvcmdlTW9kZWwsXG4gIG1lZGlhRm9yZ2VCYWNrZW5kLFxuICByZW1iZ0JhY2tlbmQsXG4gIHNob3VsZFJlbW92ZSxcbn0gZnJvbSBcIi4uLy4uLy4uL3BsdWdpbnMvc3BlbGxib29rL3NraWxscy9tYWdwaWUvc2NyaXB0cy9iYWNrZW5kXCI7XG5pbXBvcnQgeyBEaXNjb3ZlckVycm9yLCBkaXNjb3ZlciB9IGZyb20gXCIuLi8uLi8uLi9wbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvbWFncGllL3NjcmlwdHMvZGlzY292ZXJcIjtcbmltcG9ydCB7IG5ld0lkIH0gZnJvbSBcIi4uLy4uLy4uL3BsdWdpbnMvc3BlbGxib29rL3NraWxscy9tYWdwaWUvc2NyaXB0cy9yZWR1Y2VcIjtcbmltcG9ydCB0eXBlIHsgRWxlbWVudCB9IGZyb20gXCIuLi8uLi8uLi9wbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvbWFncGllL3NoYXJlZC90eXBlc1wiO1xuaW1wb3J0IHsgY2hvc2VuVmVyc2lvbiB9IGZyb20gXCIuLi8uLi8uLi9wbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvbWFncGllL3NoYXJlZC92ZXJzaW9uc1wiO1xuaW1wb3J0IHsgcHJpbnRKc29uIH0gZnJvbSBcIi4uLy4uL2tpdC9saWIvcHJpbnRKc29uXCI7XG5pbXBvcnQgeyBkaWUsIGVycm9yRW52ZWxvcGUsIHJlcG9ydENsaUVycm9yLCBzZXRDdXJyZW50Q29tbWFuZCB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9lcnJvcnNcIjtcbmltcG9ydCB7IHRhaWxFdmVudHMgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvdGFpbEV2ZW50c1wiO1xuXG4vLyBTd2FsbG93IEVQSVBFIChhIGRvd25zdHJlYW0gYGhlYWRgL01vbml0b3IgY2xvc2luZyBvdXIgc3Rkb3V0IHNob3VsZG4ndCBjcmFzaCkuXG5wcm9jZXNzLnN0ZG91dC5vbihcImVycm9yXCIsIChlOiBOb2RlSlMuRXJybm9FeGNlcHRpb24pID0+IHtcbiAgaWYgKGUuY29kZSA9PT0gXCJFUElQRVwiKSBwcm9jZXNzLmV4aXQoMCk7XG59KTtcblxuY29uc3QgU0NSSVBUX0RJUiA9IGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcbi8vIFNlZSB0aGUgYXN0cm9sYWJlIHR3aW46IGBkaXN0L2AgYW5kIGBzY3JpcHRzL2AgYXJlIHRoZSBzYW1lIGRlcHRoLCBzbyBvbmx5XG4vLyBhIFNJQkxJTkctcmVsYXRpdmUgcGF0aCBicmVha3Mgd2hlbiB0aGlzIGV4ZWN1dGVzIGFzIGAuLi9kaXN0L2NsaS5qc2AuXG5jb25zdCBTRVJWRVJfU0NSSVBUID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwic2NyaXB0c1wiLCBcInNlcnZlci50c1wiKTtcbmNvbnN0IFNLSUxMX1JPT1QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIik7XG5jb25zdCBESVNUX0RJUiA9IGpvaW4oU0tJTExfUk9PVCwgXCJkaXN0XCIpO1xuLy8gZGV2OiB0aGUgZGFlbW9uIHNlcnZlcyBhIEJ1bi1idW5kbGVkIFJlYWN0IHN1cmZhY2UsIGFuZCBCdW4gcmVhZHMgYnVuZmlnLnRvbWxcbi8vICh0aGUgVGFpbHdpbmQgcGx1Z2luKSBmcm9tIGN3ZCBPTkxZLCBzbyB0aGUgZGFlbW9uJ3MgY3dkIE1VU1QgYmUgc3JjL21hZ3BpZS9cbi8vIChzZWFtcyBDb250cmFjdCA1IGN3ZC1waW4pIOKAlCBsYXVuY2hlZCBhbnl3aGVyZSBlbHNlIHRoZSBkZXYgYnVuZGxlciBjYW5ub3Rcbi8vIGNvbXBpbGUgdGhlIHN0eWxlc2hlZXQgKG1lYXN1cmVkIG9uIGdsYW1vdXI6IHRoZSBQQUdFIDUwMHMgd2l0aCBubyBzdHlsZXNoZWV0XG4vLyBsaW5rOyBub3QgXCJ1bnN0eWxlZCBhdCAyMDBcIiDigJQgdGhhdCBzZW50ZW5jZSB3YXMgbmV2ZXIgcnVuOyBtYWdwaWUncyBvd24gZmFpbHVyZVxuLy8gc2hhcGUgaXMgdW5tZWFzdXJlZCkuIHJlbGVhc2U6IGRpc3QvIGlzIHByZS1idWlsdCBhbmRcbi8vIHN0YXRpYyDigJQgbm8gYnVuZmlnIHJlYWQsIHNvIHRoaXMgcGF0aCBuZWVkIG5vdCBleGlzdCBhdCBhbGwgKGEgc291cmNlLWZyZWVcbi8vIG1hcmtldHBsYWNlIGNsb25lIGhhcyBubyB0b3AtbGV2ZWwgc3JjLyksIGFuZCBwaW5uaW5nIGN3ZCB0aGVyZSBhbnl3YXkgd291bGRcbi8vIGJyZWFrIHRoZSBzcGF3bi5cbi8vXG4vLyDim5QgVEhFIERJU0NSSU1JTkFUT1IgSVMgZGlzdC9pbmRleC5odG1sLCBOT1QgZGlzdC8uIG1hZ3BpZSdzIGRpc3QvIGhhcyBoZWxkXG4vLyBjbGkuanMgc2luY2UgU2xpY2UgMiB3aXRoIG5vIGluZGV4Lmh0bWwsIHdoaWNoIGlzIGV4YWN0bHkgd2h5IHRoaXMgZGFlbW9uXG4vLyBzdGF5ZWQgY29ycmVjdGx5IGluIGRldiBtb2RlOyB0aGUgZmlyc3Qgc3VyZmFjZSBidWlsZCB0byBsYW5kIGhlcmUgZmxpcHMgaXQuXG5jb25zdCBTVVJGQUNFX0NXRCA9IGpvaW4oU0tJTExfUk9PVCwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcInNyY1wiLCBcIm1hZ3BpZVwiKTtcblxuZnVuY3Rpb24gZGFlbW9uQ3dkKCk6IHN0cmluZyB7XG4gIGlmIChwcm9jZXNzLmVudi5TUEVMTEJPT0tfU1VSRkFDRV9NT0RFID09PSBcInJlbGVhc2VcIikgcmV0dXJuIFNLSUxMX1JPT1Q7XG4gIGlmIChwcm9jZXNzLmVudi5TUEVMTEJPT0tfU1VSRkFDRV9NT0RFID09PSBcImRldlwiKSByZXR1cm4gU1VSRkFDRV9DV0Q7XG4gIHJldHVybiBleGlzdHNTeW5jKGpvaW4oRElTVF9ESVIsIFwiaW5kZXguaHRtbFwiKSkgPyBTS0lMTF9ST09UIDogU1VSRkFDRV9DV0Q7XG59XG5cbi8vIE91ciBwbHVnaW4gdmVyc2lvbiAoZnJvbSBwbHVnaW4uanNvbikg4oCUIHRoZSBvbmUgbnVtYmVyIG1hZ3BpZSBjYW4gaG9uZXN0bHlcbi8vIHJlcG9ydCBhcyBpdHMgb3duLiBEMSBhc2tzIGEgQ0xJIHRvIGFuc3dlciBgLS12ZXJzaW9uYDsgYW4gYWdlbnQgdGhhdCBjYW5ub3Rcbi8vIHRlbGwgd2hpY2ggYnVpbGQgaXQgaXMgZHJpdmluZyBjYW5ub3QgdGVsbCBhIG1pc3NpbmcgZmVhdHVyZSBmcm9tIGEgc3RhbGVcbi8vIGluc3RhbGwuIEJlc3QtZWZmb3J0OiBudWxsIGlmIHRoZSByZWFkIGZhaWxzLCBhbmQgYC0tdmVyc2lvbmAgc2F5cyBzbyByYXRoZXJcbi8vIHRoYW4gaW52ZW50aW5nIG9uZS4gU2FtZSByZXNvbHV0aW9uIGdyYXBldmluZSB1c2VzLlxuZnVuY3Rpb24gcmVhZFBsdWdpblZlcnNpb24oKTogc3RyaW5nIHwgbnVsbCB7XG4gIHRyeSB7XG4gICAgY29uc3QgcGx1Z2luSnNvblBhdGggPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLmNsYXVkZS1wbHVnaW5cIiwgXCJwbHVnaW4uanNvblwiKTtcbiAgICByZXR1cm4gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocGx1Z2luSnNvblBhdGgsIFwidXRmLThcIikpLnZlcnNpb24gPz8gbnVsbDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cbmNvbnN0IFBMVUdJTl9WRVJTSU9OID0gcmVhZFBsdWdpblZlcnNpb24oKTtcblxudHlwZSBTZXNzaW9uID0ge1xuICB1cmw6IHN0cmluZztcbiAgcG9ydDogbnVtYmVyO1xuICBzZXNzaW9uX2lkOiBzdHJpbmc7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIGZpbGVzX2Rpcj86IHN0cmluZztcbn07XG5cbi8vIOKUgOKUgCBlcnJvciBlbnZlbG9wZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vXG4vLyDim5QgVEhFIFRBWE9OT01ZLCBUSEUgRVhJVCBDT0RFUywgVEhFIEVOVkVMT1BFIEFORCBgZGllYCBOT1cgTElWRSBPTkNFLCBhdFxuLy8gYHNyYy9raXQvd2lyZS9lcnJvcnMudHNgLiBtYWdwaWUgaGVsZCB0aGUgZnVsbGVzdCBvZiB0aGUgaG91c2UncyBmb3VyIGNvcGllc1xuLy8gYW5kIGl0IGlzIHRoZSBvbmUgdGhlIHNoYXJlZCBjb250cmFjdCB3YXMgZHJhd24gZnJvbSwgYnl0ZSBmb3IgYnl0ZSDigJQgc29cbi8vIG5vdGhpbmcgYSBjYWxsZXIgY2FuIG9ic2VydmUgYWJvdXQgYSBtYWdwaWUgZmFpbHVyZSBjaGFuZ2VkIHdoZW4gdGhpcyBtb3ZlZC5cbi8vIFRoZSBvbmUgYmVoYXZpb3VyYWwgY2hhbmdlIGlzIHRoYXQgYGRpZWAgVEhST1dTIHJhdGhlciB0aGFuIGV4aXRpbmcsIGFuZFxuLy8gYG1haW5gIHJlcG9ydHMgaXQ7IHNlZSB0aGUgZnVubmVsIHRoZXJlLlxuLy9cbi8vIFdoYXQgaXQgc2F5cywga2VwdCBoZXJlIGJlY2F1c2UgdGhpcyBpcyB3aGVyZSBhIHJlYWRlciBvZiBtYWdwaWUgbG9va3M6XG4vLyBtYWdwaWUgZGVjbGFyZXMgYGRlZmF1bHRPdXRwdXQ6IFwianNvblwiYCwgYW5kIHRoYXQgZGVjbGFyYXRpb24gaXMgYWJvdXQgRVZFUllcbi8vIHN0cmVhbSwgbm90IGp1c3QgdGhlIGhhcHB5IHBhdGguIEEgY2FsbGVyIHRoYXQgZ2V0cyBvbmUgSlNPTiBkb2N1bWVudCBmcm9tIGFcbi8vIHZlcmIgYW5kIHByb3NlIGZyb20gYSBmYWlsdXJlIGhhcyB0byBwYXJzZSB0d28gZm9ybWF0cyB0byB1c2Ugb25lIHRvb2wg4oCUIGFuZFxuLy8gdGhlIGZhaWx1cmUgaXMgdGhlIGNhc2Ugd2hlcmUgaXQgY2FuIGxlYXN0IGFmZm9yZCB0byBndWVzcy4gU28gYSBmYWlsdXJlIGlzXG4vLyBPTkUgSlNPTiBkb2N1bWVudCBvbiBzdGRlcnIsIGFuZCBzdGRvdXQgc3RheXMgZW1wdHkgYmVjYXVzZSBzdGRvdXQgY2Fycmllc1xuLy8gZGF0YSBhbmQgYSBmYWlsdXJlIGhhcyBub25lLlxuXG5mdW5jdGlvbiBzbGVlcChtczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiB7XG4gIHJldHVybiBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBtcykpO1xufVxuXG5mdW5jdGlvbiBzZXNzaW9uRmlsZVBhdGgoc2Vzc2lvbj86IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBzZXNzaW9uID8gam9pbih0bXBkaXIoKSwgYG1hZ3BpZS0ke3Nlc3Npb259Lmpzb25gKSA6IGpvaW4odG1wZGlyKCksIFwibWFncGllLWxhdGVzdC5qc29uXCIpO1xufVxuXG4vKiog4puUIE5VTEwgTUVBTlMgXCJOTyBTRVNTSU9OXCIsIEFORCBOT1RISU5HIEVMU0UuXG4gKlxuICogIFRoaXMgY2F1Z2h0IGV2ZXJ5IGVycm9yIGZyb20gdGhlIHJlYWQgYW5kIHJldHVybmVkIG51bGwsIHNvIGEgY29ycnVwdFxuICogIHBvaW50ZXIsIGFuIEVBQ0NFUywgYW5kIGFueSB0cmFuc2llbnQgdGhlIE9TIHJhaXNlcyB1bmRlciBsb2FkIGFsbCBhcnJpdmVkXG4gKiAgYXQgdGhlIGNhbGxlcnMgd2VhcmluZyBhYnNlbmNlJ3MgY2xvdGhlcyDigJQgYW5kIHRoZSBjYWxsZXJzIGFjdCBvbiBhYnNlbmNlOlxuICogIHRoZXkgcmVwb3J0IFwibm8gcnVubmluZyBzZXNzaW9uXCIsIGFuZCBhIHRhaWwgbG9vcCByZWFkcyBpdCBhcyBcInRoZSBwaW5uZWRcbiAqICBzZXNzaW9uIHdlbnQgYXdheVwiIGFuZCBleGl0cyAwLiBBIHJlc291cmNlIGZhaWx1cmUgd2FzIHRoZXJlZm9yZSByZXBvcnRlZFxuICogIGFzIGEgU1VDQ0VTU0ZVTCBlbmQgb2Ygd2F0Y2guXG4gKlxuICogIE1lYXN1cmVkIGluIGdsYW1vdXIsIHdob3NlIGNvcHkgb2YgdGhpcyBmdW5jdGlvbiBpcyBieXRlLWlkZW50aWNhbDogaXRzIENMSVxuICogIGNvbnRyYWN0IGNlbGwgZmFpbGVkIG9uY2UgdW5kZXIgdGhlIGZ1bGwgZ2F0ZSB3aXRoIHRoZSBub3RfZm91bmQgZXhpdCB3aGVyZVxuICogIHRoZSBjb250cmFjdCBzYWlkIHVzYWdlLCBhbmQgcGFzc2VkIGFsb25lIGFuZCBvbiByZS1ydW4uIEZpeGVkIHRoZXJlXG4gKiAgMjAyNi0wOS0wNzsgZm91bmQgc3RpbGwgc3RhbmRpbmcgaGVyZSAyMDI2LTA5LTA4IGJ5IHRoZSBiYWNrZW5kIGR1cGxpY2F0aW9uXG4gKiAgcmVjb24gKGRvY3MvaW52ZXN0aWdhdGlvbnMvMjAyNi0wOS0wOC1iYWNrZW5kLWR1cGxpY2F0aW9uLXJlY29uLm1kKS5cbiAqXG4gKiAgRU5PRU5UIGlzIHRoZSBvbmx5IGhvbmVzdCBhYnNlbmNlLiBFdmVyeXRoaW5nIGVsc2Ugc2F5cyB3aGF0IGl0IHdhcy5cbiAqXG4gKiAg4pqgIFRoZSBkYWVtb24gd3JpdGVzIHRoaXMgZmlsZSBhdG9taWNhbGx5IChzZXJ2ZXIudHMpLCB3aGljaCBpcyB3aGF0IGxldHNcbiAqICB1bnBhcnNlYWJsZSBjb250ZW50IGNvdW50IGFzIGNvcnJ1cHRpb24gcmF0aGVyIHRoYW4gYSBoYWxmLXdyaXR0ZW4gcmVhZC4gKi9cbmZ1bmN0aW9uIHJlYWRTZXNzaW9uKHNlc3Npb24/OiBzdHJpbmcpOiBTZXNzaW9uIHwgbnVsbCB7XG4gIGNvbnN0IHBhdGggPSBzZXNzaW9uRmlsZVBhdGgoc2Vzc2lvbik7XG4gIGxldCByYXc6IHN0cmluZztcbiAgdHJ5IHtcbiAgICByYXcgPSByZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc3QgY29kZSA9IChlIGFzIE5vZGVKUy5FcnJub0V4Y2VwdGlvbikuY29kZTtcbiAgICBpZiAoY29kZSA9PT0gXCJFTk9FTlRcIikgcmV0dXJuIG51bGw7XG4gICAgZGllKGBjYW5ub3QgcmVhZCB0aGUgc2Vzc2lvbiBwb2ludGVyICgke2NvZGUgPz8gXCJ1bmtub3duIGVycm9yXCJ9KTogJHtwYXRofWAsIFwiaW50ZXJuYWxcIik7XG4gIH1cbiAgdHJ5IHtcbiAgICByZXR1cm4gSlNPTi5wYXJzZShyYXcpIGFzIFNlc3Npb247XG4gIH0gY2F0Y2gge1xuICAgIGRpZShgdGhlIHNlc3Npb24gcG9pbnRlciBpcyBub3QgdmFsaWQgSlNPTjogJHtwYXRofWAsIFwiaW50ZXJuYWxcIik7XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbj86IHN0cmluZyk6IFNlc3Npb24ge1xuICBjb25zdCBzID0gcmVhZFNlc3Npb24oc2Vzc2lvbik7XG4gIGlmICghcykgZGllKFwibm8gcnVubmluZyBtYWdwaWUgc2Vzc2lvbiDigJQgcnVuOiBjbGkudHMgb3BlblwiLCBcIm5vdF9mb3VuZFwiKTtcbiAgcmV0dXJuIHM7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGFwaShcbiAgcG9ydDogbnVtYmVyLFxuICBtZXRob2Q6IHN0cmluZyxcbiAgcGF0aDogc3RyaW5nLFxuICBib2R5PzogdW5rbm93bixcbik6IFByb21pc2U8eyBzdGF0dXM6IG51bWJlcjsgZGF0YTogdW5rbm93biB9PiB7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH0ke3BhdGh9YCwge1xuICAgIG1ldGhvZCxcbiAgICBoZWFkZXJzOiBib2R5ICE9PSB1bmRlZmluZWQgPyB7IFwiY29udGVudC10eXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0gOiB1bmRlZmluZWQsXG4gICAgYm9keTogYm9keSAhPT0gdW5kZWZpbmVkID8gSlNPTi5zdHJpbmdpZnkoYm9keSkgOiB1bmRlZmluZWQsXG4gIH0pO1xuICBsZXQgZGF0YTogdW5rbm93biA9IG51bGw7XG4gIHRyeSB7XG4gICAgZGF0YSA9IGF3YWl0IHJlcy5qc29uKCk7XG4gIH0gY2F0Y2gge31cbiAgcmV0dXJuIHsgc3RhdHVzOiByZXMuc3RhdHVzLCBkYXRhIH07XG59XG5cbi8vIFNwbGl0IGFyZ3YgaW50byBwb3NpdGlvbmFscyArIGZsYWdzLiBgLS1mbGFnIHZhbHVlYCwgYC0tZmxhZz12YWx1ZWAsIG9yIGJvb2xlYW4uXG4vLyAjODEgLyBENCDigJQgVEhFIFJFQ09HTklaRUQgU0VULCBBVCBQQVJTRVIgQUxUSVRVREUuXG4vL1xuLy8gVGhlIGhhbmQtcm9sbGVkIHBhcnNlciBoYWQgbm8gcmVnaXN0cnksIHNvIGFuIHVua25vd24gZmxhZyB3YXMgYWNjZXB0ZWQgYXRcbi8vIGV4aXQgMCBhbmQgdGhlIHZlcmIgcmFuIGFueXdheSwgYW5kIGZyZWUgcHJvc2UgY29udGFpbmluZyBhIGAtLXdvcmRgIHdhc1xuLy8gc2lsZW50bHkgdHJ1bmNhdGVkIGF0IHRoYXQgd29yZC4gYG5vZGU6dXRpbGAgc3RyaWN0IHN1cHBsaWVzIHJlamVjdGlvbiwgdGhlXG4vLyBgPWAgZm9ybSBhbmQgdGhlIGAtLWAgdGVybWluYXRvciBmcm9tIHRoZSBzdGFuZGFyZCBsaWJyYXJ5LlxuLy9cbi8vIFR5cGVzIGFyZSB0aG90aCdzIGF1ZGl0ZWQgYXJ0aWZhY3QgKDE1IHN0cmluZyDCtyA0IGJvb2xlYW4pLCBlYWNoIHNldHRsZWQgYnlcbi8vIHVuYW1iaWd1b3VzIGV2aWRlbmNlIGF0IGV2ZXJ5IGNvbnN1bXB0aW9uIHNpdGUuIEdldHRpbmcgb25lIHdyb25nIGlzIG5vdCBhXG4vLyBuby1vcDogYSBcInN0cmluZ1wiIHRoYXQgc2hvdWxkIGJlIGJvb2xlYW4gU1dBTExPV1MgVEhFIE5FWFQgUE9TSVRJT05BTCwgYW5kIGFcbi8vIFwiYm9vbGVhblwiIHRoYXQgc2hvdWxkIGJlIHN0cmluZyBicmVha3MgdGhlIHNwYWNlIGZvcm0uXG5jb25zdCBDTElfT1BUSU9OUyA9IHtcbiAgYWxwaGE6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBiYm94OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgaWRzOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgaW50ZW50OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbGFiZWw6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBtb2RlbDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIG5hbWU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBvcHRpb25zOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcGFkOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgcmVzdG9yZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHNlc3Npb246IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzaW5jZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHRpbWVvdXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0aXRsZTogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHR5cGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBmdWxsOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIFwibm8tb3BlblwiOiB7IHR5cGU6IFwiYm9vbGVhblwiIH0sXG4gIHJlbW92ZTogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBzdGRpbjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxufSBhcyBjb25zdDtcblxuLy8gV0hJQ0ggRkxBR1MgRUFDSCBWRVJCIEFDQ0VQVFMg4oCUIGFuZCB0aGUgb25seSBzb3VyY2Ugb2YgdGhlIHZlcmIgc2V0LlxuLy9cbi8vIFRoZSBwYXJzZXIgdXNlZCB0byBlbmZvcmNlIE9ORSBHTE9CQUwgcmVnaXN0cnk6IGV2ZXJ5IHZlcmIgYWNjZXB0ZWQgZXZlcnlcbi8vIGZsYWcsIHNvIGBjbG9zZSAtLWFscGhhIGF1dG9gIGFuZCBgc2F5IC0tYmJveCAxLDIsMyw0YCBwYXJzZWQgY2xlYW4gYW5kIGRpZFxuLy8gbm90aGluZy4gQSByZWNvcmRlZC1zdXJmYWNlIGNlbnN1cyBjb3VudGVkIDI4OSBzdWNoIGZsYWcvcGF0aCBwYWlycyDigJQgMjg5XG4vLyBpbnZvY2F0aW9ucyBtYWdwaWUgYWNjZXB0ZWQgYXQgZXhpdCAwIGFuZCBjb3VsZCBub3QgYWN0IG9uLiBUaGF0IGlzIHRoZVxuLy8gZmFpbHVyZSB0aGlzIHdob2xlIGtpdCBpcyBuYW1lZCBmb3I6IHRoZSB0b29sIGRvZXMgdGhlIHdyb25nIHRoaW5nIGFuZCByZXBvcnRzXG4vLyBzdWNjZXNzLiBBbiB1bmtub3duLWZsYWcgY2hlY2sgYXQgdGhlIHJvb3QgY2Fubm90IHNlZSBpdCwgYmVjYXVzZSBub25lIG9mIHRoZVxuLy8gZmxhZ3MgYXJlIHVua25vd24g4oCUIHRoZXkgYXJlIGp1c3Qgbm90IGtub3duIEhFUkUuXG4vL1xuLy8gU28gdGhlIHJlY29nbml6ZWQgc2V0IGlzIHBlciB2ZXJiLCBhbmQgdGhpcyB0YWJsZSBpcyBpdC4gYFZFUkJTYCBpcyBkZXJpdmVkXG4vLyBmcm9tIGl0cyBrZXlzIGFuZCBlYWNoIHZlcmIgcGFyc2VzIGFnYWluc3QgaXRzIG93biBvcHRpb25zLCB3aGljaCBtZWFucyB0aGVcbi8vIGhlbHAgdGV4dCwgdGhlIHJlamVjdGlvbidzIGBjaG9pY2VzYCBhbmQgdGhlIHBhcnNlciBjYW4gbm8gbG9uZ2VyIGRpc2FncmVlOlxuLy8gdGhlcmUgaXMgb25lIG9iamVjdCwgYW5kIGFkZGluZyBhIGZsYWcgdG8gYSB2ZXJiIGlzIG9uZSBlZGl0LlxuZXhwb3J0IGNvbnN0IFZFUkJfU1BFQyA9IHtcbiAgb3BlbjogW1widGl0bGVcIiwgXCJpbnRlbnRcIiwgXCJ0aW1lb3V0XCIsIFwicmVzdG9yZVwiLCBcIm5vLW9wZW5cIl0sXG4gIHNlc3Npb25zOiBbXSxcbiAgdGFpbDogW1wic2Vzc2lvblwiLCBcInNpbmNlXCJdLFxuICBzdGF0ZTogW1wic2Vzc2lvblwiLCBcImZ1bGxcIl0sXG4gIHNheTogW1wic2Vzc2lvblwiLCBcInN0ZGluXCJdLFxuICBhc2s6IFtcInNlc3Npb25cIiwgXCJvcHRpb25zXCJdLFxuICBzdGF0dXM6IFtcInNlc3Npb25cIl0sXG4gIHNvdXJjZTogW1wic2Vzc2lvblwiXSxcbiAgZGlzY292ZXI6IFtcInNlc3Npb25cIl0sXG4gIGV4dHJhY3Q6IFtcInNlc3Npb25cIiwgXCJpZHNcIiwgXCJyZW1vdmVcIiwgXCJhbHBoYVwiLCBcInBhZFwiLCBcIm1vZGVsXCIsIFwibGFiZWxcIl0sXG4gIGV4cG9ydDogW1wic2Vzc2lvblwiLCBcImlkc1wiXSxcbiAgXCJlbGVtZW50LWFkZFwiOiBbXCJzZXNzaW9uXCIsIFwiYmJveFwiLCBcIm5hbWVcIiwgXCJ0eXBlXCJdLFxuICBcImVsZW1lbnQtcmVtb3ZlXCI6IFtcInNlc3Npb25cIl0sXG4gIGNtZDogW1wic2Vzc2lvblwiLCBcInN0ZGluXCJdLFxuICBjbG9zZTogW1wic2Vzc2lvblwiXSxcbiAgaW5mbzogW1wic2Vzc2lvblwiXSxcbiAgaGVscDogW10sXG59IGFzIGNvbnN0IHNhdGlzZmllcyBSZWNvcmQ8c3RyaW5nLCByZWFkb25seSAoa2V5b2YgdHlwZW9mIENMSV9PUFRJT05TKVtdPjtcblxudHlwZSBWZXJiID0ga2V5b2YgdHlwZW9mIFZFUkJfU1BFQztcblxuY29uc3QgVkVSQlMgPSBPYmplY3Qua2V5cyhWRVJCX1NQRUMpIGFzIFZlcmJbXTtcblxuY29uc3QgaXNWZXJiID0gKHY6IHN0cmluZyk6IHYgaXMgVmVyYiA9PiBPYmplY3QuaGFzT3duKFZFUkJfU1BFQywgdik7XG5cbi8vIFRoZSBmbGFncyBvbmUgdmVyYiBhY2NlcHRzLCBhcyB0aGUgY2FsbGVyIHNwZWxscyB0aGVtLlxuY29uc3QgZmxhZ3NGb3IgPSAodmVyYjogVmVyYik6IHN0cmluZ1tdID0+IFZFUkJfU1BFQ1t2ZXJiXS5tYXAoKGspID0+IGAtLSR7a31gKS5zb3J0KCk7XG5cbmNsYXNzIFVzYWdlRXJyb3IgZXh0ZW5kcyBFcnJvciB7fVxuXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VBcmdzKFxuICBhcmdzOiBzdHJpbmdbXSxcbiAgdmVyYj86IFZlcmIsXG4pOiB7XG4gIHBvczogc3RyaW5nW107XG4gIGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPjtcbn0ge1xuICAvLyBUV08gU1RBR0VTLCBBTkQgVEhFIE9SREVSIElTIFRIRSBQT0lOVC5cbiAgLy9cbiAgLy8gU3RhZ2UgMSBwYXJzZXMgYWdhaW5zdCB0aGUgV0hPTEUgcmVnaXN0cnksIHNvIGEgdG9rZW4gbWFncGllIGhhcyBuZXZlclxuICAvLyBoZWFyZCBvZiBpcyByZWZ1c2VkIGJ5IGBub2RlOnV0aWxgIHdpdGggaXRzIG93biBtZXNzYWdlLiBTdGFnZSAyIHRoZW4gYXNrc1xuICAvLyB0aGUgcXVlc3Rpb24gdGhlIHBhcnNlciBjYW5ub3Q6IGlzIHRoaXMgZmxhZyBhY2NlcHRlZCBBVCBUSElTIFZFUkIuXG4gIC8vXG4gIC8vIERvaW5nIGl0IHRoZSBvdGhlciB3YXkg4oCUIGhhbmRpbmcgcGFyc2VBcmdzIGEgcGVyLXZlcmIgc3Vic2V0IOKAlCB3YXMgdGhlIGZpcnN0XG4gIC8vIHNoYXBlLCBhbmQgaXQgYW5zd2VyZWQgYHNheSAtLWJib3hgIHdpdGggXCJVbmtub3duIG9wdGlvbiAnLS1iYm94J1wiLCB3aGljaCBpc1xuICAvLyBmYWxzZS4gYC0tYmJveGAgaXMgYSBwZXJmZWN0bHkgZ29vZCBmbGFnOyBpdCBqdXN0IGlzIG5vdCBgc2F5YCdzLiBBbiBhZ2VudFxuICAvLyB0b2xkIGEgcmVhbCBmbGFnIGlzIHVua25vd24gZ29lcyBsb29raW5nIGZvciBhIHR5cG8gaXQgZGlkIG5vdCBtYWtlLlxuICAvL1xuICAvLyBJdCBhbHNvIGNvc3QgdGhlIGdyaW1vaXJlJ3MgZmxhZy1pbnZhcmlhbnQgd2FyZCBpdHMgZm9vdGluZzogdGhhdCBjaGVja1xuICAvLyByZXNvbHZlcyBgb3B0aW9uczogPGlkZW50aWZpZXI+YCBiYWNrIHRvIGEgbGl0ZXJhbCBkZWNsYXJhdGlvbiwgYW5kIGEgc3Vic2V0XG4gIC8vIGNvbXB1dGVkIGF0IHRoZSBjYWxsIHNpdGUgaXMgbm90IG9uZS4gVGhlIHdhcmQgY291bGQgbm8gbG9uZ2VyIHJlYWQgbWFncGllJ3NcbiAgLy8gcmVnaXN0cnkgYXQgYWxsIGFuZCByZXBvcnRlZCB0aGUgZW50cnkgcG9pbnQgdW5yZXNvbHZlZCDigJQgdGhlIGluc3RydW1lbnRcbiAgLy8gc2F5aW5nIFwiSSBjYW5ub3Qgc2VlIHRoaXNcIiwgZXhhY3RseSBhcyBkZXNpZ25lZC4gS2VlcGluZyBgQ0xJX09QVElPTlNgIGF0XG4gIC8vIHRoZSBjYWxsIHNpdGUga2VlcHMgdGhlIHJlZ2lzdHJ5IGxlZ2libGUgdG8gaXQuXG4gIGxldCBwYXJzZWQ6IHsgdmFsdWVzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjsgcG9zaXRpb25hbHM6IHN0cmluZ1tdIH07XG4gIHRyeSB7XG4gICAgcGFyc2VkID0gbm9kZVBhcnNlQXJncyh7XG4gICAgICBhcmdzLFxuICAgICAgb3B0aW9uczogQ0xJX09QVElPTlMsXG4gICAgICBzdHJpY3Q6IHRydWUsXG4gICAgICBhbGxvd1Bvc2l0aW9uYWxzOiB0cnVlLFxuICAgIH0pO1xuICB9IGNhdGNoIChlKSB7XG4gICAgdGhyb3cgbmV3IFVzYWdlRXJyb3IoZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpKTtcbiAgfVxuXG4gIGlmICh2ZXJiKSB7XG4gICAgY29uc3QgYWxsb3dlZCA9IG5ldyBTZXQ8c3RyaW5nPihWRVJCX1NQRUNbdmVyYl0pO1xuICAgIGNvbnN0IHN0cmF5ID0gT2JqZWN0LmtleXMocGFyc2VkLnZhbHVlcykuZmluZCgoaykgPT4gIWFsbG93ZWQuaGFzKGspKTtcbiAgICBpZiAoc3RyYXkpIHtcbiAgICAgIHRocm93IG5ldyBVc2FnZUVycm9yKFxuICAgICAgICBgLS0ke3N0cmF5fSBpcyBub3QgYWNjZXB0ZWQgYnkgXFxgJHt2ZXJifVxcYCAoaXQgaXMgYSByZWNvZ25pemVkIG1hZ3BpZSBmbGFnLCBqdXN0IG5vdCB0aGlzIHZlcmIncylgLFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4ge1xuICAgIHBvczogcGFyc2VkLnBvc2l0aW9uYWxzLFxuICAgIGZsYWdzOiBwYXJzZWQudmFsdWVzIGFzIFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+LFxuICB9O1xufVxuXG4vLyBSZWFkIGFsbCBvZiBzdGRpbiBhcyB0ZXh0IChCdW4uc3RkaW4pLiBVc2VkIGJ5IGAtLXN0ZGluYCBzbyBOTCB0ZXh0IGlzbid0IGFcbi8vIHNoZWxsLXBhcnNlZCBhcmcuXG5hc3luYyBmdW5jdGlvbiByZWFkU3RkaW4oKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgcmV0dXJuIChhd2FpdCBCdW4uc3RkaW4udGV4dCgpKS50cmltKCk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHBvc3RDbWQoc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkLCBtc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gIGNvbnN0IHMgPSByZXF1aXJlU2Vzc2lvbihzZXNzaW9uKTtcbiAgY29uc3QgeyBzdGF0dXMgfSA9IGF3YWl0IGFwaShzLnBvcnQsIFwiUE9TVFwiLCBcIi9jbWRcIiwgbXNnKTtcbiAgaWYgKHN0YXR1cyAhPT0gMjAwKSBkaWUoYGNtZCBmYWlsZWQgKEhUVFAgJHtzdGF0dXN9KSDigJQgaXMgdGhlIHNlc3Npb24gc3RpbGwgYWxpdmU/YCwgXCJpbnRlcm5hbFwiKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIHNlbnQ6IG1zZy50eXBlIH0pO1xufVxuXG4vLyDilIDilIAgdmVyYnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmFzeW5jIGZ1bmN0aW9uIGNtZE9wZW4oZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KSB7XG4gIGNvbnN0IGFyZ3MgPSBbXCJydW5cIiwgU0VSVkVSX1NDUklQVF07XG4gIGlmIChmbGFncy50aXRsZSkgYXJncy5wdXNoKFwiLS10aXRsZVwiLCBTdHJpbmcoZmxhZ3MudGl0bGUpKTtcbiAgaWYgKGZsYWdzLmludGVudCkgYXJncy5wdXNoKFwiLS1pbnRlbnRcIiwgU3RyaW5nKGZsYWdzLmludGVudCkpO1xuICBpZiAoZmxhZ3MudGltZW91dCkgYXJncy5wdXNoKFwiLS10aW1lb3V0XCIsIFN0cmluZyhmbGFncy50aW1lb3V0KSk7XG4gIGlmIChmbGFncy5yZXN0b3JlKSBhcmdzLnB1c2goXCItLXJlc3RvcmVcIiwgU3RyaW5nKGZsYWdzLnJlc3RvcmUpKTtcbiAgaWYgKGZsYWdzW1wibm8tb3BlblwiXSkgYXJncy5wdXNoKFwiLS1uby1vcGVuXCIpO1xuXG4gIGNvbnN0IHByZXZJZCA9IHJlYWRTZXNzaW9uKCk/LnNlc3Npb25faWQ7XG4gIC8vIERldGFjaGVkIG5vZGU6Y2hpbGRfcHJvY2VzcyAobm90IEJ1bi5zcGF3bikgc28gdGhlIGRhZW1vbiBTVVJWSVZFUyB0aGlzIENMSVxuICAvLyBwcm9jZXNzIGV4aXRpbmcg4oCUIHRoZSBob3VzZSBwYXR0ZXJuIGZvciBhIHN0YW5kaW5nIGRhZW1vbi4gY3dkIHBpbm5lZCB0byB0aGVcbiAgLy8gc2tpbGwgcm9vdCBzbyBCdW4gZmluZHMgYnVuZmlnLnRvbWwgKHJlZ2lzdGVycyBidW4tcGx1Z2luLXRhaWx3aW5kKS5cbiAgY29uc3QgcHJvYyA9IHNwYXduKHByb2Nlc3MuZXhlY1BhdGgsIGFyZ3MsIHtcbiAgICBkZXRhY2hlZDogdHJ1ZSxcbiAgICBzdGRpbzogW1wiaWdub3JlXCIsIFwiaWdub3JlXCIsIFwiaWdub3JlXCJdLFxuICAgIGVudjogcHJvY2Vzcy5lbnYsXG4gICAgLy8gQ29udHJhY3QgNSDigJQgc2VlIGRhZW1vbkN3ZCgpLiBBIHdyb25nIGN3ZCBza2lwcyB0aGUgVGFpbHdpbmQgcGx1Z2luOyBvblxuICAgIC8vIGdsYW1vdXIgdGhhdCBmYWlscyB0aGUgcGFnZSBvdXRyaWdodCAoNTAwKS4gQXNzZXJ0IHRoZSBpbnZhcmlhbnQsIG5vdCB0aGVcbiAgICAvLyBzdGF0dXM6IHRoZSB1dGlsaXR5IG5ldmVyIHJlYWNoZXMgdGhlIGJyb3dzZXIgd2hlbiBjd2QgaXMgd3JvbmcuXG4gICAgY3dkOiBkYWVtb25Dd2QoKSxcbiAgfSk7XG4gIHByb2MudW5yZWYoKTtcblxuICBjb25zdCBkZWFkbGluZSA9IERhdGUubm93KCkgKyA1MDAwO1xuICB3aGlsZSAoRGF0ZS5ub3coKSA8IGRlYWRsaW5lKSB7XG4gICAgYXdhaXQgc2xlZXAoODApO1xuICAgIGNvbnN0IHMgPSByZWFkU2Vzc2lvbigpO1xuICAgIGlmIChzICYmIHMuc2Vzc2lvbl9pZCAhPT0gcHJldklkKSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCByID0gYXdhaXQgZmV0Y2goYGh0dHA6Ly8xMjcuMC4wLjE6JHtzLnBvcnR9L3N0YXRlYCk7XG4gICAgICAgIGlmIChyLm9rKSB7XG4gICAgICAgICAgcHJpbnRKc29uKHMpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIG5vdCB1cCB5ZXQgKi9cbiAgICAgIH1cbiAgICB9XG4gIH1cbiAgZGllKFwibWFncGllIHNlcnZlciBmYWlsZWQgdG8gc3RhcnQgd2l0aGluIDVzXCIsIFwiaW50ZXJuYWxcIik7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGNtZFN0YXRlKHNlc3Npb24/OiBzdHJpbmcsIGZ1bGwgPSBmYWxzZSkge1xuICBjb25zdCBzID0gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbik7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGkocy5wb3J0LCBcIkdFVFwiLCBgL3N0YXRlJHtmdWxsID8gXCJcIiA6IFwiP2xlYW49MVwifWApO1xuICBpZiAoc3RhdHVzICE9PSAyMDApIGRpZShgc3RhdGUgZmFpbGVkIChIVFRQICR7c3RhdHVzfSlgLCBcImludGVybmFsXCIpO1xuICBwcmludEpzb24oZGF0YSk7XG59XG5cbi8qKlxuICogVGhlIGV2ZW50IHRhaWwg4oCUIG9uZSBjYWxsIGludG8gdGhlIGhvdXNlJ3Mgc2hhcmVkIFNTRSBjbGllbnRcbiAqIChgc3JjL2tpdC93aXJlL3RhaWxFdmVudHMudHNgKSwgd2hlcmUgdGhlIHJlY29ubmVjdCBsb29wLCB0aGUgc3BlYy1jb3JyZWN0XG4gKiBmcmFtZSBwYXJzZXIsIHRoZSBiYWNrb2ZmLCB0aGUgaWRsZSB3YXRjaGRvZyBhbmQgdGhlIGRyYWluZWQgZXhpdCBsaXZlIG9uY2VcbiAqIGZvciBldmVyeSBzcGVsbC5cbiAqXG4gKiDim5QgYHJlc29sdmVgIFJFLVJFQURTIFRIRSBTRVNTSU9OIFBPSU5URVIgT04gRVZFUlkgQVRURU1QVCwgd2hpY2ggaXMgd2hhdFxuICogbWFncGllJ3Mgb3duIGxvb3AgZGlkIGFuZCB3aGF0IHRoZSBzaGFyZWQgY2xpZW50IG1ha2VzIHN0cnVjdHVyYWw6IHRoZSBkYWVtb25cbiAqIGJpbmRzIGFuIGVwaGVtZXJhbCBwb3J0LCBzbyBhIGNhcHR1cmVkIGJhc2UgaXMgYSB0YWlsIHRoYXQgc3Vydml2ZXMgZXhhY3RseVxuICogb25lIGRhZW1vbi5cbiAqXG4gKiBUaGUgcGluLCB0aGUgZ3JvdW5kaW5nIGFuY2hvciBhbmQgdGhlIFwib3VyIHNlc3Npb24gd2VudCBhd2F5XCIgZXhpdCBhcmUgYWxsXG4gKiBwcmVzZXJ2ZWQgdmVyYmF0aW06IHRoZSBGSVJTVCByZXNvbHZlZCBzZXNzaW9uIGlzIHBpbm5lZCBmb3IgdGhlIGxpZmUgb2YgdGhlXG4gKiB3YXRjaCwgdGhlIGdyb3VuZGluZyBsaW5lIG5hbWVzIHRoYXQgYmluZGluZyBvbmNlLCBhbmQgYSBwb2ludGVyIHRoYXRcbiAqIGRpc2FwcGVhcnMgQUZURVIgd2Ugd2VyZSBib3VuZCBlbmRzIHRoZSB3YXRjaCBhdCAwIOKAlCBhIGNvbXBsZXRlZCB3YXRjaCwgbm90IGFcbiAqIGZhaWx1cmUuIEEgcG9pbnRlciB0aGF0IG5ldmVyIGFwcGVhcmVkIGtlZXBzIHJldHJ5aW5nLlxuICovXG5hc3luYyBmdW5jdGlvbiBjbWRUYWlsKHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCwgc2luY2VBcmc6IG51bWJlcik6IFByb21pc2U8bnVtYmVyPiB7XG4gIGxldCBib3VuZElkID0gc2Vzc2lvbjtcbiAgbGV0IGdyb3VuZGVkID0gZmFsc2U7XG5cbiAgcmV0dXJuIGF3YWl0IHRhaWxFdmVudHM8eyBpZD86IG51bWJlcjsgdHlwZT86IHN0cmluZyB9Pih7XG4gICAgcmVzb2x2ZTogKCkgPT4ge1xuICAgICAgLy8gcmVhZFNlc3Npb24gZGllcyBvbiBhIENPUlJVUFQgcG9pbnRlciBhbmQgcmV0dXJucyBudWxsIG9ubHkgZm9yIGFcbiAgICAgIC8vIGdlbnVpbmVseSBhYnNlbnQgb25lIOKAlCB0aGUgRU5PRU5UIHJ1bGUuIEEgZGllIGhlcmUgbm93IHRocm93cywgYW5kIHRoZVxuICAgICAgLy8gdGhyb3cgbGVhdmVzIHRoZSB0YWlsIHRocm91Z2ggbWFpbidzIGZ1bm5lbCBpbnN0ZWFkIG9mIGV4aXRpbmcgZnJvbVxuICAgICAgLy8gdGhyZWUgZnJhbWVzIGRvd24gaW5zaWRlIGEgcmVjb25uZWN0IGxvb3AuXG4gICAgICBjb25zdCBzID0gcmVhZFNlc3Npb24oYm91bmRJZCk7XG4gICAgICBpZiAoIXMpIHJldHVybiBudWxsO1xuICAgICAgaWYgKCFib3VuZElkKSBib3VuZElkID0gcy5zZXNzaW9uX2lkOyAvLyBwaW4gdG8gdGhlIGZpcnN0IHNlc3Npb24gd2UgcmVzb2x2ZWRcbiAgICAgIGlmICghZ3JvdW5kZWQpIHtcbiAgICAgICAgZ3JvdW5kZWQgPSB0cnVlO1xuICAgICAgICAvLyBncm91bmRpbmcgYW5jaG9yIOKAlCBwYXJzZWFibGUgKyB2aXNpYmxlIGluIGEgTW9uaXRvcjsgbmFtZXMgdGhlIGJpbmRpbmcuXG4gICAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKFxuICAgICAgICAgIGAke0pTT04uc3RyaW5naWZ5KHsgdHlwZTogXCJncm91bmRpbmdcIiwgc2Vzc2lvbl9pZDogcy5zZXNzaW9uX2lkLCBwb3J0OiBzLnBvcnQgfSl9XFxuYCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBgaHR0cDovLzEyNy4wLjAuMToke3MucG9ydH1gO1xuICAgIH0sXG4gICAgb25VbnJlc29sdmVkOiAoeyBldmVyUmVzb2x2ZWQgfSkgPT4ge1xuICAgICAgaWYgKGV2ZXJSZXNvbHZlZCkgcmV0dXJuIFwic3RvcFwiOyAvLyBvdXIgcGlubmVkIHNlc3Npb24gd2VudCBhd2F5IOKGkiBkb25lXG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcIiMgbm8gc2Vzc2lvbiB5ZXQsIHJldHJ5aW5n4oCmXFxuXCIpO1xuICAgICAgcmV0dXJuIFwicmV0cnlcIjtcbiAgICB9LFxuICAgIHBhdGg6IFwiL2V2ZW50c1wiLFxuICAgIHNpbmNlOiBzaW5jZUFyZyxcbiAgICBjdXJzb3JPZjogKGV2KSA9PiBldi5pZCxcbiAgICB0ZXJtaW5hbDogKGV2KSA9PiBldi50eXBlID09PSBcImNsb3NlZFwiLFxuICAgIC8vIFRocmVlIG1pc3NlZCAxNXMgZGFlbW9uIGhlYXJ0YmVhdHMuIFdpdGhvdXQgaXQsIGBhd2FpdCByZWFkZXIucmVhZCgpYFxuICAgIC8vIHBhcmtzIGZvcmV2ZXIgb24gYSBoYWxmLW9wZW4gc29ja2V0IGFmdGVyIGxhcHRvcCBzbGVlcCwgYSBOQVQgcmViaW5kIG9yIGFcbiAgICAvLyBTSUdLSUxMZWQgZGFlbW9uIOKAlCBhbmQgdGhlIHRhaWwgbG9va3MgYWxpdmUgd2hpbGUgcmVjZWl2aW5nIG5vdGhpbmcuXG4gICAgaWRsZU1zOiA0NV8wMDAsXG4gICAgb25Db21tZW50OiAoKSA9PiBwcm9jZXNzLnN0ZGVyci53cml0ZShcIjogbWFncGllLWtlZXBhbGl2ZVxcblwiKSxcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGNtZEluZm8oc2Vzc2lvbj86IHN0cmluZykge1xuICBjb25zdCBzID0gcmVhZFNlc3Npb24oc2Vzc2lvbik7XG4gIGlmICghcykgZGllKFwibm8gcnVubmluZyBtYWdwaWUgc2Vzc2lvblwiLCBcIm5vdF9mb3VuZFwiKTtcbiAgcHJpbnRKc29uKHMpO1xufVxuXG5mdW5jdGlvbiBjbWRTZXNzaW9ucygpIHtcbiAgLy8gTWlycm9yIHBlcnNpc3Quc2VydmVyJ3Mgc25hcHNob3QgZGlyIHJlc29sdXRpb24gKGF2b2lkIGltcG9ydGluZyBub2RlOmZzIHBhdGhcbiAgLy8gbG9naWMgdHdpY2UpOiAkTUFHUElFX0hPTUUvc25hcHNob3RzIG9yIH4vLm1hZ3BpZS9zbmFwc2hvdHMuXG4gIGNvbnN0IGhvbWUgPSBwcm9jZXNzLmVudi5NQUdQSUVfSE9NRSA/PyBqb2luKHByb2Nlc3MuZW52LkhPTUUgPz8gXCJcIiwgXCIubWFncGllXCIpO1xuICBjb25zdCBkaXIgPSBqb2luKGhvbWUsIFwic25hcHNob3RzXCIpO1xuICBsZXQgZmlsZXM6IHN0cmluZ1tdO1xuICB0cnkge1xuICAgIGZpbGVzID0gcmVhZGRpclN5bmMoZGlyKS5maWx0ZXIoKGYpID0+IGYuZW5kc1dpdGgoXCIuanNvblwiKSk7XG4gIH0gY2F0Y2gge1xuICAgIHByaW50SnNvbih7IHNlc3Npb25zOiBbXSB9KTtcbiAgICByZXR1cm47XG4gIH1cbiAgdHlwZSBSb3cgPSB7IGlkOiBzdHJpbmc7IHRpdGxlOiBzdHJpbmc7IGVsZW1lbnRzOiBudW1iZXI7IG10aW1lOiBudW1iZXIgfTtcbiAgY29uc3Qgcm93czogUm93W10gPSBbXTtcbiAgZm9yIChjb25zdCBmIG9mIGZpbGVzKSB7XG4gICAgY29uc3QgcGF0aCA9IGpvaW4oZGlyLCBmKTtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc3QgPSBKU09OLnBhcnNlKHJlYWRGaWxlU3luYyhwYXRoLCBcInV0ZjhcIikpO1xuICAgICAgcm93cy5wdXNoKHtcbiAgICAgICAgaWQ6IGYucmVwbGFjZSgvXFwuanNvbiQvLCBcIlwiKSxcbiAgICAgICAgdGl0bGU6IHN0LnRpdGxlLFxuICAgICAgICBlbGVtZW50czogQXJyYXkuaXNBcnJheShzdC5lbGVtZW50cykgPyBzdC5lbGVtZW50cy5sZW5ndGggOiAwLFxuICAgICAgICBtdGltZTogc3RhdFN5bmMocGF0aCkubXRpbWVNcyxcbiAgICAgIH0pO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLyogc2tpcCB1bnJlYWRhYmxlIHNuYXBzaG90ICovXG4gICAgfVxuICB9XG4gIHJvd3Muc29ydCgoYSwgYikgPT4gYi5tdGltZSAtIGEubXRpbWUpO1xuICAvLyBPTkUgSlNPTiBkb2N1bWVudCwgbGlrZSBldmVyeSBvdGhlciBkYXRhIHZlcmIuIFRoaXMgcHJpbnRlZCBhIHByb3NlIHRhYmxlXG4gIC8vIHVudGlsIHRoZSBtYWNoaW5lLW1vZGUgZGVjbGFyYXRpb24gd2VudCBpbiwgYXQgd2hpY2ggcG9pbnQgdGhlIHRvb2wgd2FzXG4gIC8vIGNsYWltaW5nIGBkZWZhdWx0T3V0cHV0OiBcImpzb25cImAgd2hpbGUgYW5zd2VyaW5nIHRoaXMgdmVyYiBpbiBwcm9zZSDigJQgYVxuICAvLyBkZWNsYXJhdGlvbiBpcyBvbmx5IHdvcnRoIHdoYXQgaXRzIGxlYXN0IGhvbmVzdCBwYXRoIG1ha2VzIGl0LlxuICBwcmludEpzb24oeyBzZXNzaW9uczogcm93cyB9KTtcbn1cblxuLy8gYHNvdXJjZSA8aW1hZ2VQYXRoPmAg4oCUIGNvbXB1dGUgc2hhMjU2WzoxNl0gKyBwaXhlbCBzaXplIChCdW4uSW1hZ2UpIGFuZCBwb3N0XG4vLyBzb3VyY2Uuc2V0LiBUaGUgYWdlbnQgcnVucyBkaXNjb3ZlciBzZXBhcmF0ZWx5OyB0aGlzIGp1c3QgcmVnaXN0ZXJzIHRoZSBib2FyZC5cbmFzeW5jIGZ1bmN0aW9uIGNtZFNvdXJjZShzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsIGltYWdlUGF0aDogc3RyaW5nKSB7XG4gIGNvbnN0IGZpbGUgPSBCdW4uZmlsZShpbWFnZVBhdGgpO1xuICBpZiAoIShhd2FpdCBmaWxlLmV4aXN0cygpKSkgZGllKGBpbWFnZSBub3QgZm91bmQ6ICR7aW1hZ2VQYXRofWAsIFwibm90X2ZvdW5kXCIpO1xuICBjb25zdCBieXRlcyA9IG5ldyBVaW50OEFycmF5KGF3YWl0IGZpbGUuYXJyYXlCdWZmZXIoKSk7XG4gIGNvbnN0IHNoYSA9IG5ldyBCdW4uQ3J5cHRvSGFzaGVyKFwic2hhMjU2XCIpLnVwZGF0ZShieXRlcykuZGlnZXN0KFwiaGV4XCIpLnNsaWNlKDAsIDE2KTtcbiAgY29uc3QgbWV0YSA9IGF3YWl0IG5ldyBCdW4uSW1hZ2UoYnl0ZXMpLm1ldGFkYXRhKCk7XG4gIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwge1xuICAgIHR5cGU6IFwic291cmNlLnNldFwiLFxuICAgIHBhdGg6IGltYWdlUGF0aCxcbiAgICBzaXplOiBbbWV0YS53aWR0aCA/PyAwLCBtZXRhLmhlaWdodCA/PyAwXSxcbiAgICBzaGEsXG4gIH0pO1xufVxuXG4vLyBgZWxlbWVudC1hZGQgLS1iYm94IFwieDEseTEseDIseTJcIiBbLS1uYW1lIC4uXSBbLS10eXBlIC4uXWAg4oCUIGFnZW50IGJveGVzIGFcbi8vIHJlZ2lvbiBpbmNyZW1lbnRhbGx5IChzb3VyY2UgcGl4ZWxzKS4gTWlycm9ycyB0aGUgdXNlcidzIFwibWFyayBhIG1pc3NlZCByZWdpb25cIi5cbmFzeW5jIGZ1bmN0aW9uIGNtZEVsZW1lbnRBZGQoc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkLCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgcmF3ID0gdHlwZW9mIGZsYWdzLmJib3ggPT09IFwic3RyaW5nXCIgPyBmbGFncy5iYm94IDogXCJcIjtcbiAgY29uc3QgcGFydHMgPSByYXcuc3BsaXQoXCIsXCIpLm1hcCgobikgPT4gcGFyc2VJbnQobi50cmltKCksIDEwKSk7XG4gIGlmIChwYXJ0cy5sZW5ndGggIT09IDQgfHwgcGFydHMuc29tZSgobikgPT4gTnVtYmVyLmlzTmFOKG4pKSkge1xuICAgIGRpZSgndXNhZ2U6IGVsZW1lbnQtYWRkIC0tYmJveCBcIngxLHkxLHgyLHkyXCIgWy0tbmFtZSA8bmFtZT5dIFstLXR5cGUgPHR5cGU+XScpO1xuICB9XG4gIGNvbnN0IGVsZW1lbnQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyBiYm94OiBwYXJ0cyB9O1xuICBpZiAodHlwZW9mIGZsYWdzLm5hbWUgPT09IFwic3RyaW5nXCIpIGVsZW1lbnQubmFtZSA9IGZsYWdzLm5hbWU7XG4gIGlmICh0eXBlb2YgZmxhZ3MudHlwZSA9PT0gXCJzdHJpbmdcIikgZWxlbWVudC50eXBlID0gZmxhZ3MudHlwZTtcbiAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwiZWxlbWVudC5hZGRcIiwgZWxlbWVudCB9KTtcbn1cblxuLy8gYGRpc2NvdmVyYCDigJQgcmVhZCAvc3RhdGUgZm9yIHNvdXJjZS5wYXRoLCBydW4gZGlzY292ZXIudHMgb24gaXQsIGJ1aWxkIHRoZVxuLy8gRWxlbWVudFtdIChzdGF0dXMgXCJwcm9wb3NlZFwiLCBiYm94IGZyb20gdGhlIG1hbmlmZXN0J3MgYmJveF9waXhlbCksIGFuZCBQT1NUXG4vLyBlbGVtZW50cy5zZXQuIFRoZSB3aG9sZSBkaXNjb3ZlcuKGkmJyZWFrZG93biBsb29wIGluIG9uZSBzaG90IChmb3IgdGhlIGFnZW50IG9yIGFcbi8vIHRlc3RlcikuIFJlcXVpcmVzIE9QRU5ST1VURVJfQVBJX0tFWSBpbiB0aGUgZW52aXJvbm1lbnQuXG5hc3luYyBmdW5jdGlvbiBjbWREaXNjb3ZlcihzZXNzaW9uPzogc3RyaW5nKSB7XG4gIGNvbnN0IHMgPSByZXF1aXJlU2Vzc2lvbihzZXNzaW9uKTtcbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaShzLnBvcnQsIFwiR0VUXCIsIFwiL3N0YXRlXCIpO1xuICBpZiAoc3RhdHVzICE9PSAyMDApIGRpZShgc3RhdGUgZmFpbGVkIChIVFRQICR7c3RhdHVzfSlgLCBcImludGVybmFsXCIpO1xuICBjb25zdCBzcmMgPSAoZGF0YSBhcyB7IHN0YXRlPzogeyBzb3VyY2U/OiB7IHBhdGg/OiBzdHJpbmcgfSB9IH0pLnN0YXRlPy5zb3VyY2U7XG4gIGNvbnN0IHBhdGggPSBzcmM/LnBhdGg7XG4gIGlmICghcGF0aCkgZGllKFwibm8gc291cmNlIHNldCDigJQgZHJvcCBhIGNvbXBvc2l0ZSAob3IgcnVuOiBzb3VyY2UgPGltYWdlUGF0aD4pIGZpcnN0XCIsIFwiY29uZmxpY3RcIik7XG4gIGxldCBtYW5pZmVzdDogQXdhaXRlZDxSZXR1cm5UeXBlPHR5cGVvZiBkaXNjb3Zlcj4+O1xuICB0cnkge1xuICAgIG1hbmlmZXN0ID0gYXdhaXQgZGlzY292ZXIocGF0aCk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBpZiAoZSBpbnN0YW5jZW9mIERpc2NvdmVyRXJyb3IpIGRpZShgZGlzY292ZXIgZmFpbGVkOiAke2UubWVzc2FnZX1gLCBcImludGVybmFsXCIpO1xuICAgIHRocm93IGU7XG4gIH1cbiAgY29uc3QgZWxlbWVudHM6IEVsZW1lbnRbXSA9IG1hbmlmZXN0LmVsZW1lbnRzLm1hcCgoZSkgPT4gKHtcbiAgICBpZDogbmV3SWQoXCJlXCIpLFxuICAgIG5hbWU6IGUubmFtZSxcbiAgICB0eXBlOiBlLnR5cGUsXG4gICAgYmJveDogZS5iYm94X3BpeGVsLFxuICAgIHN0YXR1czogXCJwcm9wb3NlZFwiLFxuICB9KSk7XG4gIGNvbnN0IGNvc3QgPSBtYW5pZmVzdC5jb3N0X3VzZCA/IGAg4oCUICQke21hbmlmZXN0LmNvc3RfdXNkLnRvRml4ZWQoNCl9YCA6IFwiXCI7XG4gIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBtYWdwaWU6IGRpc2NvdmVyZWQgJHtlbGVtZW50cy5sZW5ndGh9IGVsZW1lbnQocykgb24gJHtwYXRofSR7Y29zdH1cXG5gKTtcbiAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwiZWxlbWVudHMuc2V0XCIsIGVsZW1lbnRzIH0pO1xufVxuXG4vLyBNaXJyb3IgcmVtb3ZlLnB5J3Mgc2FmZV9maWxlbmFtZSBzbyB0aGUgY3V0b3V0IGZpbGVuYW1lIGlzIHN0YWJsZSArIHRyYXZlcnNhbC1cbi8vIHNhZmUgKHRoZSBzdXJmYWNlIHNlcnZlcyBpdCB2aWEgL2Fzc2V0cy88YmFzZW5hbWU+KS5cbmZ1bmN0aW9uIHNhbml0aXplKG5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGNsZWFuZWQgPSBBcnJheS5mcm9tKG5hbWUgfHwgXCJcIilcbiAgICAubWFwKChjKSA9PiAoL1tBLVphLXowLTlcXC1fLl0vLnRlc3QoYykgPyBjIDogXCJfXCIpKVxuICAgIC5qb2luKFwiXCIpXG4gICAgLnJlcGxhY2UoL15cXC4rLywgXCJcIik7IC8vIG5vIGhpZGRlbiBkb3RmaWxlc1xuICByZXR1cm4gY2xlYW5lZCB8fCBcImVsZW1lbnRcIjtcbn1cblxuLy8gVGhlIG9uLWRpc2sgZmlsZW5hbWUgZm9yIGEgdmVyc2lvbjogZWFjaCBNT0RFTCBnZXRzIGl0cyBvd24gZmlsZSBzbyB2ZXJzaW9uc1xuLy8gZG9uJ3Qgb3ZlcndyaXRlIGVhY2ggb3RoZXIgYW5kIGRvbid0IGNvbGxpZGUgaW4gdGhlIGJyb3dzZXIgY2FjaGUgKHR3byB2ZXJzaW9uc1xuLy8gYXQgdGhlIHNhbWUgVVJMIHdvdWxkIHNob3cgYSBzdGFsZSBpbWFnZSkuIFRoZSByYXcgY3JvcCBrZWVwcyB0aGUgYmFyZVxuLy8gYDxuYW1lPi5wbmdgOyBldmVyeSByZW1vdmFsIG1vZGVsIGlzIHN1ZmZpeGVkIGA8bmFtZT4uPG1vZGVsPi5wbmdgLlxuZXhwb3J0IGZ1bmN0aW9uIGN1dG91dEZpbGVuYW1lKG5hbWU6IHN0cmluZywgYmFja2VuZDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke3Nhbml0aXplKG5hbWUpfSR7YmFja2VuZCA9PT0gXCJjcm9wXCIgPyBcIlwiIDogYC4ke2JhY2tlbmR9YH0ucG5nYDtcbn1cblxuLy8gYGV4dHJhY3QgWy0taWRzIGEsYl0gWy0tcmVtb3ZlXSBbLS1hbHBoYSBhdXRvfGFsbHxub25lXSBbLS1wYWQgTl1gIOKAlCBjdXQgYVxuLy8gc2xpY2UgZm9yIGV2ZXJ5IG5vbi1kcm9wcGVkIGVsZW1lbnQgKG9yIGp1c3QgYC0taWRzYCwgb24gcmUtY3V0KS4gREVGQVVMVCBpc1xuLy8gQ1JPUC1PTkxZIChhIHJhdyBQaWxsb3cgc2xpY2UsIG5vIGJhY2tncm91bmQgcmVtb3ZhbCDihpIgYmFja2VuZCBsYWJlbCBcImNyb3BcIikuXG4vLyBgLS1yZW1vdmVgIHN3aXRjaGVzIG9uIHJlbWJnIGJhY2tncm91bmQgcmVtb3ZhbCAoLS1hbHBoYSBhdXRvIOKGkiBiYWNrZW5kXG4vLyBcInJlbWJnXCIpIGZvciB0aGUgbmV4dCBwaGFzZTsgYW4gZXhwbGljaXQgYC0tYWxwaGFgIG92ZXJyaWRlcyB0aGUgcG9saWN5LlxuLy8gUmVhZHMgL3N0YXRlIGZvciBzb3VyY2UucGF0aCArIGVsZW1lbnRzLCBjdXRzIGVhY2ggdmlhIHJlbWJnQmFja2VuZCAo4oaSXG4vLyByZW1vdmUucHkpLCBhbmQgcG9zdHMgdGhlIHJlc3VsdCBiYWNrIHdpdGggZWxlbWVudC5hZGRWZXJzaW9uLiBTZXRzIHRoZSBidXN5XG4vLyBzcGlubmVyIGFyb3VuZCB0aGUgbG9vcDsgcGVyLWVsZW1lbnQgcHJvZ3Jlc3Mg4oaSIHN0ZGVyciwgc3VtbWFyeSDihpIgc3Rkb3V0LlxuYXN5bmMgZnVuY3Rpb24gY21kRXh0cmFjdChzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsIGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPikge1xuICBjb25zdCBzID0gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbik7XG4gIGlmICghcy5maWxlc19kaXIpIGRpZShcInNlc3Npb24gaGFzIG5vIGZpbGVzX2RpciDigJQgY2Fubm90IG1hdGVyaWFsaXplIGN1dG91dHNcIiwgXCJjb25mbGljdFwiKTtcblxuICAvLyBQb2xpY3k6IGNyb3Atb25seSBieSBkZWZhdWx0OyAtLXJlbW92ZSBmbGlwcyB0byByZW1iZyAoYXV0byk7IC0tYWxwaGEgd2lucy5cbiAgbGV0IGFscGhhOiBBbHBoYVBvbGljeSA9IGZsYWdzLnJlbW92ZSA9PT0gdHJ1ZSA/IFwiYXV0b1wiIDogXCJub25lXCI7XG4gIGlmICh0eXBlb2YgZmxhZ3MuYWxwaGEgPT09IFwic3RyaW5nXCIpIHtcbiAgICBpZiAoIVtcImF1dG9cIiwgXCJhbGxcIiwgXCJub25lXCJdLmluY2x1ZGVzKGZsYWdzLmFscGhhKSkge1xuICAgICAgZGllKGAtLWFscGhhIG11c3QgYmUgYXV0b3xhbGx8bm9uZSAoZ290ICR7ZmxhZ3MuYWxwaGF9KWApO1xuICAgIH1cbiAgICBhbHBoYSA9IGZsYWdzLmFscGhhIGFzIEFscGhhUG9saWN5O1xuICB9XG4gIC8vIFRoZSB2ZXJzaW9uIGxhYmVsID0gdGhlIHJlbW92YWwgTU9ERUw6IFwiY3JvcFwiIChubyByZW1vdmFsKSwgXCJyZW1iZ1wiIChyZW1iZydzXG4gIC8vIGRlZmF1bHQgdTJuZXQpLCBvciBhIHNwZWNpZmljIHJlbWJnIG1vZGVsIG5hbWUgb24gYSByZXRyeSAoLS1tb2RlbCwgZS5nLlxuICAvLyBpc25ldC1nZW5lcmFsLXVzZSkuIEVhY2ggbGFiZWwg4oaSIGl0cyBvd24gZmlsZSAoY3V0b3V0RmlsZW5hbWUpIHNvIHZlcnNpb25zXG4gIC8vIGNvZXhpc3QgKyBkb24ndCBjYWNoZS1jb2xsaWRlOyBhZGRWZXJzaW9uIHVwc2VydHMgYnkgdGhpcyBsYWJlbC5cbiAgY29uc3QgcmVxTW9kZWwgPSB0eXBlb2YgZmxhZ3MubW9kZWwgPT09IFwic3RyaW5nXCIgPyBmbGFncy5tb2RlbCA6IHVuZGVmaW5lZDtcbiAgLy8gUm91dGUgYnkgaWQgU0hBUEUsIG5ldmVyIGEgaGFyZGNvZGVkIG1vZGVsIGxpc3Q6IGEgbWVkaWEtZm9yZ2UgaWQgaXMgYVxuICAvLyBwcm92aWRlciBwYXRoIChoYXMgXCIvXCIpOyBhIGJhcmUgbmFtZSBpcyBhIHJlbWJnIG1vZGVsLiBUaGUgYWdlbnQgZGlzY292ZXJzXG4gIC8vIG1lZGlhLWZvcmdlIGJnLXJlbW92ZSBpZHMgdmlhIGBtZWRpYS1mb3JnZSBtb2RlbHMgbGlzdGAgYW5kIHBhc3NlcyBvbmUgaGVyZS5cbiAgY29uc3QgdXNlTWVkaWFGb3JnZSA9IHJlcU1vZGVsID8gaXNNZWRpYUZvcmdlTW9kZWwocmVxTW9kZWwpIDogZmFsc2U7XG4gIGNvbnN0IHJlbWJnTW9kZWwgPSByZXFNb2RlbCAmJiAhdXNlTWVkaWFGb3JnZSA/IHJlcU1vZGVsIDogdW5kZWZpbmVkO1xuICAvLyBUaGUgdmVyc2lvbiBsYWJlbCAoaXRzIHN0cmlwIHJvdyArIGZpbGVuYW1lKS4gRnJpZW5kbHk6IGV4cGxpY2l0IC0tbGFiZWwgd2lucztcbiAgLy8gZWxzZSBmb3IgYSBtZWRpYS1mb3JnZSBwYXRoIGlkIHVzZSB0aGUgc2VnbWVudCBhZnRlciB0aGUgdmVuZG9yOyBlbHNlIHRoZVxuICAvLyBtb2RlbCBuYW1lLiBjcm9wLW9ubHkgaGFzIG5vIG1vZGVsLlxuICBjb25zdCBleHBsaWNpdExhYmVsID0gdHlwZW9mIGZsYWdzLmxhYmVsID09PSBcInN0cmluZ1wiID8gZmxhZ3MubGFiZWwgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IGxhYmVsID1cbiAgICBhbHBoYSA9PT0gXCJub25lXCJcbiAgICAgID8gXCJjcm9wXCJcbiAgICAgIDogKGV4cGxpY2l0TGFiZWwgPz9cbiAgICAgICAgKHVzZU1lZGlhRm9yZ2UgPyAoKHJlcU1vZGVsIGFzIHN0cmluZykuc3BsaXQoXCIvXCIpWzFdID8/IFwiY2xvdWRcIikgOiAocmVxTW9kZWwgPz8gXCJyZW1iZ1wiKSkpO1xuICAvLyBEZWZhdWx0IHBhZCA9IDA6IHRoZSBzbGljZSBtdXN0IG1hdGNoIHRoZSBib3ggdGhlIHVzZXIgZHJldyAoV1lTSVdZRykuIFRoZSBib3hcbiAgLy8gSVMgdGhlIHBhZGRpbmcgY29udHJvbCDigJQgZHJhZyBhIGhhbmRsZSBvdXQgZm9yIGJyZWF0aGluZyByb29tLiAocmVtb3ZlLnB5J3Mgb3duXG4gIC8vIGRlZmF1bHQgaXMgOCwgc28gd2UgTVVTVCBwYXNzIGFuIGV4cGxpY2l0IDAsIG5vdCB1bmRlZmluZWQuKSAtLXBhZCBvdmVycmlkZXMuXG4gIGNvbnN0IHBhZCA9IHR5cGVvZiBmbGFncy5wYWQgPT09IFwic3RyaW5nXCIgPyBwYXJzZUludChmbGFncy5wYWQsIDEwKSA6IDA7XG4gIGlmIChOdW1iZXIuaXNOYU4ocGFkKSkgZGllKFwiLS1wYWQgbXVzdCBiZSBhIG51bWJlclwiKTtcbiAgY29uc3QgaWRGaWx0ZXIgPVxuICAgIHR5cGVvZiBmbGFncy5pZHMgPT09IFwic3RyaW5nXCJcbiAgICAgID8gbmV3IFNldChcbiAgICAgICAgICBmbGFncy5pZHNcbiAgICAgICAgICAgIC5zcGxpdChcIixcIilcbiAgICAgICAgICAgIC5tYXAoKHgpID0+IHgudHJpbSgpKVxuICAgICAgICAgICAgLmZpbHRlcihCb29sZWFuKSxcbiAgICAgICAgKVxuICAgICAgOiB1bmRlZmluZWQ7XG5cbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaShzLnBvcnQsIFwiR0VUXCIsIFwiL3N0YXRlXCIpO1xuICBpZiAoc3RhdHVzICE9PSAyMDApIGRpZShgc3RhdGUgZmFpbGVkIChIVFRQICR7c3RhdHVzfSlgLCBcImludGVybmFsXCIpO1xuICBjb25zdCBzdCA9IChkYXRhIGFzIHsgc3RhdGU/OiB7IHNvdXJjZT86IHsgcGF0aD86IHN0cmluZyB9OyBlbGVtZW50cz86IEVsZW1lbnRbXSB9IH0pLnN0YXRlO1xuICBjb25zdCBzb3VyY2VQYXRoID0gc3Q/LnNvdXJjZT8ucGF0aDtcbiAgaWYgKCFzb3VyY2VQYXRoKVxuICAgIGRpZShcIm5vIHNvdXJjZSBzZXQg4oCUIGRyb3AgYSBjb21wb3NpdGUgKG9yIHJ1bjogc291cmNlIDxpbWFnZVBhdGg+KSBmaXJzdFwiLCBcImNvbmZsaWN0XCIpO1xuICBsZXQgZWxlbWVudHMgPSAoc3Q/LmVsZW1lbnRzID8/IFtdKS5maWx0ZXIoKGUpID0+IGUuc3RhdHVzICE9PSBcImRyb3BwZWRcIik7XG4gIGlmIChpZEZpbHRlcikgZWxlbWVudHMgPSBlbGVtZW50cy5maWx0ZXIoKGUpID0+IGlkRmlsdGVyLmhhcyhlLmlkKSk7XG4gIC8vIFdoZW4gUkVNT1ZJTkcsIG5ldmVyIHRvdWNoIGFscGhhLWZvcmJpZGRlbiB0eXBlcyAocGFsZXR0ZSAvIHNjcmVlbnNob3QgL1xuICAvLyB0eXBvZ3JhcGh5KSDigJQgdGhleSBzdGF5IHdob2xlIGJ5IHBvbGljeS4gU2tpcCB0aGVtIHNvIHdlIGRvbid0IHdyaXRlIGFcbiAgLy8gbWlzbGFiZWxlZCwgcmVkdW5kYW50IFwicmVtb3ZhbFwiIHZlcnNpb24gdGhhdCdzIHJlYWxseSBqdXN0IHRoZSBjcm9wLlxuICBsZXQga2VwdFdob2xlID0gMDtcbiAgaWYgKGFscGhhICE9PSBcIm5vbmVcIikge1xuICAgIGNvbnN0IGJlZm9yZSA9IGVsZW1lbnRzLmxlbmd0aDtcbiAgICBlbGVtZW50cyA9IGVsZW1lbnRzLmZpbHRlcigoZSkgPT4gc2hvdWxkUmVtb3ZlKGUudHlwZSwgYWxwaGEpKTtcbiAgICBrZXB0V2hvbGUgPSBiZWZvcmUgLSBlbGVtZW50cy5sZW5ndGg7XG4gIH1cbiAgaWYgKCFlbGVtZW50cy5sZW5ndGgpIHtcbiAgICBkaWUoXG4gICAgICBrZXB0V2hvbGUgPiAwXG4gICAgICAgID8gYG5vdGhpbmcgdG8gcmVtb3ZlIOKAlCAke2tlcHRXaG9sZX0gc2VsZWN0ZWQgZWxlbWVudCR7a2VwdFdob2xlID09PSAxID8gXCIgaXMgYVwiIDogXCJzIGFyZVwifSBrZXB0LXdob2xlIHR5cGUke2tlcHRXaG9sZSA9PT0gMSA/IFwiXCIgOiBcInNcIn0gKHBhbGV0dGUvc2NyZWVuc2hvdC90eXBvZ3JhcGh5KWBcbiAgICAgICAgOiBpZEZpbHRlclxuICAgICAgICAgID8gXCJubyBtYXRjaGluZyBleHRyYWN0YWJsZSBlbGVtZW50cyBmb3IgLS1pZHNcIlxuICAgICAgICAgIDogXCJubyBleHRyYWN0YWJsZSBlbGVtZW50cyAoYWxsIGRyb3BwZWQgb3Igbm9uZSBkaXNjb3ZlcmVkKVwiLFxuICAgICk7XG4gIH1cblxuICBhd2FpdCBhcGkocy5wb3J0LCBcIlBPU1RcIiwgXCIvY21kXCIsIHsgdHlwZTogXCJzdGF0dXNcIiwgYnVzeTogdHJ1ZSwgdGV4dDogXCJleHRyYWN0aW5n4oCmXCIgfSk7XG4gIGxldCBkb25lID0gMDtcbiAgbGV0IGZhaWxlZCA9IDA7XG4gIHRyeSB7XG4gICAgZm9yIChjb25zdCBlbCBvZiBlbGVtZW50cykge1xuICAgICAgY29uc3Qgb3V0UGF0aCA9IGpvaW4ocy5maWxlc19kaXIsIGN1dG91dEZpbGVuYW1lKGVsLm5hbWUsIGxhYmVsKSk7XG4gICAgICB0cnkge1xuICAgICAgICAvLyBDbG91ZCAobWVkaWEtZm9yZ2UpIHJ1bnMgb24gdGhlIGVsZW1lbnQncyBleGlzdGluZyBjcm9wIGltYWdlIChzaW5nbGUtXG4gICAgICAgIC8vIGltYWdlIHRyYW5zZm9ybSk7IHJlbWJnIGNyb3BzIHRoZSBiYm94IGZyb20gdGhlIHNvdXJjZSBpdHNlbGYuXG4gICAgICAgIGNvbnN0IGN1dG91dCA9IHVzZU1lZGlhRm9yZ2VcbiAgICAgICAgICA/IGF3YWl0IG1lZGlhRm9yZ2VCYWNrZW5kLmN1dChcbiAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIHNvdXJjZVBhdGg6IGpvaW4ocy5maWxlc19kaXIsIGN1dG91dEZpbGVuYW1lKGVsLm5hbWUsIFwiY3JvcFwiKSksXG4gICAgICAgICAgICAgICAgYmJveDogZWwuYmJveCxcbiAgICAgICAgICAgICAgICB0eXBlOiBlbC50eXBlLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICBvdXRQYXRoLFxuICAgICAgICAgICAgICB7IG1vZGVsOiByZXFNb2RlbCB9LFxuICAgICAgICAgICAgKVxuICAgICAgICAgIDogYXdhaXQgcmVtYmdCYWNrZW5kLmN1dCh7IHNvdXJjZVBhdGgsIGJib3g6IGVsLmJib3gsIHR5cGU6IGVsLnR5cGUgfSwgb3V0UGF0aCwge1xuICAgICAgICAgICAgICBhbHBoYSxcbiAgICAgICAgICAgICAgcGFkLFxuICAgICAgICAgICAgICBtb2RlbDogcmVtYmdNb2RlbCxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICBhd2FpdCBhcGkocy5wb3J0LCBcIlBPU1RcIiwgXCIvY21kXCIsIHtcbiAgICAgICAgICB0eXBlOiBcImVsZW1lbnQuYWRkVmVyc2lvblwiLFxuICAgICAgICAgIGlkOiBlbC5pZCxcbiAgICAgICAgICAvLyBhZGRWZXJzaW9uIHVwc2VydHMgYnkgbW9kZWwgKGJ1bXBzIHJldiDihpIgY2FjaGUtYnVzdCkgYW5kIGNsZWFycyB0aGVcbiAgICAgICAgICAvLyBmbGFnOyBjcm9wID0gcmF3LCByZW1iZyBtb2RlbCA9IGxvY2FsLCBtZWRpYS1mb3JnZSA9IGNsb3VkLlxuICAgICAgICAgIHZlcnNpb246IHtcbiAgICAgICAgICAgIGlkOiBuZXdJZChcInZcIiksXG4gICAgICAgICAgICBtb2RlbDogbGFiZWwsIC8vIFwiY3JvcFwiIHwgXCJyZW1iZ1wiIHwgPHJlbWJnIG1vZGVsPiB8IDxtZWRpYS1mb3JnZSBsYWJlbD5cbiAgICAgICAgICAgIGtpbmQ6IGxhYmVsID09PSBcImNyb3BcIiA/IFwicmF3XCIgOiB1c2VNZWRpYUZvcmdlID8gXCJjbG91ZFwiIDogXCJsb2NhbFwiLFxuICAgICAgICAgICAgcGF0aDogY3V0b3V0LnBhdGgsXG4gICAgICAgICAgICByZXY6IDAsXG4gICAgICAgICAgfSxcbiAgICAgICAgICBjaG9vc2U6IHRydWUsXG4gICAgICAgIH0pO1xuICAgICAgICBkb25lKys7XG4gICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBtYWdwaWU6IGN1dCAke2VsLm5hbWV9ICgke2VsLnR5cGV9LCAke2xhYmVsfSkg4oaSICR7Y3V0b3V0LnBhdGh9XFxuYCk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGZhaWxlZCsrO1xuICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICBgbWFncGllOiBjdXQgRkFJTEVEIGZvciAke2VsLm5hbWV9OiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX1cXG5gLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cbiAgfSBmaW5hbGx5IHtcbiAgICBhd2FpdCBhcGkocy5wb3J0LCBcIlBPU1RcIiwgXCIvY21kXCIsIHsgdHlwZTogXCJzdGF0dXNcIiwgYnVzeTogZmFsc2UgfSk7XG4gIH1cbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGN1dDogZG9uZSwgZmFpbGVkLCB0b3RhbDogZWxlbWVudHMubGVuZ3RoLCBrZXB0V2hvbGUsIG1vZGVsOiBsYWJlbCB9KTtcbn1cblxuZnVuY3Rpb24gZXNjYXBlSHRtbChzOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gcy5yZXBsYWNlKFxuICAgIC9bJjw+XCJdL2csXG4gICAgKGMpID0+ICh7IFwiJlwiOiBcIiZhbXA7XCIsIFwiPFwiOiBcIiZsdDtcIiwgXCI+XCI6IFwiJmd0O1wiLCAnXCInOiBcIiZxdW90O1wiIH0pW2NdIGFzIHN0cmluZyxcbiAgKTtcbn1cblxudHlwZSBNYW5pZmVzdEFzc2V0ID0ge1xuICBuYW1lOiBzdHJpbmc7XG4gIHR5cGU6IHN0cmluZztcbiAgbW9kZWw6IHN0cmluZztcbiAga2luZDogc3RyaW5nIHwgbnVsbDtcbiAgYmJveDogbnVtYmVyW107XG4gIGZpbGU6IHN0cmluZztcbiAgY3JvcDogc3RyaW5nIHwgbnVsbDtcbn07XG5cbi8vIEEgc2VsZi1jb250YWluZWQgY29udGFjdCBzaGVldCAobWFncGllIGNyZWFtIGlkZW50aXR5KSDigJQgb3BlbiBpbiBhIGJyb3dzZXIsIG5vXG4vLyBkZXBzLiBCYWNrZHJvcCB0b2dnbGUgKGNoZWNrZXIvd2hpdGUvZ3JheS9ibGFjaykgdG8ganVkZ2UgdHJhbnNwYXJlbmN5LCBhbmRcbi8vIHR5cGUgZmlsdGVycyBidWlsdCBmcm9tIHRoZSB0YXhvbm9teSB3ZSB0YWdnZWQgZHVyaW5nIHRoZSBydW4uIGBhLmZpbGVgIGlzIHRoZVxuLy8gaW4temlwIHBhdGggKGFzc2V0cy88bmFtZT4ucG5nKS5cbmZ1bmN0aW9uIGJ1aWxkR2FsbGVyeUh0bWwodGl0bGU6IHN0cmluZywgYXNzZXRzOiBNYW5pZmVzdEFzc2V0W10pOiBzdHJpbmcge1xuICBjb25zdCB0eXBlcyA9IFsuLi5uZXcgU2V0KGFzc2V0cy5tYXAoKGEpID0+IGEudHlwZSkpXS5zb3J0KCk7XG4gIGNvbnN0IHR5cGVDaGlwcyA9IFtcImFsbFwiLCAuLi50eXBlc11cbiAgICAubWFwKCh0KSA9PiB7XG4gICAgICBjb25zdCBuID0gdCA9PT0gXCJhbGxcIiA/IGFzc2V0cy5sZW5ndGggOiBhc3NldHMuZmlsdGVyKChhKSA9PiBhLnR5cGUgPT09IHQpLmxlbmd0aDtcbiAgICAgIHJldHVybiBgPGJ1dHRvbiBjbGFzcz1cImNoaXAke3QgPT09IFwiYWxsXCIgPyBcIiBhY3RpdmVcIiA6IFwiXCJ9XCIgZGF0YS1maWx0ZXI9XCIke2VzY2FwZUh0bWwodCl9XCI+JHtlc2NhcGVIdG1sKHQpfSA8c3BhbiBjbGFzcz1cIm5cIj4ke259PC9zcGFuPjwvYnV0dG9uPmA7XG4gICAgfSlcbiAgICAuam9pbihcIlwiKTtcbiAgY29uc3QgY2FyZHMgPSBhc3NldHNcbiAgICAubWFwKFxuICAgICAgKGEpID0+IGAgICAgICA8ZmlndXJlIGNsYXNzPVwiY2FyZFwiIGRhdGEtdHlwZT1cIiR7ZXNjYXBlSHRtbChhLnR5cGUpfVwiPlxuICAgICAgICA8ZGl2IGNsYXNzPVwidGh1bWJcIj48aW1nIHNyYz1cIiR7ZXNjYXBlSHRtbChhLmZpbGUpfVwiIGFsdD1cIiR7ZXNjYXBlSHRtbChhLm5hbWUpfVwiPjwvZGl2PlxuICAgICAgICA8ZmlnY2FwdGlvbj5cbiAgICAgICAgICA8c3BhbiBjbGFzcz1cIm5hbWVcIj4ke2VzY2FwZUh0bWwoYS5uYW1lKX08L3NwYW4+XG4gICAgICAgICAgPHNwYW4gY2xhc3M9XCJtZXRhXCI+JHtlc2NhcGVIdG1sKGEudHlwZSl9IMK3ICR7ZXNjYXBlSHRtbChhLm1vZGVsKX0ke2Eua2luZCA/IGAgKCR7ZXNjYXBlSHRtbChhLmtpbmQpfSlgIDogXCJcIn08L3NwYW4+XG4gICAgICAgIDwvZmlnY2FwdGlvbj5cbiAgICAgIDwvZmlndXJlPmAsXG4gICAgKVxuICAgIC5qb2luKFwiXFxuXCIpO1xuICByZXR1cm4gYDwhZG9jdHlwZSBodG1sPlxuPGh0bWwgbGFuZz1cImVuXCI+PGhlYWQ+PG1ldGEgY2hhcnNldD1cInV0Zi04XCI+XG48dGl0bGU+JHtlc2NhcGVIdG1sKHRpdGxlKX0g4oCUIG1hZ3BpZSBhc3NldHM8L3RpdGxlPlxuPHN0eWxlPlxuICA6cm9vdCB7IC0tY3JlYW06I2Y2ZjFlNzsgLS1pbms6IzE0MTgxYjsgLS1saW5lOiNlMmQ5YzY7IC0taW5kaWdvOiM1YjViZjA7IH1cbiAgYm9keSB7IGZvbnQtZmFtaWx5Oi1hcHBsZS1zeXN0ZW0sc3lzdGVtLXVpLHNhbnMtc2VyaWY7IGJhY2tncm91bmQ6dmFyKC0tY3JlYW0pOyBjb2xvcjp2YXIoLS1pbmspOyBtYXJnaW46MDsgcGFkZGluZzoyOHB4OyB9XG4gIGgxIHsgZm9udC1zaXplOjIwcHg7IGZvbnQtd2VpZ2h0OjcwMDsgbWFyZ2luOjA7IH0gLmNvdW50IHsgY29sb3I6IzlhOGY3ODsgZm9udC13ZWlnaHQ6NDAwOyB9XG4gIC50b29sYmFyIHsgZGlzcGxheTpmbGV4OyBnYXA6MThweDsgYWxpZ24taXRlbXM6Y2VudGVyOyBmbGV4LXdyYXA6d3JhcDsgbWFyZ2luOjE2cHggMCA0cHg7IH1cbiAgLmdyb3VwIHsgZGlzcGxheTpmbGV4OyBnYXA6NnB4OyBhbGlnbi1pdGVtczpjZW50ZXI7IH1cbiAgLmxhYmVsIHsgZm9udC1zaXplOjExcHg7IGNvbG9yOiM5YThmNzg7IHRleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTsgbGV0dGVyLXNwYWNpbmc6LjA0ZW07IH1cbiAgLyogYmFja2Ryb3AgPSBjb2xvciBzd2F0Y2hlcyAobm90IHdvcmRzKTsgdHJhbnNwYXJlbnQgPSBhIG1pbmkgY2hlY2tlciBzcXVhcmUgKi9cbiAgLnN3IHsgd2lkdGg6MjJweDsgaGVpZ2h0OjIycHg7IHBhZGRpbmc6MDsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTsgYm9yZGVyLXJhZGl1czo1cHg7IGN1cnNvcjpwb2ludGVyOyBib3gtc2l6aW5nOmJvcmRlci1ib3g7IH1cbiAgLnN3LmFjdGl2ZSB7IG91dGxpbmU6MnB4IHNvbGlkIHZhcigtLWluZGlnbyk7IG91dGxpbmUtb2Zmc2V0OjFweDsgfVxuICAuc3cuY2hlY2tlciB7IGJhY2tncm91bmQtY29sb3I6I2ZmZjtcbiAgICBiYWNrZ3JvdW5kLWltYWdlOmxpbmVhci1ncmFkaWVudCg0NWRlZywjYzljOWM5IDI1JSx0cmFuc3BhcmVudCAyNSUpLGxpbmVhci1ncmFkaWVudCgtNDVkZWcsI2M5YzljOSAyNSUsdHJhbnNwYXJlbnQgMjUlKSxsaW5lYXItZ3JhZGllbnQoNDVkZWcsdHJhbnNwYXJlbnQgNzUlLCNjOWM5YzkgNzUlKSxsaW5lYXItZ3JhZGllbnQoLTQ1ZGVnLHRyYW5zcGFyZW50IDc1JSwjYzljOWM5IDc1JSk7XG4gICAgYmFja2dyb3VuZC1zaXplOjhweCA4cHg7IGJhY2tncm91bmQtcG9zaXRpb246MCAwLDAgNHB4LDRweCAtNHB4LC00cHggMDsgfVxuICAvKiBzaXplID0gYSBzbWFsbCBTL00vTCBzZWdtZW50ZWQgY29udHJvbCAqL1xuICAuc2VnIHsgZm9udDppbmhlcml0OyBmb250LXNpemU6MTJweDsgcGFkZGluZzo0cHggOXB4OyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpOyBiYWNrZ3JvdW5kOiNmZmZkZjg7IGNvbG9yOnZhcigtLWluayk7IGN1cnNvcjpwb2ludGVyOyB9XG4gIC5zZWc6Zmlyc3QtY2hpbGQgeyBib3JkZXItcmFkaXVzOjZweCAwIDAgNnB4OyB9IC5zZWc6bGFzdC1jaGlsZCB7IGJvcmRlci1yYWRpdXM6MCA2cHggNnB4IDA7IH0gLnNlZysuc2VnIHsgYm9yZGVyLWxlZnQ6bm9uZTsgfVxuICAuc2VnLmFjdGl2ZSB7IGJhY2tncm91bmQ6dmFyKC0taW5kaWdvKTsgY29sb3I6I2ZmZjsgYm9yZGVyLWNvbG9yOnZhcigtLWluZGlnbyk7IH1cbiAgLmNoaXAgeyBmb250OmluaGVyaXQ7IGZvbnQtc2l6ZToxMnB4OyBwYWRkaW5nOjRweCAxMHB4OyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpOyBib3JkZXItcmFkaXVzOjk5OXB4OyBiYWNrZ3JvdW5kOiNmZmZkZjg7IGNvbG9yOnZhcigtLWluayk7IGN1cnNvcjpwb2ludGVyOyB9XG4gIC5jaGlwLmFjdGl2ZSB7IGJhY2tncm91bmQ6dmFyKC0taW5kaWdvKTsgY29sb3I6I2ZmZjsgYm9yZGVyLWNvbG9yOnZhcigtLWluZGlnbyk7IH1cbiAgLmNoaXAgLm4geyBvcGFjaXR5Oi42OyBtYXJnaW4tbGVmdDoycHg7IH1cbiAgLmdyaWQgeyBkaXNwbGF5OmdyaWQ7IGdyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoYXV0by1maWxsLG1pbm1heCgxNzBweCwxZnIpKTsgZ2FwOjEwcHg7IG1hcmdpbi10b3A6MTZweDsgfVxuICBib2R5W2RhdGEtc2l6ZT1cInNtXCJdIC5ncmlkIHsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdChhdXRvLWZpbGwsbWlubWF4KDEzMnB4LDFmcikpOyB9XG4gIGJvZHlbZGF0YS1zaXplPVwibGdcIl0gLmdyaWQgeyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KGF1dG8tZmlsbCxtaW5tYXgoMjY0cHgsMWZyKSk7IGdhcDoxNHB4OyB9XG4gIC5jYXJkIHsgYmFja2dyb3VuZDojZmZmZGY4OyBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpOyBib3JkZXItcmFkaXVzOjEwcHg7IG92ZXJmbG93OmhpZGRlbjsgbWluLXdpZHRoOjA7IH1cbiAgLnRodW1iIHsgaGVpZ2h0OjE2MHB4OyBkaXNwbGF5OmZsZXg7IGFsaWduLWl0ZW1zOmNlbnRlcjsganVzdGlmeS1jb250ZW50OmNlbnRlcjsgYmFja2dyb3VuZC1jb2xvcjojZmZmO1xuICAgIGJhY2tncm91bmQtaW1hZ2U6bGluZWFyLWdyYWRpZW50KDQ1ZGVnLCNlN2UwZDIgMjUlLHRyYW5zcGFyZW50IDI1JSksbGluZWFyLWdyYWRpZW50KC00NWRlZywjZTdlMGQyIDI1JSx0cmFuc3BhcmVudCAyNSUpLGxpbmVhci1ncmFkaWVudCg0NWRlZyx0cmFuc3BhcmVudCA3NSUsI2U3ZTBkMiA3NSUpLGxpbmVhci1ncmFkaWVudCgtNDVkZWcsdHJhbnNwYXJlbnQgNzUlLCNlN2UwZDIgNzUlKTtcbiAgICBiYWNrZ3JvdW5kLXNpemU6MTZweCAxNnB4OyBiYWNrZ3JvdW5kLXBvc2l0aW9uOjAgMCwwIDhweCw4cHggLThweCwtOHB4IDA7IH1cbiAgYm9keVtkYXRhLXNpemU9XCJzbVwiXSAudGh1bWIgeyBoZWlnaHQ6MTEycHg7IH0gYm9keVtkYXRhLXNpemU9XCJsZ1wiXSAudGh1bWIgeyBoZWlnaHQ6MjQwcHg7IH1cbiAgYm9keVtkYXRhLWJnPVwid2hpdGVcIl0gLnRodW1iIHsgYmFja2dyb3VuZDojZmZmIWltcG9ydGFudDsgYmFja2dyb3VuZC1pbWFnZTpub25lIWltcG9ydGFudDsgfVxuICBib2R5W2RhdGEtYmc9XCJncmF5XCJdIC50aHVtYiB7IGJhY2tncm91bmQ6IzhhOGE4YSFpbXBvcnRhbnQ7IGJhY2tncm91bmQtaW1hZ2U6bm9uZSFpbXBvcnRhbnQ7IH1cbiAgYm9keVtkYXRhLWJnPVwiYmxhY2tcIl0gLnRodW1iIHsgYmFja2dyb3VuZDojMTExIWltcG9ydGFudDsgYmFja2dyb3VuZC1pbWFnZTpub25lIWltcG9ydGFudDsgfVxuICAudGh1bWIgaW1nIHsgbWF4LXdpZHRoOjg4JTsgbWF4LWhlaWdodDo4OCU7IG9iamVjdC1maXQ6Y29udGFpbjsgfVxuICBmaWdjYXB0aW9uIHsgcGFkZGluZzo3cHggOXB4OyBkaXNwbGF5OmZsZXg7IGZsZXgtZGlyZWN0aW9uOmNvbHVtbjsgZ2FwOjFweDsgbWluLXdpZHRoOjA7IH1cbiAgLm5hbWUsIC5tZXRhIHsgd2hpdGUtc3BhY2U6bm93cmFwOyBvdmVyZmxvdzpoaWRkZW47IHRleHQtb3ZlcmZsb3c6ZWxsaXBzaXM7IH1cbiAgLm5hbWUgeyBmb250LXNpemU6MTIuNXB4OyBmb250LXdlaWdodDo2MDA7IH0gLm1ldGEgeyBmb250LXNpemU6MTFweDsgY29sb3I6IzZmNmM2NjsgfVxuPC9zdHlsZT48L2hlYWQ+PGJvZHkgZGF0YS1iZz1cImNoZWNrZXJcIiBkYXRhLXNpemU9XCJtZFwiPlxuICA8aDE+8J+QpiAke2VzY2FwZUh0bWwodGl0bGUpfSA8c3BhbiBjbGFzcz1cImNvdW50XCI+4oCUICR7YXNzZXRzLmxlbmd0aH0gYXNzZXQke2Fzc2V0cy5sZW5ndGggPT09IDEgPyBcIlwiIDogXCJzXCJ9PC9zcGFuPjwvaDE+XG4gIDxkaXYgY2xhc3M9XCJ0b29sYmFyXCI+XG4gICAgPGRpdiBjbGFzcz1cImdyb3VwXCI+PHNwYW4gY2xhc3M9XCJsYWJlbFwiPkJhY2tkcm9wPC9zcGFuPlxuICAgICAgPGJ1dHRvbiBjbGFzcz1cInN3IGNoZWNrZXIgYWN0aXZlXCIgZGF0YS1iZy1idG49XCJjaGVja2VyXCIgdGl0bGU9XCJUcmFuc3BhcmVudFwiPjwvYnV0dG9uPlxuICAgICAgPGJ1dHRvbiBjbGFzcz1cInN3XCIgZGF0YS1iZy1idG49XCJ3aGl0ZVwiIHN0eWxlPVwiYmFja2dyb3VuZDojZmZmZmZmXCIgdGl0bGU9XCJXaGl0ZVwiPjwvYnV0dG9uPlxuICAgICAgPGJ1dHRvbiBjbGFzcz1cInN3XCIgZGF0YS1iZy1idG49XCJncmF5XCIgc3R5bGU9XCJiYWNrZ3JvdW5kOiM4YThhOGFcIiB0aXRsZT1cIkdyYXlcIj48L2J1dHRvbj5cbiAgICAgIDxidXR0b24gY2xhc3M9XCJzd1wiIGRhdGEtYmctYnRuPVwiYmxhY2tcIiBzdHlsZT1cImJhY2tncm91bmQ6IzExMTExMVwiIHRpdGxlPVwiQmxhY2tcIj48L2J1dHRvbj5cbiAgICA8L2Rpdj5cbiAgICA8ZGl2IGNsYXNzPVwiZ3JvdXBcIj48c3BhbiBjbGFzcz1cImxhYmVsXCI+U2l6ZTwvc3Bhbj5cbiAgICAgIDxidXR0b24gY2xhc3M9XCJzZWdcIiBkYXRhLXNpemUtYnRuPVwic21cIiB0aXRsZT1cIlNtYWxsXCI+UzwvYnV0dG9uPlxuICAgICAgPGJ1dHRvbiBjbGFzcz1cInNlZyBhY3RpdmVcIiBkYXRhLXNpemUtYnRuPVwibWRcIiB0aXRsZT1cIk1lZGl1bVwiPk08L2J1dHRvbj5cbiAgICAgIDxidXR0b24gY2xhc3M9XCJzZWdcIiBkYXRhLXNpemUtYnRuPVwibGdcIiB0aXRsZT1cIkxhcmdlXCI+TDwvYnV0dG9uPlxuICAgIDwvZGl2PlxuICAgIDxkaXYgY2xhc3M9XCJncm91cFwiPjxzcGFuIGNsYXNzPVwibGFiZWxcIj5UeXBlPC9zcGFuPiR7dHlwZUNoaXBzfTwvZGl2PlxuICA8L2Rpdj5cbiAgPGRpdiBjbGFzcz1cImdyaWRcIj5cbiR7Y2FyZHN9XG4gIDwvZGl2PlxuICA8c2NyaXB0PlxuICAgIHZhciBib2R5PWRvY3VtZW50LmJvZHk7XG4gICAgZnVuY3Rpb24gd2lyZShzZWwsIGFwcGx5KXsgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbChzZWwpLmZvckVhY2goZnVuY3Rpb24oYil7IGIuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBmdW5jdGlvbigpe1xuICAgICAgYXBwbHkoYik7XG4gICAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKHNlbCkuZm9yRWFjaChmdW5jdGlvbih4KXsgeC5jbGFzc0xpc3QudG9nZ2xlKCdhY3RpdmUnLCB4PT09Yik7IH0pO1xuICAgIH0pOyB9KTsgfVxuICAgIHdpcmUoJ1tkYXRhLWJnLWJ0bl0nLCBmdW5jdGlvbihiKXsgYm9keS5kYXRhc2V0LmJnPWIuZGF0YXNldC5iZ0J0bjsgfSk7XG4gICAgd2lyZSgnW2RhdGEtc2l6ZS1idG5dJywgZnVuY3Rpb24oYil7IGJvZHkuZGF0YXNldC5zaXplPWIuZGF0YXNldC5zaXplQnRuOyB9KTtcbiAgICB2YXIgY2FyZHM9W10uc2xpY2UuY2FsbChkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY2FyZCcpKTtcbiAgICB3aXJlKCdbZGF0YS1maWx0ZXJdJywgZnVuY3Rpb24oYil7IHZhciB0PWIuZGF0YXNldC5maWx0ZXI7XG4gICAgICBjYXJkcy5mb3JFYWNoKGZ1bmN0aW9uKGMpeyBjLnN0eWxlLmRpc3BsYXk9KHQ9PT0nYWxsJ3x8Yy5kYXRhc2V0LnR5cGU9PT10KT8nJzonbm9uZSc7IH0pOyB9KTtcbiAgPC9zY3JpcHQ+XG48L2JvZHk+PC9odG1sPlxuYDtcbn1cblxuLy8gYGV4cG9ydCBbLS1pZHMgYSxiXWAg4oCUIGJ1aWxkIHRoZSBkb3dubG9hZGFibGUgYXNzZXQgYnVuZGxlIGZyb20gZWFjaCBlbGVtZW50J3Ncbi8vIENIT1NFTiB2ZXJzaW9uOiBzdGFnZSBjbGVhbi1uYW1lZCBQTkdzICgrIHRoZSByYXcgY3JvcCB3aGVuIHRoZSBjaG9zZW4gaXMgYVxuLy8gcmVtb3ZhbCkgKyBtYW5pZmVzdC5qc29uICsgZ2FsbGVyeS5odG1sLCB6aXAgaW50byB0aGUgc2Vzc2lvbiBmaWxlcyBkaXIsIGFuZFxuLy8gcG9zdCBidW5kbGUuc2V0IHNvIHRoZSBzdXJmYWNlIG9mZmVycyBpdCB2aWEgL2Fzc2V0cy88bmFtZT4uIFJlc29sdmVzIHZlcnNpb25cbi8vIGZpbGVzIGJ5IEJBU0VOQU1FIGluIGZpbGVzX2RpciAocm9idXN0IHRvIHN0YWxlIGFic29sdXRlIHBhdGhzIGFmdGVyIGEgcmVzdG9yZSkuXG5hc3luYyBmdW5jdGlvbiBjbWRFeHBvcnQoc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkLCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgcyA9IHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pO1xuICBpZiAoIXMuZmlsZXNfZGlyKSBkaWUoXCJzZXNzaW9uIGhhcyBubyBmaWxlc19kaXIg4oCUIGNhbm5vdCBidWlsZCBhIGJ1bmRsZVwiLCBcImNvbmZsaWN0XCIpO1xuICBjb25zdCBpZEZpbHRlciA9XG4gICAgdHlwZW9mIGZsYWdzLmlkcyA9PT0gXCJzdHJpbmdcIlxuICAgICAgPyBuZXcgU2V0KFxuICAgICAgICAgIGZsYWdzLmlkc1xuICAgICAgICAgICAgLnNwbGl0KFwiLFwiKVxuICAgICAgICAgICAgLm1hcCgoeCkgPT4geC50cmltKCkpXG4gICAgICAgICAgICAuZmlsdGVyKEJvb2xlYW4pLFxuICAgICAgICApXG4gICAgICA6IHVuZGVmaW5lZDtcblxuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpKHMucG9ydCwgXCJHRVRcIiwgXCIvc3RhdGVcIik7XG4gIGlmIChzdGF0dXMgIT09IDIwMCkgZGllKGBzdGF0ZSBmYWlsZWQgKEhUVFAgJHtzdGF0dXN9KWAsIFwiaW50ZXJuYWxcIik7XG4gIGNvbnN0IHN0ID0gKGRhdGEgYXMgeyBzdGF0ZT86IHsgdGl0bGU/OiBzdHJpbmc7IGVsZW1lbnRzPzogRWxlbWVudFtdIH0gfSkuc3RhdGU7XG4gIGxldCBlbGVtZW50cyA9IChzdD8uZWxlbWVudHMgPz8gW10pLmZpbHRlcigoZSkgPT4gZS5zdGF0dXMgIT09IFwiZHJvcHBlZFwiKTtcbiAgaWYgKGlkRmlsdGVyKSBlbGVtZW50cyA9IGVsZW1lbnRzLmZpbHRlcigoZSkgPT4gaWRGaWx0ZXIuaGFzKGUuaWQpKTtcbiAgaWYgKCFlbGVtZW50cy5sZW5ndGgpXG4gICAgZGllKGlkRmlsdGVyID8gXCJubyBtYXRjaGluZyBlbGVtZW50cyBmb3IgLS1pZHNcIiA6IFwibm8gYXNzZXRzIHRvIGV4cG9ydFwiLCBcImNvbmZsaWN0XCIpO1xuICBjb25zdCB0aXRsZSA9IHN0Py50aXRsZSA/PyBcIm1hZ3BpZVwiO1xuXG4gIGNvbnN0IHN0YWdlRGlyID0gam9pbihzLmZpbGVzX2RpciwgXCJidW5kbGUtc3RhZ2VcIik7XG4gIGNvbnN0IHppcE5hbWUgPSBcIm1hZ3BpZS1idW5kbGUuemlwXCI7XG4gIGxldCByZXN1bHQ6IHsgY291bnQ6IG51bWJlciB9IHwgbnVsbCA9IG51bGw7XG4gIGxldCBmYWlsdXJlOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgLy8gVGhlIGBleHBvcnRgIGltcGVyYXRpdmUgc2V0IHN0YXR1cy5idXN5IG9uIHJlY2VpcHQ7IGNsZWFyIGl0IChhbmQgY2xlYW4gdGhlXG4gIC8vIHN0YWdlIGRpcikgb24gRVZFUlkgZXhpdCBwYXRoIOKAlCBvdGhlcndpc2UgdGhlIEV4cG9ydCBvdmVybGF5IHN0aWNrcy5cbiAgdHJ5IHtcbiAgICBybVN5bmMoc3RhZ2VEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICAvLyBGb2xkZXJpemU6IGZpbmFsIGNob3NlbiBhc3NldHMgdW5kZXIgYXNzZXRzLywgcmF3IGNyb3BzIHVuZGVyIGNyb3BzLyDigJQgc28gYVxuICAgIC8vIHdob2xlIGZvbGRlciBjYW4gYmUgZ3JhYmJlZCB3aXRob3V0IHBhcnNpbmcgbWl4ZWQgZmlsZXMuIGNyb3BzLyBpcyBjcmVhdGVkXG4gICAgLy8gbGF6aWx5IChvbmx5IGlmIHNvbWUgaXRlbSBoYXMgYSBzZXBhcmF0ZSByYXcgY3JvcCkuXG4gICAgY29uc3QgYXNzZXRzRGlyID0gam9pbihzdGFnZURpciwgXCJhc3NldHNcIik7XG4gICAgY29uc3QgY3JvcHNEaXIgPSBqb2luKHN0YWdlRGlyLCBcImNyb3BzXCIpO1xuICAgIG1rZGlyU3luYyhhc3NldHNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuXG4gICAgY29uc3QgbWFuaWZlc3Q6IE1hbmlmZXN0QXNzZXRbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgZWwgb2YgZWxlbWVudHMpIHtcbiAgICAgIGNvbnN0IGNob3NlbiA9IGNob3NlblZlcnNpb24oZWwpO1xuICAgICAgaWYgKCFjaG9zZW4pIGNvbnRpbnVlO1xuICAgICAgY29uc3QgY2hvc2VuRmlsZSA9IGpvaW4ocy5maWxlc19kaXIsIGJhc2VuYW1lKGNob3Nlbi5wYXRoKSk7XG4gICAgICBpZiAoIWV4aXN0c1N5bmMoY2hvc2VuRmlsZSkpIHtcbiAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYG1hZ3BpZSBleHBvcnQ6IG1pc3NpbmcgZmlsZSBmb3IgJHtlbC5uYW1lfSAoJHtjaG9zZW4ubW9kZWx9KVxcbmApO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGZpbGVCYXNlID0gYCR7c2FuaXRpemUoZWwubmFtZSl9LnBuZ2A7XG4gICAgICBjb3B5RmlsZVN5bmMoY2hvc2VuRmlsZSwgam9pbihhc3NldHNEaXIsIGZpbGVCYXNlKSk7XG4gICAgICAvLyB0aGUgcmF3IGNyb3AgdG9vLCBidXQgb25seSB3aGVuIHRoZSBjaG9zZW4gaXMgYSByZW1vdmFsIChlbHNlIGl0J3MgdGhlXG4gICAgICAvLyBzYW1lIGltYWdlIGFzIHRoZSBhc3NldCkuIFNhbWUgYmFzZSBuYW1lLCBpbiBjcm9wcy8uXG4gICAgICBsZXQgY3JvcFBhdGg6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICAgICAgaWYgKGNob3Nlbi5tb2RlbCAhPT0gXCJjcm9wXCIpIHtcbiAgICAgICAgY29uc3QgY3JvcEZpbGUgPSBqb2luKHMuZmlsZXNfZGlyLCBjdXRvdXRGaWxlbmFtZShlbC5uYW1lLCBcImNyb3BcIikpO1xuICAgICAgICBpZiAoZXhpc3RzU3luYyhjcm9wRmlsZSkpIHtcbiAgICAgICAgICBta2RpclN5bmMoY3JvcHNEaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgICAgICAgIGNvcHlGaWxlU3luYyhjcm9wRmlsZSwgam9pbihjcm9wc0RpciwgZmlsZUJhc2UpKTtcbiAgICAgICAgICBjcm9wUGF0aCA9IGBjcm9wcy8ke2ZpbGVCYXNlfWA7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIG1hbmlmZXN0LnB1c2goe1xuICAgICAgICBuYW1lOiBlbC5uYW1lLFxuICAgICAgICB0eXBlOiBlbC50eXBlLFxuICAgICAgICBtb2RlbDogY2hvc2VuLm1vZGVsLFxuICAgICAgICBraW5kOiBjaG9zZW4ua2luZCA/PyBudWxsLFxuICAgICAgICBiYm94OiBlbC5iYm94LFxuICAgICAgICBmaWxlOiBgYXNzZXRzLyR7ZmlsZUJhc2V9YCxcbiAgICAgICAgY3JvcDogY3JvcFBhdGgsXG4gICAgICB9KTtcbiAgICB9XG4gICAgaWYgKCFtYW5pZmVzdC5sZW5ndGgpIHRocm93IG5ldyBFcnJvcihcIm5vIGNob3NlbiBhc3NldHMgZm91bmQgdG8gZXhwb3J0IChmaWxlcyBtaXNzaW5nPylcIik7XG5cbiAgICB3cml0ZUZpbGVTeW5jKFxuICAgICAgam9pbihzdGFnZURpciwgXCJtYW5pZmVzdC5qc29uXCIpLFxuICAgICAgSlNPTi5zdHJpbmdpZnkoeyB0aXRsZSwgY291bnQ6IG1hbmlmZXN0Lmxlbmd0aCwgYXNzZXRzOiBtYW5pZmVzdCB9LCBudWxsLCAyKSxcbiAgICApO1xuICAgIHdyaXRlRmlsZVN5bmMoam9pbihzdGFnZURpciwgXCJnYWxsZXJ5Lmh0bWxcIiksIGJ1aWxkR2FsbGVyeUh0bWwodGl0bGUsIG1hbmlmZXN0KSk7XG5cbiAgICAvLyB6aXAgaW50byBmaWxlc19kaXIgKG91dHNpZGUgdGhlIHN0YWdlIHNvIHRoZSBhcmNoaXZlIGlzbid0IHNlbGYtaW5jbHVkZWQpLlxuICAgIGNvbnN0IHppcFBhdGggPSBqb2luKHMuZmlsZXNfZGlyLCB6aXBOYW1lKTtcbiAgICBybVN5bmMoemlwUGF0aCwgeyBmb3JjZTogdHJ1ZSB9KTtcbiAgICBjb25zdCBwcm9jID0gQnVuLnNwYXduKFtcInppcFwiLCBcIi1yXCIsIFwiLXFcIiwgemlwUGF0aCwgXCIuXCJdLCB7XG4gICAgICBjd2Q6IHN0YWdlRGlyLFxuICAgICAgc3Rkb3V0OiBcInBpcGVcIixcbiAgICAgIHN0ZGVycjogXCJwaXBlXCIsXG4gICAgfSk7XG4gICAgY29uc3QgW3plcnIsIHpjb2RlXSA9IGF3YWl0IFByb21pc2UuYWxsKFtuZXcgUmVzcG9uc2UocHJvYy5zdGRlcnIpLnRleHQoKSwgcHJvYy5leGl0ZWRdKTtcbiAgICBpZiAoemNvZGUgIT09IDApIHRocm93IG5ldyBFcnJvcihgemlwIGZhaWxlZCAoZXhpdCAke3pjb2RlfSk6ICR7emVyci50cmltKCl9YCk7XG5cbiAgICBhd2FpdCBhcGkocy5wb3J0LCBcIlBPU1RcIiwgXCIvY21kXCIsIHtcbiAgICAgIHR5cGU6IFwiYnVuZGxlLnNldFwiLFxuICAgICAgbmFtZTogemlwTmFtZSxcbiAgICAgIGNvdW50OiBtYW5pZmVzdC5sZW5ndGgsXG4gICAgfSk7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYG1hZ3BpZTogYnVuZGxlZCAke21hbmlmZXN0Lmxlbmd0aH0gYXNzZXQocykg4oaSICR7emlwUGF0aH1cXG5gKTtcbiAgICByZXN1bHQgPSB7IGNvdW50OiBtYW5pZmVzdC5sZW5ndGggfTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGZhaWx1cmUgPSBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSk7XG4gIH0gZmluYWxseSB7XG4gICAgcm1TeW5jKHN0YWdlRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgYXdhaXQgYXBpKHMucG9ydCwgXCJQT1NUXCIsIFwiL2NtZFwiLCB7IHR5cGU6IFwic3RhdHVzXCIsIGJ1c3k6IGZhbHNlIH0pO1xuICB9XG5cbiAgaWYgKGZhaWx1cmUgfHwgIXJlc3VsdCkgZGllKGBleHBvcnQgZmFpbGVkOiAke2ZhaWx1cmUgPz8gXCJ1bmtub3duXCJ9YCwgXCJpbnRlcm5hbFwiKTtcbiAgcHJpbnRKc29uKHsgb2s6IHRydWUsIGJ1bmRsZTogemlwTmFtZSwgY291bnQ6IHJlc3VsdC5jb3VudCB9KTtcbn1cblxuY29uc3QgSEVMUCA9IGBtYWdwaWUg4oCUIGEgc3RhbmRpbmcgcmV2aWV3IHN1cmZhY2UgZm9yIGV4dHJhY3RpbmcgYXNzZXRzIGZyb20gYSBjb21wb3NpdGUgaW1hZ2UuXG5cbiAgb3BlbiAgIFstLXRpdGxlIC4uXSBbLS1pbnRlbnQgLi5dIFstLW5vLW9wZW5dIFstLXRpbWVvdXQgU10gWy0tcmVzdG9yZSA8aWR8cGF0aD5dXG4gIHNlc3Npb25zICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxpc3Qgc2F2ZWQgKHJlc3VtYWJsZSkgc2Vzc2lvbnNcbiAgdGFpbCAgIFstLXNpbmNlIE5dICAgICAgICAgICAgICAgICAgU1NFIHVzZXIgZXZlbnRzIOKGkiBKU09OTCAod3JhcCB3aXRoIE1vbml0b3IpXG4gIHN0YXRlICBbLS1mdWxsXSAgICAgICAgICAgICAgICAgICAgIGxlYW4gc3RhdGUgc25hcHNob3QgKGFkZCAtLWZ1bGwgZm9yIHJhdylcbiAgc2F5ICAgIFt0ZXh0Li4uXSBbLS1zdGRpbl0gICAgICAgICAgcG9zdCBhZ2VudCBkaWFsb2d1ZSAodGV4dCBhcmdzIE9SIHBpcGVkIHN0ZGluKVxuICBhc2sgICAgPHRleHQuLi4+IFstLW9wdGlvbnMgXCJhfGJ8Y1wiXSAgIGFzayB0aGUgdXNlciBhIHF1ZXN0aW9uIChpbi10aHJlYWQpXG4gIHN0YXR1cyBvbiBbdGV4dC4uLl0gfCBzdGF0dXMgb2ZmICAgIHNob3cvaGlkZSB0aGUgXCJtYWdwaWUgd29ya2luZ1wiIHNwaW5uZXJcbiAgc291cmNlIDxpbWFnZVBhdGg+ICAgICAgICAgICAgICAgICAgcmVnaXN0ZXIgdGhlIGNvbXBvc2l0ZSB1bmRlciByZXZpZXcgKGNvbXB1dGVzIHNoYSArIHNpemUpXG4gIGRpc2NvdmVyICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJ1biBkaXNjb3ZlciBvbiB0aGUgY3VycmVudCBzb3VyY2Ug4oaSIHBvc3QgdGhlIGJyZWFrZG93biAobmVlZHMgT1BFTlJPVVRFUl9BUElfS0VZKVxuICBleHRyYWN0IFstLWlkcyBhLGJdIFstLXJlbW92ZV0gWy0tYWxwaGEgYXV0b3xhbGx8bm9uZV0gWy0tcGFkIE5dIFstLW1vZGVsIDxtPl0gWy0tbGFiZWwgPG5hbWU+XVxuICAgICAgICAgIGN1dCBzbGljZXMgKGNyb3Atb25seTsgLS1yZW1vdmUgYWRkcyByZW1iZykuIC0tbW9kZWwgPSBhIHJlbWJnIG1vZGVsIG5hbWUgKGlzbmV0LWdlbmVyYWwtdXNlLFxuICAgICAgICAgIGJpcmVmbmV0LWdlbmVyYWwsIOKApikgT1IgYSBtZWRpYS1mb3JnZSBiZy1yZW1vdmUgbW9kZWwgaWQgKGEgcHJvdmlkZXIgcGF0aCBsaWtlXG4gICAgICAgICAgZmFsLWFpL2JyaWEvYmFja2dyb3VuZC9yZW1vdmUg4oCUIERJU0NPVkVSIHZpYSBcXGBtZWRpYS1mb3JnZSBtb2RlbHMgbGlzdFxcYCwgbmV2ZXIgaGFyZGNvZGUpO1xuICAgICAgICAgIC0tbGFiZWwgc2V0cyB0aGUgdmVyc2lvbidzIGZyaWVuZGx5IHN0cmlwIGxhYmVsIChkZWZhdWx0cyBzZW5zaWJseSlcbiAgZXhwb3J0IFstLWlkcyBhLGJdICAgICAgICAgICAgICAgICAgYnVpbGQgbWFncGllLWJ1bmRsZS56aXAg4oCUIGFzc2V0cy8gKGNob3NlbiBmaW5hbHMpICsgY3JvcHMvIChyYXcgY3JvcHMpICsgbWFuaWZlc3QuanNvbiArIGdhbGxlcnkuaHRtbCAoYmFja2Ryb3AgdG9nZ2xlICsgdHlwZSBmaWx0ZXJzKVxuICBlbGVtZW50LWFkZCAtLWJib3ggXCJ4MSx5MSx4Mix5MlwiIFstLW5hbWUgLi5dIFstLXR5cGUgLi5dICAgYm94IGEgcmVnaW9uIChzb3VyY2UgcHgpXG4gIGVsZW1lbnQtcmVtb3ZlIDxpZD4gICAgICAgICAgICAgICAgIHJldHJhY3QgYSBib3hlZCByZWdpb25cbiAgY21kICAgIFstLXN0ZGluXSAgICAgICAgICAgICAgICAgICAgUE9TVCBhIHJhdyBBZ2VudENvbW1hbmQgSlNPTiBib2R5IGZyb20gc3RkaW5cbiAgY2xvc2UgfCBpbmZvIHwgaGVscFxuICAtLXZlcnNpb24gICAgICAgICAgICAgICAgICAgICAgICAgICBwcmludCBtYWdwaWUncyB2ZXJzaW9uIGFzIEpTT05cblxuICBBZGQgLS1zZXNzaW9uIDxpZD4gdG8gdGFyZ2V0IGEgc3BlY2lmaWMgc2Vzc2lvbiAoZGVmYXVsdDogbW9zdCByZWNlbnQpLiBJdCBpc1xuICBhY2NlcHRlZCBieSBldmVyeSB2ZXJiIHRoYXQgYWN0cyBvbiBhIHNlc3Npb24g4oCUIG5vdCBieSBvcGVuLCBzZXNzaW9ucyBvciBoZWxwLFxuICB3aGljaCBkbyBub3QgaGF2ZSBvbmUgdG8gdGFyZ2V0LlxuXG4gIEZsYWdzIGFyZSBzY29wZWQgdG8gdGhlaXIgdmVyYjogZXh0cmFjdCdzIC0tcGFkIGlzIG5vdCBhY2NlcHRlZCBieSBzYXkuIEFcbiAgcmVqZWN0aW9uIGxpc3RzIHdoYXQgdGhlIHZlcmIgaXQgbmFtZXMgZG9lcyBhY2NlcHQuXG5cbiAgT3V0cHV0OiBtYWdwaWUgcHJpbnRzIEpTT04gYnkgZGVmYXVsdCBvbiBzdGRvdXQuIEV2ZXJ5IHZlcmIgd3JpdGVzIE9ORSBKU09OXG4gIGRvY3VtZW50IHRoZXJlIOKAlCBleGNlcHQgXFxgdGFpbFxcYCwgd2hpY2ggaXMgYSBzdHJlYW0gYW5kIHdyaXRlcyBvbmUgcGVyIGxpbmVcbiAgKEpTT05MKS4gUHJvc2UsIGxpdmVuZXNzIGFuZCBkaWFnbm9zdGljcyBnbyB0byBzdGRlcnIuIFxcYC0tZnVsbFxcYFxuICB3aWRlbnMgdGhlIHN0YXRlIHBheWxvYWQ7IGl0IGRvZXMgbm90IHN3aXRjaCBmb3JtYXRzLmA7XG5cbi8qKlxuICogVGhlIGZhaWx1cmUgZnVubmVsLiBgZGllYCBUSFJPV1MgYSBDbGlFcnJvciBub3cgKHRoZSBob3VzZSdzIG9uZSBlcnJvclxuICogY29udHJhY3QsIGBzcmMva2l0L3dpcmUvZXJyb3JzLnRzYCkgaW5zdGVhZCBvZiBleGl0aW5nIGZyb20gd2hlcmV2ZXIgaXQgd2FzXG4gKiBjYWxsZWQsIHNvIHRoaXMgaXMgdGhlIE9ORSBwbGFjZSBhIGZhaWx1cmUgYmVjb21lcyBhbiBleGl0IGNvZGUg4oCUIGFuZCB0aGVcbiAqIHByb2Nlc3Mgc3RpbGwgZW5kcyB0aGUgb25lIHdheSB0aGUgaG91c2Ugc2FuY3Rpb25zLCBgcHJvY2Vzcy5leGl0Q29kZWAgcGx1cyBhXG4gKiBuYXR1cmFsIHJldHVybiwgd2hpY2ggaXMgd2hhdCBkcmFpbnMgc3Rkb3V0IG9uIGEgcGlwZS5cbiAqXG4gKiDim5QgQSBOT04tQ2xpRXJyb3IgSVMgUkVUSFJPV04sIE5FVkVSIEVOVkVMT1BFRC4gUmVwb3J0aW5nIGFuIHVua25vd24gdGhyb3cgYXNcbiAqIGEgdGlkeSB0YXhvbm9teSBmYWlsdXJlIHdvdWxkIGxvc2UgdGhlIHN0YWNrIHRoYXQgc2F5cyB3aGF0IGFjdHVhbGx5IGJyb2tlLlxuICogKGBVc2FnZUVycm9yYCBpcyBhbnN3ZXJlZCBpbnNpZGUgYGRpc3BhdGNoYCwgd2hlcmUgaXRzIGNob2ljZXMgbGlzdCBpcy4pXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICB0cnkge1xuICAgIHJldHVybiBhd2FpdCBkaXNwYXRjaChhcmd2KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnN0IGNvZGUgPSByZXBvcnRDbGlFcnJvcihlKTtcbiAgICBpZiAoY29kZSA9PT0gbnVsbCkgdGhyb3cgZTtcbiAgICByZXR1cm4gY29kZTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBkaXNwYXRjaChhcmd2OiBzdHJpbmdbXSk6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IFt2ZXJiLCAuLi5yZXN0XSA9IGFyZ3Y7XG4gIHNldEN1cnJlbnRDb21tYW5kKHZlcmIgPz8gbnVsbCk7XG5cbiAgLy8gUk9PVCBUT0tFTlMgRklSU1QsIGJlZm9yZSBhbnkgZmxhZyBwYXJzaW5nLiBUaGVzZSBhcmUgbm90IHZlcmJzIGFuZCB0aGV5XG4gIC8vIGNhcnJ5IG5vIGZsYWdzLCBzbyByZXNvbHZpbmcgdGhlbSBoZXJlIGtlZXBzIHRoZW0gb3V0IG9mIGV2ZXJ5IHZlcmIncyBzZXQuXG4gIGlmICh2ZXJiID09PSBcIi0taGVscFwiIHx8IHZlcmIgPT09IFwiLWhcIikge1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0hFTFB9XFxuYCk7XG4gICAgcmV0dXJuIDA7XG4gIH1cbiAgaWYgKHZlcmIgPT09IFwiLS12ZXJzaW9uXCIgfHwgdmVyYiA9PT0gXCItVlwiKSB7XG4gICAgcHJpbnRKc29uKHsgbmFtZTogXCJtYWdwaWVcIiwgdmVyc2lvbjogUExVR0lOX1ZFUlNJT04gfSk7XG4gICAgcmV0dXJuIDA7XG4gIH1cbiAgaWYgKHZlcmIgPT09IHVuZGVmaW5lZCkge1xuICAgIC8vIEEgYmFyZSBpbnZvY2F0aW9uIGlzIGEgdXNhZ2UgZXJyb3IsIG5vdCBhIGhlbHAgcGF0aCDigJQgbWFncGllIGlzIGRyaXZlbiBieVxuICAgIC8vIGFuIGFnZW50LCBhbmQgYW4gZW1wdHkgYXJndiBpcyBhbiBhZ2VudCB0aGF0IGZhaWxlZCB0byBuYW1lIHdoYXQgaXRcbiAgICAvLyB3YW50ZWQuIHN0ZG91dCBzdGF5cyBlbXB0eTsgaXQgY2FycmllcyBkYXRhIGFuZCB0aGlzIGhhcyBub25lLlxuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgZXJyb3JFbnZlbG9wZShcInVzYWdlXCIsIFwibm8gdmVyYiBnaXZlblwiLCB7IGhpbnQ6IFwicnVuOiBjbGkudHMgaGVscFwiLCBjaG9pY2VzOiBWRVJCUyB9KSxcbiAgICApO1xuICAgIHJldHVybiAyO1xuICB9XG4gIC8vIFRIRSBWRVJCIElTIFJFSkVDVEVEIEJFRk9SRSBJVFMgRkxBR1MgQVJFIFJFQUQuIEl0IGhhcyB0byBiZTogd2hpY2ggZmxhZ3NcbiAgLy8gYXJlIGxlZ2FsIGlzIGEgcXVlc3Rpb24gYWJvdXQgdGhlIHZlcmIsIHNvIHRoZXJlIGlzIG5vIHNldCB0byBjaGVjayBhZ2FpbnN0XG4gIC8vIHVudGlsIHdlIGtub3cgaXQgaXMgYSByZWFsIG9uZS5cbiAgaWYgKCFpc1ZlcmIodmVyYikpIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgIGVycm9yRW52ZWxvcGUoXCJ1c2FnZVwiLCBgdW5rbm93biB2ZXJiIFwiJHt2ZXJifVwiYCwge1xuICAgICAgICBoaW50OiBcInJ1bjogY2xpLnRzIGhlbHBcIixcbiAgICAgICAgY2hvaWNlczogVkVSQlMsXG4gICAgICB9KSxcbiAgICApO1xuICAgIHJldHVybiAyO1xuICB9XG5cbiAgbGV0IHBvczogc3RyaW5nW107XG4gIGxldCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj47XG4gIHRyeSB7XG4gICAgKHsgcG9zLCBmbGFncyB9ID0gcGFyc2VBcmdzKHJlc3QsIHZlcmIpKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGlmICghKGUgaW5zdGFuY2VvZiBVc2FnZUVycm9yKSkgdGhyb3cgZTtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgIGVycm9yRW52ZWxvcGUoXCJ1c2FnZVwiLCBlLm1lc3NhZ2UsIHtcbiAgICAgICAgaGludDogYGZsYWdzIGFyZSBzY29wZWQgdG8gdGhlIHZlcmIg4oCUIGNob2ljZXMgbGlzdHMgd2hhdCBcXGAke3ZlcmJ9XFxgIGFjY2VwdHM7IGZvciBmcmVlIHRleHQgY29udGFpbmluZyBkYXNoZXMgdXNlIC0tc3RkaW4sIG9yIHB1dCBpdCBhZnRlciBhIGJhcmUgLS1gLFxuICAgICAgICBjaG9pY2VzOiBmbGFnc0Zvcih2ZXJiKSxcbiAgICAgIH0pLFxuICAgICk7XG4gICAgcmV0dXJuIDI7XG4gIH1cbiAgY29uc3Qgc2Vzc2lvbiA9IHR5cGVvZiBmbGFncy5zZXNzaW9uID09PSBcInN0cmluZ1wiID8gZmxhZ3Muc2Vzc2lvbiA6IHVuZGVmaW5lZDtcblxuICBzd2l0Y2ggKHZlcmIpIHtcbiAgICBjYXNlIFwib3BlblwiOlxuICAgICAgYXdhaXQgY21kT3BlbihmbGFncyk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwidGFpbFwiOlxuICAgICAgLy8gVGhlIHRhaWwgUkVUVVJOUyBpdHMgZXhpdCBjb2RlICgwIG9uIGBjbG9zZWRgLCBvbiBhIHNpZ25hbCwgb3Igd2hlbiB0aGVcbiAgICAgIC8vIHBpbm5lZCBzZXNzaW9uIGdvZXMgYXdheSkgaW5zdGVhZCBvZiBleGl0aW5nIGZyb20gaW5zaWRlIGl0cyBvd24gbG9vcC5cbiAgICAgIHJldHVybiBhd2FpdCBjbWRUYWlsKFxuICAgICAgICBzZXNzaW9uLFxuICAgICAgICB0eXBlb2YgZmxhZ3Muc2luY2UgPT09IFwic3RyaW5nXCIgPyBwYXJzZUludChmbGFncy5zaW5jZSwgMTApIDogLTEsXG4gICAgICApO1xuICAgIGNhc2UgXCJzdGF0ZVwiOlxuICAgICAgYXdhaXQgY21kU3RhdGUoc2Vzc2lvbiwgZmxhZ3MuZnVsbCA9PT0gdHJ1ZSk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwic2F5XCI6IHtcbiAgICAgIGNvbnN0IHRleHQgPSBmbGFncy5zdGRpbiA9PT0gdHJ1ZSA/IGF3YWl0IHJlYWRTdGRpbigpIDogcG9zLmpvaW4oXCIgXCIpO1xuICAgICAgaWYgKCF0ZXh0KSBkaWUoXCJ1c2FnZTogc2F5IDx0ZXh0Li4uPiB8IHNheSAtLXN0ZGluXCIpO1xuICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwic2F5XCIsIHRleHQgfSk7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgY2FzZSBcImFza1wiOiB7XG4gICAgICBpZiAoIXBvcy5sZW5ndGgpIGRpZSgndXNhZ2U6IGFzayA8dGV4dC4uLj4gWy0tb3B0aW9ucyBcImF8YnxjXCJdJyk7XG4gICAgICBjb25zdCBtc2c6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0geyB0eXBlOiBcImFza1wiLCB0ZXh0OiBwb3Muam9pbihcIiBcIikgfTtcbiAgICAgIGlmICh0eXBlb2YgZmxhZ3Mub3B0aW9ucyA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICBtc2cub3B0aW9ucyA9IGZsYWdzLm9wdGlvbnNcbiAgICAgICAgICAuc3BsaXQoXCJ8XCIpXG4gICAgICAgICAgLm1hcCgocykgPT4gcy50cmltKCkpXG4gICAgICAgICAgLmZpbHRlcihCb29sZWFuKTtcbiAgICAgIH1cbiAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgbXNnKTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBjYXNlIFwic3RhdHVzXCI6XG4gICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICAgICAgdHlwZTogXCJzdGF0dXNcIixcbiAgICAgICAgYnVzeTogcG9zWzBdID09PSBcIm9uXCIsXG4gICAgICAgIHRleHQ6IHBvcy5zbGljZSgxKS5qb2luKFwiIFwiKSxcbiAgICAgIH0pO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcInNvdXJjZVwiOlxuICAgICAgaWYgKCFwb3MubGVuZ3RoKSBkaWUoXCJ1c2FnZTogc291cmNlIDxpbWFnZVBhdGg+XCIpO1xuICAgICAgYXdhaXQgY21kU291cmNlKHNlc3Npb24sIHBvc1swXSk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiZGlzY292ZXJcIjpcbiAgICAgIGF3YWl0IGNtZERpc2NvdmVyKHNlc3Npb24pO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcImV4dHJhY3RcIjpcbiAgICAgIGF3YWl0IGNtZEV4dHJhY3Qoc2Vzc2lvbiwgZmxhZ3MpO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcImV4cG9ydFwiOlxuICAgICAgYXdhaXQgY21kRXhwb3J0KHNlc3Npb24sIGZsYWdzKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJlbGVtZW50LWFkZFwiOlxuICAgICAgYXdhaXQgY21kRWxlbWVudEFkZChzZXNzaW9uLCBmbGFncyk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiZWxlbWVudC1yZW1vdmVcIjpcbiAgICAgIGlmICghcG9zLmxlbmd0aCkgZGllKFwidXNhZ2U6IGVsZW1lbnQtcmVtb3ZlIDxpZD5cIik7XG4gICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJlbGVtZW50LnJlbW92ZVwiLCBpZDogcG9zWzBdIH0pO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcImNtZFwiOiB7XG4gICAgICAvLyBQT1NUIGEgcmF3IEFnZW50Q29tbWFuZCBKU09OIGJvZHkgKGZyb20gc3RkaW4pIOKAlCB0aGUgZXNjYXBlIGhhdGNoIGZvclxuICAgICAgLy8gY29tbWFuZHMgY2FycnlpbmcgTkwgdGV4dCBvciByaWNoIHBheWxvYWRzIChlLmcuIGVsZW1lbnRzLnNldCkuXG4gICAgICBjb25zdCByYXcgPSBmbGFncy5zdGRpbiA9PT0gdHJ1ZSA/IGF3YWl0IHJlYWRTdGRpbigpIDogcG9zLmpvaW4oXCIgXCIpO1xuICAgICAgaWYgKCFyYXcpIGRpZShcInVzYWdlOiBjbWQgLS1zdGRpbiAgKHBpcGUgYSBKU09OIEFnZW50Q29tbWFuZCBib2R5KVwiKTtcbiAgICAgIGxldCBib2R5OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICAgIHRyeSB7XG4gICAgICAgIGJvZHkgPSBKU09OLnBhcnNlKHJhdyk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgZGllKFwiY21kOiBib2R5IGlzIG5vdCB2YWxpZCBKU09OXCIpO1xuICAgICAgfVxuICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCBib2R5KTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBjYXNlIFwiY2xvc2VcIjpcbiAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcImNsb3NlXCIgfSk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiaW5mb1wiOlxuICAgICAgY21kSW5mbyhzZXNzaW9uKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJzZXNzaW9uc1wiOlxuICAgICAgY21kU2Vzc2lvbnMoKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJoZWxwXCI6XG4gICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtIRUxQfVxcbmApO1xuICAgICAgYnJlYWs7XG4gICAgZGVmYXVsdDpcbiAgICAgIC8vIFVOUkVBQ0hBQkxFIEJZIENPTlNUUlVDVElPTiDigJQgYHZlcmJgIGlzIG5hcnJvd2VkIHRvIFZlcmIgYWJvdmUsIGFuZCBhXG4gICAgICAvLyB0ZXN0IGJpbmRzIFZFUkJfU1BFQydzIGtleXMgdG8gdGhpcyBzd2l0Y2gncyBjYXNlIGxhYmVscy4gS2VwdCBhbnl3YXk6XG4gICAgICAvLyBpZiB0aGF0IGJpbmRpbmcgZXZlciBicmVha3MsIHRoZSBhbHRlcm5hdGl2ZSBpcyBmYWxsaW5nIHRocm91Z2ggdG9cbiAgICAgIC8vIGByZXR1cm4gMGAgd2l0aCBlbXB0eSBzdGRvdXQsIHdoaWNoIHJlcG9ydHMgc3VjY2VzcyBmb3Igd29yayBuZXZlciBkb25lLlxuICAgICAgLy8gVGhhdCBpcyB0aGUgZmFpbHVyZSB0aGlzIGJyYW5jaCBleGlzdHMgdG8gcmVtb3ZlLCBhbmQgaXQgd291bGQgYmUgc2lsZW50LlxuICAgICAgZGllKGBubyBoYW5kbGVyIGZvciB2ZXJiIFwiJHt2ZXJifVwiYCwgXCJpbnRlcm5hbFwiKTtcbiAgfVxuXG4gIHJldHVybiAwO1xufVxuXG5pZiAoaW1wb3J0Lm1ldGEubWFpbikge1xuICAvLyBgcHJvY2Vzcy5leGl0Q29kZWAgKyBhIG5hdHVyYWwgcmV0dXJuLCBORVZFUiBgcHJvY2Vzcy5leGl0KGNvZGUpYDogQnVuJ3NcbiAgLy8gc3Rkb3V0IGlzIEFTWU5DSFJPTk9VUyBvbiBhIHBpcGUgKHN5bmNocm9ub3VzIG9uIGEgVFRZIG9yIGZpbGUpLCBzbyBhblxuICAvLyBleHBsaWNpdCBleGl0IGRpc2NhcmRzIHdoYXRldmVyIGhhcyBub3QgZHJhaW5lZCDigJQgbWVhc3VyZWQgYXQgZXhhY3RseVxuICAvLyA2NSw1MzYgYnl0ZXMuIFRoZSBwYXlsb2FkIGlzIGNvbXBsZXRlIGFuZCBvbmx5IHRoZSB3cml0ZSBpcyBsb3N0LCBzbyB0aGVcbiAgLy8gY2FsbGVyIGdldHMgd2VsbC1mb3JtZWQtbG9va2luZyBKU09OIHRoYXQgc3RvcHMgbWlkLXN0cmluZy4gUmVwcm9kdWNlZCxcbiAgLy8gZml4ZWQgYW5kIGdhdGVkIGluIGJvdW50eSBmaXJzdCAoUDAsICM3Ny8jNzgpOyBzYW1lIHNoYXBlLCBzYW1lIHJlYXNvbi5cbiAgLy8gRG8gbm90IHRpZHkgdGhpcyBiYWNrIGludG8gYW4gZXhwbGljaXQgZXhpdC5cbiAgcHJvY2Vzcy5leGl0Q29kZSA9IGF3YWl0IG1haW4ocHJvY2Vzcy5hcmd2LnNsaWNlKDIpKTtcbn1cblxuZXhwb3J0IHsgbWFpbiB9O1xuXG4vKipcbiAqIFRoZSBTSElQUEVEIEVOVFJZIFBPSU5ULCBjYWxsZWQgYnkgYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9tYWdwaWUvc2NyaXB0cy9jbGkudHNgXG4gKiBhZnRlciB0aGUgYnVuZGxlIGlzIGltcG9ydGVkLlxuICpcbiAqIOKblCBJVCBUQUtFUyBOTyBBUkdVTUVOVFMsIEFORCBUSEFUIElTIFRIRSBQT0lOVC4gYXJndiBiZWxvbmdzIHRvIHdoaWNoZXZlciBmaWxlXG4gKiBQQVJTRVMgaXQsIGFuZCB0aGF0IGlzIHRoaXMgb25lLiBBbiBlYXJsaWVyIGxhdW5jaGVyIHJlYWRcbiAqIGBwcm9jZXNzLmFyZ3Yuc2xpY2UoMilgIGl0c2VsZiBhbmQgcGFzc2VkIGl0IGluIOKAlCB3aGljaCBtYWRlIHRoZSBsYXVuY2hlciBtYXRjaFxuICogYGdyaW1vaXJlL2xpYi9lbnRyeS1wb2ludHMudHNgJ3MgUEFSU0VTX0FSR1MgcHJlZGljYXRlIChgcHJvY2Vzcy5hcmd2YCksIHNvIHRoZVxuICogcm9zdGVyIGNvdW50ZWQgYSAzLWxpbmUgZm9yd2FyZGVyIGFzIGFuIGFyZy1wYXJzaW5nIGVudHJ5IHBvaW50IGFuZCB0aGVuXG4gKiByZXBvcnRlZCB0aGUgc3BlbGwncyBkb2N1bWVudGVkIGZsYWdzIGFzIFVOUkVTT0xWRUQgYWdhaW5zdCBhIGZpbGUgdGhhdFxuICogcmVjb2duaXNlcyBub25lLiBLZWVwaW5nIGFyZ3Ygb24gdGhpcyBzaWRlIG1ha2VzIHRoZSBlbnVtZXJhdG9yJ3MgYW5zd2VyIHRydWVcbiAqIGluc3RlYWQgb2YgbWFraW5nIGl0cyByZWdleCBsb29zZXIuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW4oKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgcmV0dXJuIGF3YWl0IG1haW4ocHJvY2Vzcy5hcmd2LnNsaWNlKDIpKTtcbn1cbiIsCiAgICAiLy8gc2NyaXB0cy9iYWNrZW5kLnRzXG4vLyBSZW1vdmFsLWJhY2tlbmQgcmVnaXN0cnkuIFRoZSByZWJ1aWx0IG1hZ3BpZSBjb21wYXJlcyBiYWNrZ3JvdW5kLXJlbW92YWxcbi8vIHJlc3VsdHMgZnJvbSBtdWx0aXBsZSBiYWNrZW5kcyBwZXIgZWxlbWVudDsgdGhlIHVzZXIgcGlja3MgdGhlIHdpbm5lci4gVGhpc1xuLy8gZmlsZSBkZWZpbmVzIHRoZSBjb250cmFjdCwgdGhlIChsaXZlKSByZW1iZyBpbXBsLCBhIG1lZGlhLWZvcmdlIHN0dWIgZm9yIHRoZVxuLy8gbmV4dCBzdWItcGhhc2UsIGFuZCBhIHJlZ2lzdHJ5LlxuLy9cbi8vIElNQUdFIE9QUyBOT1RFOiBjcm9wcGluZyB0aGUgZWxlbWVudCdzIGJib3ggb3V0IG9mIHRoZSBzb3VyY2UgaXMgTk9UIGRvbmUgd2l0aFxuLy8gQnVuLkltYWdlIChpdCBoYXMgcmVzaXplL2VuY29kZS9tZXRhZGF0YSBidXQgTk8gY3JvcC9leHRyYWN0KS4gcmVtYmdCYWNrZW5kXG4vLyBzaGVsbHMgb3V0IHRvIHNjcmlwdHMvcmVtb3ZlLnB5IChQaWxsb3cgY3JvcCArIHJlbWJnKSDigJQgdGhlIGNhbGxlciBvd25zIHRoZVxuLy8gb3V0cHV0IHBhdGggKHRoZSBzZXNzaW9uIGZpbGVzIGRpcikuXG5cbmltcG9ydCB7IGpvaW4gfSBmcm9tIFwibm9kZTpwYXRoXCI7XG4vLyDilIDilIAgYWxwaGEgcG9saWN5IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy8gVGhlIHR5cGUtZHJpdmVuIGFscGhhIHBvbGljeSBsaXZlcyBpbiBzaGFyZWQvYWxwaGEudHMgKGJyb3dzZXItc2FmZSwgc29cbi8vIHRoZSBzdXJmYWNlIHNoYXJlcyBvbmUgc291cmNlIG9mIHRydXRoIOKAlCBSZW1vdmVHYWxsZXJ5LnRzeCByZWFkcyBpdCB0b28sXG4vLyB3aGljaCBpcyB3aGF0IG1ha2VzIGl0IHR3by1zaWRlZCByYXRoZXIgdGhhbiBkYWVtb24tb25seSkuIFJlLWV4cG9ydGVkIGhlcmVcbi8vIGZvciB0aGUgYWdlbnQtc2lkZSBjb25zdW1lcnMgKGNsaS50cywgYmFja2VuZCB0ZXN0cykgdGhhdCBpbXBvcnQgaXQgZnJvbVxuLy8gdGhpcyBtb2R1bGUuXG5pbXBvcnQgdHlwZSB7IEFscGhhUG9saWN5IH0gZnJvbSBcIi4uL3NoYXJlZC9hbHBoYVwiO1xuaW1wb3J0IHR5cGUgeyBCYm94IH0gZnJvbSBcIi4uL3NoYXJlZC90eXBlc1wiO1xuXG5leHBvcnQge1xuICBBTFBIQV9BVVRPX1RZUEVTLFxuICBBTFBIQV9GT1JCSURERU5fVFlQRVMsXG4gIHR5cGUgQWxwaGFQb2xpY3ksXG4gIHNob3VsZFJlbW92ZSxcbn0gZnJvbSBcIi4uL3NoYXJlZC9hbHBoYVwiO1xuXG4vLyBBIHJlZ2lvbiBvZiB0aGUgc291cmNlIHRvIGN1dCBhIHRyYW5zcGFyZW50IGFzc2V0IGZyb20uXG5leHBvcnQgdHlwZSBDcm9wID0ge1xuICAvLyBvbi1kaXNrIHBhdGggdG8gdGhlIHNvdXJjZSBjb21wb3NpdGUgKG9yIGEgcHJlLWNyb3BwZWQgcmVnaW9uIOKAlCBzZWUgY3JvcCBub3RlKVxuICBzb3VyY2VQYXRoOiBzdHJpbmc7XG4gIC8vIHRoZSBlbGVtZW50J3MgcGl4ZWwgYmJveCBbeDEsIHkxLCB4MiwgeTJdIHdpdGhpbiB0aGUgc291cmNlXG4gIGJib3g6IEJib3g7XG4gIC8vIGVsZW1lbnQgdHlwZSBkcml2ZXMgd2hldGhlciByZW1vdmFsIGV2ZW4gbWFrZXMgc2Vuc2UgKHBhbGV0dGVzL3NjcmVlbnNob3RzXG4gIC8vIGdldCBkZXN0cm95ZWQgYnkgcmVtYmcg4oCUIHNlZSBtYWdwaWUncyBBbHBoYSBQb2xpY3kpXG4gIHR5cGU6IHN0cmluZztcbn07XG5cbi8vIFRoZSByZXN1bHQgb2YgYSByZW1vdmFsIHBhc3Mg4oCUIGEgY3V0b3V0IFBORyAod2l0aCBhbHBoYSkgdGhlIHN1cmZhY2UgZGlzcGxheXMuXG5leHBvcnQgdHlwZSBDdXRvdXQgPSB7XG4gIGlkOiBzdHJpbmc7XG4gIGJhY2tlbmQ6IHN0cmluZzsgLy8gd2hpY2ggUmVtb3ZhbEJhY2tlbmQgcHJvZHVjZWQgaXRcbiAgcGF0aDogc3RyaW5nOyAvLyBvbi1kaXNrIFBORyB0aGUgYWdlbnQgcmVhZHMgLyB0aGUgc3VyZmFjZSBzZXJ2ZXNcbiAgLy8gVE9ETyhtb2NrKTogd2lkdGgvaGVpZ2h0LCBhIHByZXZpZXcgc3JjLCB0aW1pbmcvY29zdCwgYSBxdWFsaXR5IHNpZ25hbFxufTtcblxuLy8gT3B0aW9uYWwga25vYnMgdGhyZWFkZWQgdGhyb3VnaCB0byByZW1vdmUucHkgKHRoZSBleHRyYWN0IGxvb3AgaG9ub3JzIC0tYWxwaGFcbi8vIC8gLS1wYWQgLyAtLW1vZGVsIGZyb20gdGhlIENMSSB2ZXJiKS4gQWxsIGhhdmUgc2Vuc2libGUgZGVmYXVsdHMgaW5zaWRlXG4vLyByZW1vdmUucHkuIGBtb2RlbGAgbmFtZXMgYSBzcGVjaWZpYyByZW1iZyBtb2RlbCBmb3IgdGhlIG1vZGVsLWFnbm9zdGljIHJldHJ5XG4vLyAob21pdCDihpIgcmVtYmcncyBkZWZhdWx0IHUybmV0KS5cbmV4cG9ydCB0eXBlIEN1dE9wdGlvbnMgPSB7IGFscGhhPzogQWxwaGFQb2xpY3k7IHBhZD86IG51bWJlcjsgbW9kZWw/OiBzdHJpbmcgfTtcblxuZXhwb3J0IGludGVyZmFjZSBSZW1vdmFsQmFja2VuZCB7XG4gIG5hbWU6IHN0cmluZztcbiAgLy8gQ3V0IHRoZSBiYm94IHJlZ2lvbiBvdXQgb2YgdGhlIHNvdXJjZSBpbnRvIGBvdXRQYXRoYCBhbmQgcmV0dXJuIHRoZSBjdXRvdXQuXG4gIC8vIFRoZSBjYWxsZXIgb3ducyBgb3V0UGF0aGAgKHRoZSBzZXNzaW9uIGZpbGVzIGRpcikuIGBvcHRzYCBjYXJyaWVzIHRoZVxuICAvLyBhbHBoYS1wb2xpY3kgLyBwYWRkaW5nIHRoZSBDTEkgZXh0cmFjdCB2ZXJiIHBhc3NlcyB0aHJvdWdoLlxuICBjdXQoY3JvcDogQ3JvcCwgb3V0UGF0aDogc3RyaW5nLCBvcHRzPzogQ3V0T3B0aW9ucyk6IFByb21pc2U8Q3V0b3V0Pjtcbn1cblxuLy8gUmVzb2x2ZSBzY3JpcHRzL3JlbW92ZS5weSByZWxhdGl2ZSB0byB0aGlzIG1vZHVsZSAobm90IGN3ZCkuXG5jb25zdCBSRU1PVkVfUFkgPSBqb2luKGltcG9ydC5tZXRhLmRpciwgXCJyZW1vdmUucHlcIik7XG5cbmZ1bmN0aW9uIHNob3J0SWQocHJlZml4OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBidWYgPSBuZXcgVWludDhBcnJheSg0KTtcbiAgY3J5cHRvLmdldFJhbmRvbVZhbHVlcyhidWYpO1xuICBjb25zdCBoZXggPSBBcnJheS5mcm9tKGJ1ZiwgKGIpID0+IGIudG9TdHJpbmcoMTYpLnBhZFN0YXJ0KDIsIFwiMFwiKSkuam9pbihcIlwiKTtcbiAgcmV0dXJuIGAke3ByZWZpeH0tJHtoZXh9YDtcbn1cblxuLy8gcmVtYmcgYmFja2VuZCDigJQgc2hlbGxzIG91dCB0byBzY3JpcHRzL3JlbW92ZS5weSAoUGlsbG93IGNyb3AgKyByZW1iZykuIFRoZVxuLy8gY2FsbGVyIHBhc3NlcyB0aGUgb3V0cHV0IGxvY2F0aW9uOyB3ZSBwYXJzZSByZW1vdmUucHkncyBvbmUgSlNPTiBsaW5lIGFuZFxuLy8gcmV0dXJuIHRoZSBjdXRvdXQuXG5leHBvcnQgY29uc3QgcmVtYmdCYWNrZW5kOiBSZW1vdmFsQmFja2VuZCA9IHtcbiAgbmFtZTogXCJyZW1iZ1wiLFxuICBhc3luYyBjdXQoY3JvcDogQ3JvcCwgb3V0UGF0aDogc3RyaW5nLCBvcHRzOiBDdXRPcHRpb25zID0ge30pOiBQcm9taXNlPEN1dG91dD4ge1xuICAgIGNvbnN0IFt4MSwgeTEsIHgyLCB5Ml0gPSBjcm9wLmJib3g7XG4gICAgY29uc3QgYXJncyA9IFtcbiAgICAgIFwicHl0aG9uM1wiLFxuICAgICAgUkVNT1ZFX1BZLFxuICAgICAgXCItLXNvdXJjZVwiLFxuICAgICAgY3JvcC5zb3VyY2VQYXRoLFxuICAgICAgXCItLWJib3hcIixcbiAgICAgIGAke3gxfSwke3kxfSwke3gyfSwke3kyfWAsXG4gICAgICBcIi0tdHlwZVwiLFxuICAgICAgY3JvcC50eXBlLFxuICAgICAgXCItLW91dFwiLFxuICAgICAgb3V0UGF0aCxcbiAgICBdO1xuICAgIGlmIChvcHRzLmFscGhhKSBhcmdzLnB1c2goXCItLWFscGhhXCIsIG9wdHMuYWxwaGEpO1xuICAgIGlmICh0eXBlb2Ygb3B0cy5wYWQgPT09IFwibnVtYmVyXCIpIGFyZ3MucHVzaChcIi0tcGFkXCIsIFN0cmluZyhvcHRzLnBhZCkpO1xuICAgIGlmIChvcHRzLm1vZGVsKSBhcmdzLnB1c2goXCItLW1vZGVsXCIsIG9wdHMubW9kZWwpO1xuXG4gICAgY29uc3QgcHJvYyA9IEJ1bi5zcGF3bihhcmdzLCB7IHN0ZG91dDogXCJwaXBlXCIsIHN0ZGVycjogXCJwaXBlXCIgfSk7XG4gICAgY29uc3QgW3N0ZG91dCwgc3RkZXJyLCBleGl0Q29kZV0gPSBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgICBuZXcgUmVzcG9uc2UocHJvYy5zdGRvdXQpLnRleHQoKSxcbiAgICAgIG5ldyBSZXNwb25zZShwcm9jLnN0ZGVycikudGV4dCgpLFxuICAgICAgcHJvYy5leGl0ZWQsXG4gICAgXSk7XG4gICAgaWYgKGV4aXRDb2RlICE9PSAwKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGByZW1iZyByZW1vdmUucHkgZmFpbGVkIChleGl0ICR7ZXhpdENvZGV9KTogJHtzdGRlcnIudHJpbSgpIHx8IHN0ZG91dC50cmltKCl9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IGxpbmUgPSBzdGRvdXQudHJpbSgpLnNwbGl0KFwiXFxuXCIpLmZpbHRlcihCb29sZWFuKS5wb3AoKSA/PyBcIlwiO1xuICAgIGxldCBwYXJzZWQ6IHsgb3V0Pzogc3RyaW5nOyByZW1vdmVkPzogYm9vbGVhbiB9O1xuICAgIHRyeSB7XG4gICAgICBwYXJzZWQgPSBKU09OLnBhcnNlKGxpbmUpIGFzIHsgb3V0Pzogc3RyaW5nOyByZW1vdmVkPzogYm9vbGVhbiB9O1xuICAgIH0gY2F0Y2gge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGByZW1iZyByZW1vdmUucHkgcHJvZHVjZWQgbm8gcGFyc2VhYmxlIEpTT04gbGluZTogJHtzdGRvdXQudHJpbSgpfWApO1xuICAgIH1cbiAgICByZXR1cm4geyBpZDogc2hvcnRJZChcImN1dFwiKSwgYmFja2VuZDogXCJyZW1iZ1wiLCBwYXRoOiBwYXJzZWQub3V0ID8/IG91dFBhdGggfTtcbiAgfSxcbn07XG5cbi8vIG1lZGlhLWZvcmdlIGJhY2tlbmQg4oCUIGNsb3VkIGJhY2tncm91bmQgcmVtb3ZhbCB2aWEgdGhlIG1lZGlhLWZvcmdlIENMSSAodGhlXG4vLyBzYW1lIG91dC1vZi1iYW5kIHRvb2wgaW1hZ28gdXNlcykuIGBtZWRpYS1mb3JnZSBnZW5lcmF0ZSBiZy1yZW1vdmVgIGlzIGFcbi8vIHNpbmdsZS1pbWFnZSB0cmFuc2Zvcm0gKHByb21wdC1sZXNzKTogaXQgdGFrZXMgT05FIGltYWdlIGFuZCByZXR1cm5zIGFcbi8vIHRyYW5zcGFyZW50IFBORy4gU28gYGNyb3Auc291cmNlUGF0aGAgaGVyZSBpcyB0aGUgZWxlbWVudCdzIEFMUkVBRFktQ1JPUFBFRFxuLy8gaW1hZ2UgKHRoZSBzdXJmYWNlJ3MgY3JvcCB2ZXJzaW9uKSwgTk9UIHRoZSBmdWxsIGJvYXJkIOKAlCB0aGUgY2FsbGVyIHBhc3NlcyBpdC5cbi8vIGBvcHRzLm1vZGVsYCBpcyB0aGUgbWVkaWEtZm9yZ2UgbW9kZWwgaWQgKGUuZy4gZmFsLWFpL2JyaWEvYmFja2dyb3VuZC9yZW1vdmUpLlxuLy8gV2UgcGFyc2UgdGhlIGpvYidzIHByZXNpZ25lZCBvdXRwdXQgVVJMIGFuZCBzdHJlYW0gaXQgdG8gb3V0UGF0aC5cbmV4cG9ydCBjb25zdCBtZWRpYUZvcmdlQmFja2VuZDogUmVtb3ZhbEJhY2tlbmQgPSB7XG4gIG5hbWU6IFwibWVkaWEtZm9yZ2VcIixcbiAgYXN5bmMgY3V0KGNyb3A6IENyb3AsIG91dFBhdGg6IHN0cmluZywgb3B0czogQ3V0T3B0aW9ucyA9IHt9KTogUHJvbWlzZTxDdXRvdXQ+IHtcbiAgICBjb25zdCBtb2RlbCA9IG9wdHMubW9kZWw7XG4gICAgaWYgKCFtb2RlbCkgdGhyb3cgbmV3IEVycm9yKFwibWVkaWFGb3JnZUJhY2tlbmQuY3V0IHJlcXVpcmVzIG9wdHMubW9kZWwgKGEgYmctcmVtb3ZlIG1vZGVsIGlkKVwiKTtcbiAgICBjb25zdCBhcmdzID0gW1xuICAgICAgXCJtZWRpYS1mb3JnZVwiLFxuICAgICAgXCJnZW5lcmF0ZVwiLFxuICAgICAgXCJiZy1yZW1vdmVcIixcbiAgICAgIGAtLW1vZGVsPSR7bW9kZWx9YCxcbiAgICAgIGAtLXJlZj0ke2Nyb3Auc291cmNlUGF0aH1gLFxuICAgICAgXCItLWZvcm1hdFwiLFxuICAgICAgXCJqc29uXCIsXG4gICAgXTtcbiAgICBjb25zdCBwcm9jID0gQnVuLnNwYXduKGFyZ3MsIHsgc3Rkb3V0OiBcInBpcGVcIiwgc3RkZXJyOiBcInBpcGVcIiB9KTtcbiAgICBjb25zdCBbc3Rkb3V0LCBzdGRlcnIsIGV4aXRDb2RlXSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICAgIG5ldyBSZXNwb25zZShwcm9jLnN0ZG91dCkudGV4dCgpLFxuICAgICAgbmV3IFJlc3BvbnNlKHByb2Muc3RkZXJyKS50ZXh0KCksXG4gICAgICBwcm9jLmV4aXRlZCxcbiAgICBdKTtcbiAgICBpZiAoZXhpdENvZGUgIT09IDApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYG1lZGlhLWZvcmdlIGJnLXJlbW92ZSBmYWlsZWQgKGV4aXQgJHtleGl0Q29kZX0pOiAke3N0ZGVyci50cmltKCkgfHwgc3Rkb3V0LnRyaW0oKX1gLFxuICAgICAgKTtcbiAgICB9XG4gICAgbGV0IHBhcnNlZDogeyBvaz86IGJvb2xlYW47IGRhdGE/OiB7IG91dHB1dHM/OiBBcnJheTx7IHByZXNpZ25lZFVybD86IHN0cmluZyB9PiB9IH07XG4gICAgdHJ5IHtcbiAgICAgIHBhcnNlZCA9IEpTT04ucGFyc2Uoc3Rkb3V0LnRyaW0oKS5zcGxpdChcIlxcblwiKS5maWx0ZXIoQm9vbGVhbikucG9wKCkgPz8gXCJcIik7XG4gICAgfSBjYXRjaCB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYG1lZGlhLWZvcmdlIHByb2R1Y2VkIG5vIHBhcnNlYWJsZSBKU09OIGxpbmU6ICR7c3Rkb3V0LnRyaW0oKX1gKTtcbiAgICB9XG4gICAgY29uc3QgdXJsID0gcGFyc2VkPy5kYXRhPy5vdXRwdXRzPy5bMF0/LnByZXNpZ25lZFVybDtcbiAgICBpZiAoIXVybCkgdGhyb3cgbmV3IEVycm9yKGBtZWRpYS1mb3JnZSByZXR1cm5lZCBubyBvdXRwdXQgdXJsOiAke3N0ZG91dC50cmltKCl9YCk7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2godXJsKTtcbiAgICBpZiAoIXJlcy5vaykgdGhyb3cgbmV3IEVycm9yKGBtZWRpYS1mb3JnZSBvdXRwdXQgZG93bmxvYWQgZmFpbGVkIChIVFRQICR7cmVzLnN0YXR1c30pYCk7XG4gICAgYXdhaXQgQnVuLndyaXRlKG91dFBhdGgsIHJlcyk7XG4gICAgcmV0dXJuIHsgaWQ6IHNob3J0SWQoXCJjdXRcIiksIGJhY2tlbmQ6IFwibWVkaWEtZm9yZ2VcIiwgcGF0aDogb3V0UGF0aCB9O1xuICB9LFxufTtcblxuLy8gSXMgdGhpcyBhIG1lZGlhLWZvcmdlIG1vZGVsIGlkIChhIHByb3ZpZGVyIHBhdGggbGlrZSBcImZhbC1haS9icmlhL2JhY2tncm91bmQvXG4vLyByZW1vdmVcIikgdnMgYSBiYXJlIHJlbWJnIG1vZGVsIG5hbWUgKGUuZy4gXCJpc25ldC1nZW5lcmFsLXVzZVwiKT8gV2Ugcm91dGUgYnlcbi8vIFNIQVBFLCBuZXZlciBhIGhhcmRjb2RlZCBtb2RlbCBsaXN0IOKAlCBtZWRpYS1mb3JnZSdzIGNhdGFsb2cgZHJpZnRzLCBzbyB0aGUgYWdlbnRcbi8vIERJU0NPVkVSUyBiZy1yZW1vdmUgbW9kZWwgaWRzIHZpYSBgbWVkaWEtZm9yZ2UgbW9kZWxzIGxpc3RgIChvcGVyYXRpb25zXG4vLyBbXCJiZy1yZW1vdmVcIl0pIGFuZCBwYXNzZXMgdGhlIGlkIHRocm91Z2guIFRoZSBtYWdwaWUgQ0xJIGFic3RyYWN0cyB0aGVcbi8vIG9yY2hlc3RyYXRpb24sIG5vdCB0aGUgbW9kZWwgaWRlbnRpdHkuXG5leHBvcnQgZnVuY3Rpb24gaXNNZWRpYUZvcmdlTW9kZWwobW9kZWw6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gbW9kZWwuaW5jbHVkZXMoXCIvXCIpO1xufVxuXG4vLyBUaGUgcmVnaXN0cnkgdGhlIGRhZW1vbi9zdXJmYWNlIHBpY2tzIGJhY2tlbmRzIGZyb20uXG5leHBvcnQgY29uc3QgUkVNT1ZBTF9CQUNLRU5EUzogUmVjb3JkPHN0cmluZywgUmVtb3ZhbEJhY2tlbmQ+ID0ge1xuICBbcmVtYmdCYWNrZW5kLm5hbWVdOiByZW1iZ0JhY2tlbmQsXG4gIFttZWRpYUZvcmdlQmFja2VuZC5uYW1lXTogbWVkaWFGb3JnZUJhY2tlbmQsXG59O1xuXG5leHBvcnQgZnVuY3Rpb24gZ2V0QmFja2VuZChuYW1lOiBzdHJpbmcpOiBSZW1vdmFsQmFja2VuZCB8IHVuZGVmaW5lZCB7XG4gIHJldHVybiBSRU1PVkFMX0JBQ0tFTkRTW25hbWVdO1xufVxuIiwKICAgICIvLyBzaGFyZWQvYWxwaGEudHNcbi8vIFRoZSB0eXBlLWRyaXZlbiBhbHBoYSBwb2xpY3kg4oCUIHdoaWNoIEVMRU1FTlQgVFlQRVMgZ2V0IGJhY2tncm91bmQgcmVtb3ZhbC5cbi8vIEJyb3dzZXItc2FmZSAobm8gbm9kZToqLCBubyBCdW4pOiB0aGUgc3VyZmFjZSByZWFkcyBpdCB0byBzaG93IFwiUmVtb3ZlIGJnXCIgdnMgYVxuLy8gXCJrZXB0IHdob2xlXCIgbm90ZTsgc2NyaXB0cy9iYWNrZW5kLnRzICsgcmVtb3ZlLnB5IG1pcnJvciB0aGUgc2FtZSBydWxlLiBUaGlzIGlzXG4vLyBhYm91dCBlbGVtZW50IFRZUEVTICh3aGljaCBsaXZlIGluIHRoZSBVSSksIE5PVCBtb2RlbHMgKHdoaWNoIG5ldmVyIGRvKS5cbmltcG9ydCB0eXBlIHsgRWxlbWVudFR5cGUgfSBmcm9tIFwiLi90eXBlc1wiO1xuXG5leHBvcnQgdHlwZSBBbHBoYVBvbGljeSA9IFwiYXV0b1wiIHwgXCJhbGxcIiB8IFwibm9uZVwiO1xuXG4vLyByZW1iZyByZWxpYWJseSBwcm9kdWNlcyB1c2FibGUgYWxwaGEgZm9yIHRoZXNlICh1bmRlciBgYXV0b2ApLlxuZXhwb3J0IGNvbnN0IEFMUEhBX0FVVE9fVFlQRVM6IFJlYWRvbmx5U2V0PEVsZW1lbnRUeXBlPiA9IG5ldyBTZXQoW1xuICBcImlsbHVzdHJhdGlvblwiLFxuICBcInN0aWNrZXJcIixcbiAgXCJpY29uXCIsXG4gIFwid29yZG1hcmtcIixcbl0pO1xuXG4vLyByZW1iZyBkZXN0cm95cyB0aGVzZSAoZmxhdC1jb2xvciBjb250ZW50KSDigJQgbmV2ZXIgYWxwaGEgdGhlbSwgZXZlbiB1bmRlciBgYWxsYC5cbmV4cG9ydCBjb25zdCBBTFBIQV9GT1JCSURERU5fVFlQRVM6IFJlYWRvbmx5U2V0PEVsZW1lbnRUeXBlPiA9IG5ldyBTZXQoW1xuICBcInBhbGV0dGVcIixcbiAgXCJzY3JlZW5zaG90XCIsXG4gIFwidHlwb2dyYXBoeVwiLFxuXSk7XG5cbi8vIFNob3VsZCBhbiBlbGVtZW50IG9mIGB0eXBlYCBnZXQgYmFja2dyb3VuZCByZW1vdmFsIHVuZGVyIGBwb2xpY3lgPyBNaXJyb3JzXG4vLyByZW1vdmUucHkncyBzaG91bGRfcmVtb3ZlIGV4YWN0bHkuXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkUmVtb3ZlKHR5cGU6IHN0cmluZywgcG9saWN5OiBBbHBoYVBvbGljeSk6IGJvb2xlYW4ge1xuICBpZiAocG9saWN5ID09PSBcIm5vbmVcIikgcmV0dXJuIGZhbHNlO1xuICBpZiAocG9saWN5ID09PSBcImFsbFwiKSByZXR1cm4gIUFMUEhBX0ZPUkJJRERFTl9UWVBFUy5oYXModHlwZSBhcyBFbGVtZW50VHlwZSk7XG4gIHJldHVybiBBTFBIQV9BVVRPX1RZUEVTLmhhcyh0eXBlIGFzIEVsZW1lbnRUeXBlKTsgLy8gYXV0byAoZGVmYXVsdClcbn1cblxuLy8gU3VyZmFjZSBoZWxwZXI6IGlzIHRoaXMgZWxlbWVudCB0eXBlIGEgY2FuZGlkYXRlIGZvciByZW1vdmFsIHVuZGVyIHRoZSBkZWZhdWx0XG4vLyBgYXV0b2AgcG9saWN5PyBEcml2ZXMgdGhlIFwiUmVtb3ZlIGJnXCIgYWN0aW9uIHZzIHRoZSBcImtlcHQgd2hvbGVcIiBleHBsYWluZXIuXG5leHBvcnQgZnVuY3Rpb24gaXNBbHBoYUVsaWdpYmxlKHR5cGU6IEVsZW1lbnRUeXBlKTogYm9vbGVhbiB7XG4gIHJldHVybiBBTFBIQV9BVVRPX1RZUEVTLmhhcyh0eXBlKTtcbn1cblxuLy8gSXMgdGhpcyB0eXBlIGV4cGxpY2l0bHkga2VwdCB3aG9sZSAoZmxhdCBjb2xvciByZW1iZyB3b3VsZCBkZXN0cm95KT9cbmV4cG9ydCBmdW5jdGlvbiBpc0tlcHRXaG9sZSh0eXBlOiBFbGVtZW50VHlwZSk6IGJvb2xlYW4ge1xuICByZXR1cm4gQUxQSEFfRk9SQklEREVOX1RZUEVTLmhhcyh0eXBlKTtcbn1cbiIsCiAgICAiIyEvdXNyL2Jpbi9lbnYgYnVuXG4vLyBtYWdwaWUg4oCUIGRpc2NvdmVyIHBoYXNlLiBUaGUgY2Fub25pY2FsIGVsZW1lbnQtZGlzY292ZXJ5IGltcGxlbWVudGF0aW9uLlxuLy9cbi8vIENhbGxzIEdlbWluaSAzLjUgRmxhc2ggdmlhIE9wZW5Sb3V0ZXIgb24gYSBtb29kYm9hcmQgLyBicmFuZGluZyBib2FyZCBpbWFnZSxcbi8vIGFza3MgdGhlIG1vZGVsIHRvIGlkZW50aWZ5IGV2ZXJ5IGRpc3RpbmN0IGV4dHJhY3RhYmxlIHZpc3VhbCBlbGVtZW50LCBhbmRcbi8vIHJldHVybnMgYSBtYW5pZmVzdCAobmFtZSArIHR5cGUgKyBzb3VyY2UtcGl4ZWwgYmJveCBwZXIgZWxlbWVudCwgKyBjb3N0L3Rva2VucykuXG4vLyBBIHBsYWluIGZ1bmN0aW9uIG1vZHVsZSB0aGUgZGFlbW9uL2NsaSBjYWxsOyBhIHNtYWxsIENMSSBlbnRyeSBsaXZlcyBhdCB0aGVcbi8vIGJvdHRvbS4gKFBvcnRlZCBmcm9tIGFuIGVhcmxpZXIgUHl0aG9uIG9yaWdpbmFsLCBzaW5jZSByZW1vdmVkLilcblxuaW1wb3J0IHsgZGlybmFtZSwgZXh0bmFtZSwgam9pbiwgcmVzb2x2ZSB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB0eXBlIHsgQmJveCwgRWxlbWVudFR5cGUgfSBmcm9tIFwiLi4vc2hhcmVkL3R5cGVzXCI7XG5cbmV4cG9ydCBjb25zdCBPUEVOUk9VVEVSX1VSTCA9IFwiaHR0cHM6Ly9vcGVucm91dGVyLmFpL2FwaS92MS9jaGF0L2NvbXBsZXRpb25zXCI7XG5leHBvcnQgY29uc3QgREVGQVVMVF9NT0RFTCA9IFwiZ29vZ2xlL2dlbWluaS0zLjUtZmxhc2hcIjtcblxuLy8gQ29waWVkIHZlcmJhdGltIGZyb20gdGhlIFB5dGhvbiBvcmlnaW5hbCdzIFBST01QVCAodGhlIGRpc2NvdmVyeSBpbnN0cnVjdGlvbikuXG5leHBvcnQgY29uc3QgUFJPTVBUID0gYElkZW50aWZ5IGV2ZXJ5IGRpc3RpbmN0IGV4dHJhY3RhYmxlIHZpc3VhbCBlbGVtZW50IGluIHRoaXMgaW1hZ2UuIFwiRGlzdGluY3QgZXh0cmFjdGFibGVcIiBtZWFuczogYSBzaW5nbGUgdmlzdWFsbHktY29oZXJlbnQgYXNzZXQgYSBkZXNpZ25lciB3b3VsZCB3YW50IHRvIHB1bGwgb3V0IGFzIGl0cyBvd24gZmlsZSDigJQgYSBsb2dvLCBhbiBpY29uLCBhIHN0aWNrZXIsIGEgY29sb3Igc3dhdGNoIHJvdywgYSBwaWVjZSBvZiBjb3ZlciBhcnQsIGEgVUkgc2NyZWVuc2hvdC4gRG8gTk9UIGluY2x1ZGUgYmFja2dyb3VuZCwgdGV4dHVyZSwgb3Igc3Vycm91bmRpbmcgY2FudmFzLlxuXG5Gb3IgZWFjaCBlbGVtZW50LCByZXR1cm4gYSBib3VuZGluZyBib3ggdXNpbmcgR29vZ2xlJ3Mgbm9ybWFsaXplZCBjb29yZGluYXRlIHN5c3RlbSAoaW1hZ2UgaXMgWzAsIDEwMDBdIG9uIGJvdGggYXhlcywgMCwwIHRvcC1sZWZ0KSBpbiB0aGUgZG9jdW1lbnRlZCBvcmRlcjogW3lfbWluLCB4X21pbiwgeV9tYXgsIHhfbWF4XS5cblxuUmV0dXJuIE9OTFkgYSBKU09OIGFycmF5LCBubyBwcm9zZSwgaW4gdGhpcyBleGFjdCBzaGFwZTpcbltcbiAge1wibmFtZVwiOiBcIjxzaG9ydF9zbmFrZV9jYXNlX25hbWU+XCIsIFwidHlwZVwiOiBcIjxvbmUgb2Y6IHdvcmRtYXJrLCB0YWdsaW5lLCBpY29uLCBpbGx1c3RyYXRpb24sIHN0aWNrZXIsIHBhbGV0dGUsIHR5cG9ncmFwaHksIHNjcmVlbnNob3QsIG90aGVyPlwiLCBcImJveF8yZFwiOiBbeV9taW4sIHhfbWluLCB5X21heCwgeF9tYXhdfVxuXVxuXG5OYW1pbmcgcnVsZXM6XG4tIFVzZSBkaXN0aW5jdGl2ZSBzbmFrZV9jYXNlIG5hbWVzOyBpZiB0aGVyZSBhcmUgbXVsdGlwbGUgb2YgdGhlIHNhbWUga2luZCwgZGlmZmVyZW50aWF0ZSBkZXNjcmlwdGl2ZWx5IChpY29uX21hbW1vdGgsIGljb25fZ2Vhciwgc3RpY2tlcl9jb2ZmZWUsIHN0aWNrZXJfc2thdGVib2FyZCkuXG4tIFRoZSBcXGB0eXBlXFxgIGZpZWxkIGlzIGNyaXRpY2FsIOKAlCB0aGUgZXh0cmFjdCBzdGVwIHVzZXMgaXQgdG8gZGVjaWRlIHdoZXRoZXIgdG8gcnVuIGJhY2tncm91bmQgcmVtb3ZhbC5cbmA7XG5cbi8vIE9wZW5Sb3V0ZXIgdmlzaW9uIGVuZHBvaW50cyByZWplY3QgdmVyeSBsYXJnZSBwYXlsb2FkcyB3aXRoIGEgbm9uLWFjdGlvbmFibGVcbi8vIDR4eDsgYmFpbCB3aXRoIGEgY2xlYXJlciBlcnJvciBmaXJzdCAobWF0Y2hlcyB0aGUgUHl0aG9uIG9yaWdpbmFsKS5cbmV4cG9ydCBjb25zdCBNQVhfSU1BR0VfQllURVMgPSAzMCAqIDEwMjQgKiAxMDI0O1xuZXhwb3J0IGNvbnN0IFdBUk5fSU1BR0VfQllURVMgPSAxNSAqIDEwMjQgKiAxMDI0O1xuXG5jb25zdCBNSU1FX0JZX0VYVDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgXCIuanBnXCI6IFwiaW1hZ2UvanBlZ1wiLFxuICBcIi5qcGVnXCI6IFwiaW1hZ2UvanBlZ1wiLFxuICBcIi5wbmdcIjogXCJpbWFnZS9wbmdcIixcbiAgXCIud2VicFwiOiBcImltYWdlL3dlYnBcIixcbiAgXCIuZ2lmXCI6IFwiaW1hZ2UvZ2lmXCIsXG59O1xuXG4vLyDilIDilIAgbWFuaWZlc3Qgc2NoZW1hIChtaXJyb3JzIHRoZSBQeXRob24gbWFuaWZlc3QpIOKUgOKUgFxuZXhwb3J0IHR5cGUgTWFuaWZlc3RFbGVtZW50ID0ge1xuICBuYW1lOiBzdHJpbmc7XG4gIHR5cGU6IEVsZW1lbnRUeXBlO1xuICBib3hfMmQ6IG51bWJlcltdOyAvLyBHZW1pbmkncyBub3JtYWxpemVkIFt5X21pbiwgeF9taW4sIHlfbWF4LCB4X21heF0sIDAuLjEwMDBcbiAgYmJveF9waXhlbDogQmJveDsgLy8gW3gxLCB5MSwgeDIsIHkyXSBpbiBzb3VyY2UgcGl4ZWxzICh1c2VkIGJ5IGV4dHJhY3QpXG59O1xuZXhwb3J0IHR5cGUgTWFuaWZlc3QgPSB7XG4gIHNvdXJjZTogc3RyaW5nO1xuICBzb3VyY2Vfc2l6ZTogW251bWJlciwgbnVtYmVyXTtcbiAgc291cmNlX3NoYTI1Nl8xNjogc3RyaW5nO1xuICBtb2RlbDogc3RyaW5nO1xuICBjb3N0X3VzZDogbnVtYmVyO1xuICB0b2tlbnM6IHsgcHJvbXB0OiBudW1iZXI7IGNvbXBsZXRpb246IG51bWJlcjsgcmVhc29uaW5nOiBudW1iZXIgfTtcbiAgZWxlbWVudHM6IE1hbmlmZXN0RWxlbWVudFtdO1xufTtcblxuLy8gUmFpc2VkIGZvciBhY3Rpb25hYmxlIHVzZXItZmFjaW5nIGZhaWx1cmVzIChiYWQgaW1hZ2Ugc2l6ZSwgbWlzc2luZyBrZXksIEhUVFBcbi8vIGVycm9yKS4gVGhlIENMSSBlbnRyeSBtYXBzIGl0IHRvIGEgY2xlYW4gc3RkZXJyIGxpbmUgKyBleGl0IGNvZGUuXG5leHBvcnQgY2xhc3MgRGlzY292ZXJFcnJvciBleHRlbmRzIEVycm9yIHt9XG5cbi8vIOKUgOKUgCBwdXJlIGhlbHBlcnMgKHVuaXQtdGVzdGVkOyBubyBuZXR3b3JrL2Rpc2spIOKUgOKUgFxuXG4vLyBTdHJpcCBvcHRpb25hbCBgYGBqc29uIGZlbmNlcyBhbmQgcGFyc2UgdGhlIEpTT04gYXJyYXkuIE1pcnJvcnNcbi8vIHRoZSBQeXRob24gb3JpZ2luYWwncyBwYXJzZV9iYm94ZXMuXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VCYm94ZXMoY29udGVudDogc3RyaW5nKTogdW5rbm93bltdIHtcbiAgbGV0IHMgPSBjb250ZW50LnRyaW0oKTtcbiAgY29uc3QgZmVuY2UgPSAvYGBgKD86anNvbik/XFxzKihbXFxzXFxTXSo/KVxccypgYGAvLmV4ZWMocyk7XG4gIGlmIChmZW5jZSkgcyA9IGZlbmNlWzFdO1xuICByZXR1cm4gSlNPTi5wYXJzZShzKTtcbn1cblxuLy8gQ29udmVydCBHZW1pbmkncyBbeV9taW4sIHhfbWluLCB5X21heCwgeF9tYXhdICgwLi4xMDAwKSB0byBzb3VyY2UgcGl4ZWxzXG4vLyBbeDEsIHkxLCB4MiwgeTJdLCBjbGFtcGVkIHRvIGltYWdlIGJvdW5kcy4gUmVwbGljYXRlcyB0aGUgUHl0aG9uIG9yaWdpbmFsJ3Ncbi8vIG5vcm1hbGl6ZWRfdG9fcGl4ZWwgZm9ybXVsYSBleGFjdGx5LlxuZXhwb3J0IGZ1bmN0aW9uIG5vcm1hbGl6ZWRUb1BpeGVsKGJveDogbnVtYmVyW10sIHdpZHRoOiBudW1iZXIsIGhlaWdodDogbnVtYmVyKTogQmJveCB7XG4gIGNvbnN0IFt5MSwgeDEsIHkyLCB4Ml0gPSBib3g7XG4gIGNvbnN0IHB4MSA9IE1hdGgubWF4KDAsIE1hdGgucm91bmQoKHgxIC8gMTAwMCkgKiB3aWR0aCkpO1xuICBjb25zdCBweTEgPSBNYXRoLm1heCgwLCBNYXRoLnJvdW5kKCh5MSAvIDEwMDApICogaGVpZ2h0KSk7XG4gIGNvbnN0IHB4MiA9IE1hdGgubWluKHdpZHRoLCBNYXRoLnJvdW5kKCh4MiAvIDEwMDApICogd2lkdGgpKTtcbiAgY29uc3QgcHkyID0gTWF0aC5taW4oaGVpZ2h0LCBNYXRoLnJvdW5kKCh5MiAvIDEwMDApICogaGVpZ2h0KSk7XG4gIHJldHVybiBbcHgxLCBweTEsIHB4MiwgcHkyXTtcbn1cblxuLy8gQnVpbGQgdGhlIG1hbmlmZXN0IGBlbGVtZW50c1tdYCBmcm9tIHRoZSBtb2RlbCdzIHBhcnNlZCBhcnJheSArIGltYWdlIHNpemUuXG4vLyBTa2lwcyBlbnRyaWVzIG1pc3NpbmcgYSBuYW1lIG9yIGJveCAobWF0Y2hlcyB0aGUgUHl0aG9uIG9yaWdpbmFsJ3MgZmlsdGVyKS5cbmV4cG9ydCBmdW5jdGlvbiBlbGVtZW50c0Zyb21SYXcocmF3OiB1bmtub3duW10sIHdpZHRoOiBudW1iZXIsIGhlaWdodDogbnVtYmVyKTogTWFuaWZlc3RFbGVtZW50W10ge1xuICBjb25zdCBlbGVtZW50czogTWFuaWZlc3RFbGVtZW50W10gPSBbXTtcbiAgZm9yIChjb25zdCBlbnRyeSBvZiByYXcpIHtcbiAgICBpZiAoIWVudHJ5IHx8IHR5cGVvZiBlbnRyeSAhPT0gXCJvYmplY3RcIikgY29udGludWU7XG4gICAgY29uc3QgZSA9IGVudHJ5IGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAgIGNvbnN0IG5hbWUgPSBlLm5hbWU7XG4gICAgY29uc3Qga2luZCA9ICh0eXBlb2YgZS50eXBlID09PSBcInN0cmluZ1wiID8gZS50eXBlIDogXCJvdGhlclwiKSBhcyBFbGVtZW50VHlwZTtcbiAgICBjb25zdCBib3ggPSBlLmJveF8yZDtcbiAgICBpZiAoIW5hbWUgfHwgdHlwZW9mIG5hbWUgIT09IFwic3RyaW5nXCIgfHwgIUFycmF5LmlzQXJyYXkoYm94KSkgY29udGludWU7XG4gICAgZWxlbWVudHMucHVzaCh7XG4gICAgICBuYW1lLFxuICAgICAgdHlwZToga2luZCxcbiAgICAgIGJveF8yZDogYm94IGFzIG51bWJlcltdLFxuICAgICAgYmJveF9waXhlbDogbm9ybWFsaXplZFRvUGl4ZWwoYm94IGFzIG51bWJlcltdLCB3aWR0aCwgaGVpZ2h0KSxcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gZWxlbWVudHM7XG59XG5cbi8vIOKUgOKUgCBpbWFnZSByZWFkICsgZW5jb2RlIOKUgOKUgFxuXG5leHBvcnQgZnVuY3Rpb24gbWltZUZvclBhdGgocGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIE1JTUVfQllfRVhUW2V4dG5hbWUocGF0aCkudG9Mb3dlckNhc2UoKV0gPz8gXCJpbWFnZS9wbmdcIjtcbn1cblxuLy8gUmVhZCBhbiBpbWFnZSBmaWxlIOKGkiBhIGJhc2U2NCBkYXRhIFVSTCwgZW5mb3JjaW5nIHRoZSBzaXplIGd1YXJkLiBUaHJvd3Ncbi8vIERpc2NvdmVyRXJyb3IgYWJvdmUgTUFYX0lNQUdFX0JZVEVTOyB3YXJucyAoc3RkZXJyKSBhYm92ZSBXQVJOX0lNQUdFX0JZVEVTLlxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGVuY29kZUltYWdlRGF0YVVybChwYXRoOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCBmaWxlID0gQnVuLmZpbGUocGF0aCk7XG4gIGNvbnN0IHNpemUgPSBmaWxlLnNpemU7XG4gIGlmIChzaXplID4gTUFYX0lNQUdFX0JZVEVTKSB7XG4gICAgY29uc3QgbWIgPSAoc2l6ZSAvIDFfMDQ4XzU3NikudG9GaXhlZCgxKTtcbiAgICBjb25zdCBsaW1pdCA9IE1hdGguZmxvb3IoTUFYX0lNQUdFX0JZVEVTIC8gMV8wNDhfNTc2KTtcbiAgICB0aHJvdyBuZXcgRGlzY292ZXJFcnJvcihcbiAgICAgIGAke3BhdGh9IGlzICR7bWJ9IE1CLCBhYm92ZSB0aGUgJHtsaW1pdH0gTUIgbGltaXQuIFJlc2l6ZSBiZWZvcmUgcmV0cnlpbmcgYCArXG4gICAgICAgIGAoZS5nLiBJbWFnZU1hZ2ljazogXFxgbWFnaWNrIGluLnBuZyAtcmVzaXplIDIwMDB4MjAwMFxcXFw+IG91dC5wbmdcXGApLmAsXG4gICAgKTtcbiAgfVxuICBpZiAoc2l6ZSA+IFdBUk5fSU1BR0VfQllURVMpIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgIGBXQVJOOiAke3BhdGh9IGlzICR7KHNpemUgLyAxXzA0OF81NzYpLnRvRml4ZWQoMSl9IE1COyBsYXJnZSByZXF1ZXN0cyBzb21ldGltZXMgaGl0IE9wZW5Sb3V0ZXIncyBwYXlsb2FkIGxpbWl0cy5cXG5gLFxuICAgICk7XG4gIH1cbiAgY29uc3QgYnl0ZXMgPSBuZXcgVWludDhBcnJheShhd2FpdCBmaWxlLmFycmF5QnVmZmVyKCkpO1xuICBjb25zdCBiNjQgPSBCdWZmZXIuZnJvbShieXRlcykudG9TdHJpbmcoXCJiYXNlNjRcIik7XG4gIHJldHVybiBgZGF0YToke21pbWVGb3JQYXRoKHBhdGgpfTtiYXNlNjQsJHtiNjR9YDtcbn1cblxuLy8gSW1hZ2UgcGl4ZWwgc2l6ZSB2aWEgQnVuLkltYWdlIG1ldGFkYXRhIChyZXBsYWNlcyB0aGUgUHl0aG9uIG9yaWdpbmFsJ3MgUGlsbG93IHJlYWQpLlxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGltYWdlU2l6ZShwYXRoOiBzdHJpbmcpOiBQcm9taXNlPFtudW1iZXIsIG51bWJlcl0+IHtcbiAgY29uc3QgYnl0ZXMgPSBuZXcgVWludDhBcnJheShhd2FpdCBCdW4uZmlsZShwYXRoKS5hcnJheUJ1ZmZlcigpKTtcbiAgY29uc3QgbWV0YSA9IGF3YWl0IG5ldyBCdW4uSW1hZ2UoYnl0ZXMpLm1ldGFkYXRhKCk7XG4gIHJldHVybiBbbWV0YS53aWR0aCA/PyAwLCBtZXRhLmhlaWdodCA/PyAwXTtcbn1cblxuLy8gRmlyc3QgMTYgY2hhcnMgb2YgdGhlIGZpbGUncyBzaGEyNTYgKG1hdGNoZXMgdGhlIFB5dGhvbiBvcmlnaW5hbCkuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc291cmNlU2hhMjU2XzE2KHBhdGg6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IGJ5dGVzID0gbmV3IFVpbnQ4QXJyYXkoYXdhaXQgQnVuLmZpbGUocGF0aCkuYXJyYXlCdWZmZXIoKSk7XG4gIHJldHVybiBuZXcgQnVuLkNyeXB0b0hhc2hlcihcInNoYTI1NlwiKS51cGRhdGUoYnl0ZXMpLmRpZ2VzdChcImhleFwiKS5zbGljZSgwLCAxNik7XG59XG5cbi8vIOKUgOKUgCBPcGVuUm91dGVyIGNhbGwg4pSA4pSAXG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjYWxsT3BlblJvdXRlcihcbiAgYXBpS2V5OiBzdHJpbmcsXG4gIG1vZGVsOiBzdHJpbmcsXG4gIGltYWdlRGF0YVVybDogc3RyaW5nLFxuICBwcm9tcHQ6IHN0cmluZyxcbik6IFByb21pc2U8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+IHtcbiAgY29uc3QgYm9keSA9IHtcbiAgICBtb2RlbCxcbiAgICBtZXNzYWdlczogW1xuICAgICAge1xuICAgICAgICByb2xlOiBcInVzZXJcIixcbiAgICAgICAgY29udGVudDogW1xuICAgICAgICAgIHsgdHlwZTogXCJ0ZXh0XCIsIHRleHQ6IHByb21wdCB9LFxuICAgICAgICAgIHsgdHlwZTogXCJpbWFnZV91cmxcIiwgaW1hZ2VfdXJsOiB7IHVybDogaW1hZ2VEYXRhVXJsIH0gfSxcbiAgICAgICAgXSxcbiAgICAgIH0sXG4gICAgXSxcbiAgICB0ZW1wZXJhdHVyZTogMCxcbiAgfTtcbiAgY29uc3QgY3RybCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IGN0cmwuYWJvcnQoKSwgMTgwXzAwMCk7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goT1BFTlJPVVRFUl9VUkwsIHtcbiAgICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgICBoZWFkZXJzOiB7XG4gICAgICAgIEF1dGhvcml6YXRpb246IGBCZWFyZXIgJHthcGlLZXl9YCxcbiAgICAgICAgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIsXG4gICAgICAgIFwiSFRUUC1SZWZlcmVyXCI6IFwiaHR0cHM6Ly9naXRodWIuY29tL2ljaGFib2Rjb2xlL3NwZWxsYm9va1wiLFxuICAgICAgICBcIlgtVGl0bGVcIjogXCJtYWdwaWVcIixcbiAgICAgIH0sXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeShib2R5KSxcbiAgICAgIHNpZ25hbDogY3RybC5zaWduYWwsXG4gICAgfSk7XG4gICAgaWYgKCFyZXMub2spIHtcbiAgICAgIGNvbnN0IHRleHQgPSBhd2FpdCByZXMudGV4dCgpLmNhdGNoKCgpID0+IFwiXCIpO1xuICAgICAgdGhyb3cgbmV3IERpc2NvdmVyRXJyb3IoYE9wZW5Sb3V0ZXIgSFRUUCAke3Jlcy5zdGF0dXN9OiAke3RleHR9YCk7XG4gICAgfVxuICAgIHJldHVybiAoYXdhaXQgcmVzLmpzb24oKSkgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIH0gZmluYWxseSB7XG4gICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgfVxufVxuXG4vLyDilIDilIAgb3JjaGVzdHJhdGlvbiDilIDilIBcblxuZXhwb3J0IHR5cGUgRGlzY292ZXJPcHRpb25zID0geyBtb2RlbD86IHN0cmluZzsgYXBpS2V5Pzogc3RyaW5nIH07XG5cbi8vIEZ1bGwgZGlzY292ZXI6IHJlYWQgaW1hZ2UsIGNhbGwgdGhlIG1vZGVsLCBwYXJzZSwgYnVpbGQgdGhlIG1hbmlmZXN0LiBUaHJvd3Ncbi8vIERpc2NvdmVyRXJyb3Igb24gYWN0aW9uYWJsZSBmYWlsdXJlcyAobWlzc2luZyBrZXksIG92ZXJzaXplZCBpbWFnZSwgSFRUUCAvXG4vLyBwYXJzZSBlcnJvcnMpLiBUaGUgT1BFTlJPVVRFUl9BUElfS0VZIG11c3QgYmUgaW4gdGhlIGVudmlyb25tZW50IOKAlCB3ZSBuZXZlclxuLy8gaW5zdGFsbCBhIGtleS5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBkaXNjb3ZlcihpbWFnZVBhdGg6IHN0cmluZywgb3B0czogRGlzY292ZXJPcHRpb25zID0ge30pOiBQcm9taXNlPE1hbmlmZXN0PiB7XG4gIGNvbnN0IG1vZGVsID0gb3B0cy5tb2RlbCA/PyBERUZBVUxUX01PREVMO1xuICBjb25zdCBhcGlLZXkgPSBvcHRzLmFwaUtleSA/PyBwcm9jZXNzLmVudi5PUEVOUk9VVEVSX0FQSV9LRVk7XG4gIGlmICghYXBpS2V5KSB7XG4gICAgdGhyb3cgbmV3IERpc2NvdmVyRXJyb3IoXCJPUEVOUk9VVEVSX0FQSV9LRVkgZW52IHZhciBub3Qgc2V0XCIpO1xuICB9XG4gIGlmICghKGF3YWl0IEJ1bi5maWxlKGltYWdlUGF0aCkuZXhpc3RzKCkpKSB7XG4gICAgdGhyb3cgbmV3IERpc2NvdmVyRXJyb3IoYGltYWdlIG5vdCBmb3VuZDogJHtpbWFnZVBhdGh9YCk7XG4gIH1cblxuICBjb25zdCBbc2l6ZSwgZGF0YVVybCwgc2hhXSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICBpbWFnZVNpemUoaW1hZ2VQYXRoKSxcbiAgICBlbmNvZGVJbWFnZURhdGFVcmwoaW1hZ2VQYXRoKSxcbiAgICBzb3VyY2VTaGEyNTZfMTYoaW1hZ2VQYXRoKSxcbiAgXSk7XG4gIGNvbnN0IFt3aWR0aCwgaGVpZ2h0XSA9IHNpemU7XG5cbiAgY29uc3QgcmVzcCA9IGF3YWl0IGNhbGxPcGVuUm91dGVyKGFwaUtleSwgbW9kZWwsIGRhdGFVcmwsIFBST01QVCk7XG5cbiAgY29uc3QgY2hvaWNlcyA9IHJlc3AuY2hvaWNlcyBhcyBBcnJheTx7IG1lc3NhZ2U/OiB7IGNvbnRlbnQ/OiB1bmtub3duIH0gfT4gfCB1bmRlZmluZWQ7XG4gIGNvbnN0IGNvbnRlbnQgPSBjaG9pY2VzPy5bMF0/Lm1lc3NhZ2U/LmNvbnRlbnQ7XG4gIGlmICh0eXBlb2YgY29udGVudCAhPT0gXCJzdHJpbmdcIikge1xuICAgIHRocm93IG5ldyBEaXNjb3ZlckVycm9yKFxuICAgICAgYHVuZXhwZWN0ZWQgcmVzcG9uc2Ugc2hhcGUgZnJvbSBPcGVuUm91dGVyIChubyBjaG9pY2VzWzBdLm1lc3NhZ2UuY29udGVudCk6XFxuJHtKU09OLnN0cmluZ2lmeShyZXNwKS5zbGljZSgwLCAyMDAwKX1gLFxuICAgICk7XG4gIH1cblxuICBjb25zdCB1c2FnZSA9IChyZXNwLnVzYWdlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA/PyB7fTtcbiAgY29uc3QgY29zdCA9IHR5cGVvZiB1c2FnZS5jb3N0ID09PSBcIm51bWJlclwiID8gdXNhZ2UuY29zdCA6IDA7XG4gIGNvbnN0IHByb21wdFRva2VucyA9IHR5cGVvZiB1c2FnZS5wcm9tcHRfdG9rZW5zID09PSBcIm51bWJlclwiID8gdXNhZ2UucHJvbXB0X3Rva2VucyA6IDA7XG4gIGNvbnN0IGNvbXBsZXRpb25Ub2tlbnMgPVxuICAgIHR5cGVvZiB1c2FnZS5jb21wbGV0aW9uX3Rva2VucyA9PT0gXCJudW1iZXJcIiA/IHVzYWdlLmNvbXBsZXRpb25fdG9rZW5zIDogMDtcbiAgY29uc3QgZGV0YWlscyA9ICh1c2FnZS5jb21wbGV0aW9uX3Rva2Vuc19kZXRhaWxzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSA/PyB7fTtcbiAgY29uc3QgcmVhc29uaW5nVG9rZW5zID1cbiAgICB0eXBlb2YgZGV0YWlscy5yZWFzb25pbmdfdG9rZW5zID09PSBcIm51bWJlclwiID8gZGV0YWlscy5yZWFzb25pbmdfdG9rZW5zIDogMDtcblxuICBsZXQgcmF3OiB1bmtub3duW107XG4gIHRyeSB7XG4gICAgcmF3ID0gcGFyc2VCYm94ZXMoY29udGVudCk7XG4gIH0gY2F0Y2ggKGV4KSB7XG4gICAgdGhyb3cgbmV3IERpc2NvdmVyRXJyb3IoXG4gICAgICBgbW9kZWwgcmV0dXJuZWQgbm9uLUpTT04gb3V0cHV0OlxcbiR7Y29udGVudH1cXG5cXG5QYXJzZSBlcnJvcjogJHtleCBpbnN0YW5jZW9mIEVycm9yID8gZXgubWVzc2FnZSA6IFN0cmluZyhleCl9YCxcbiAgICApO1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBzb3VyY2U6IHJlc29sdmUoaW1hZ2VQYXRoKSxcbiAgICBzb3VyY2Vfc2l6ZTogW3dpZHRoLCBoZWlnaHRdLFxuICAgIHNvdXJjZV9zaGEyNTZfMTY6IHNoYSxcbiAgICBtb2RlbCxcbiAgICBjb3N0X3VzZDogY29zdCxcbiAgICB0b2tlbnM6IHsgcHJvbXB0OiBwcm9tcHRUb2tlbnMsIGNvbXBsZXRpb246IGNvbXBsZXRpb25Ub2tlbnMsIHJlYXNvbmluZzogcmVhc29uaW5nVG9rZW5zIH0sXG4gICAgZWxlbWVudHM6IGVsZW1lbnRzRnJvbVJhdyhyYXcsIHdpZHRoLCBoZWlnaHQpLFxuICB9O1xufVxuXG4vLyDilIDilIAgQ0xJIGVudHJ5IChwYXJpdHkgd2l0aCB0aGUgUHl0aG9uIG9yaWdpbmFsKSDilIDilIBcbmFzeW5jIGZ1bmN0aW9uIG1haW4oYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCB7IHBhcnNlQXJncyB9ID0gYXdhaXQgaW1wb3J0KFwibm9kZTp1dGlsXCIpO1xuICBsZXQgcGFyc2VkOiBSZXR1cm5UeXBlPHR5cGVvZiBwYXJzZUFyZ3M+O1xuICB0cnkge1xuICAgIHBhcnNlZCA9IHBhcnNlQXJncyh7XG4gICAgICBhcmdzOiBhcmd2LFxuICAgICAgb3B0aW9uczoge1xuICAgICAgICBvdXQ6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICAgICAgICBtb2RlbDogeyB0eXBlOiBcInN0cmluZ1wiLCBkZWZhdWx0OiBERUZBVUxUX01PREVMIH0sXG4gICAgICB9LFxuICAgICAgYWxsb3dQb3NpdGlvbmFsczogdHJ1ZSxcbiAgICAgIHN0cmljdDogdHJ1ZSxcbiAgICB9KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBlcnJvcjogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9XFxuYCk7XG4gICAgcmV0dXJuIDI7XG4gIH1cbiAgY29uc3QgaW1hZ2VQYXRoID0gcGFyc2VkLnBvc2l0aW9uYWxzWzBdO1xuICBpZiAoIWltYWdlUGF0aCkge1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFwidXNhZ2U6IGRpc2NvdmVyLnRzIDxpbWFnZT4gWy0tb3V0IDxtYW5pZmVzdC5qc29uPl0gWy0tbW9kZWwgPG1vZGVsPl1cXG5cIik7XG4gICAgcmV0dXJuIDI7XG4gIH1cbiAgdHJ5IHtcbiAgICBjb25zdCBtYW5pZmVzdCA9IGF3YWl0IGRpc2NvdmVyKGltYWdlUGF0aCwgeyBtb2RlbDogcGFyc2VkLnZhbHVlcy5tb2RlbCBhcyBzdHJpbmcgfSk7XG4gICAgY29uc3Qgb3V0ID1cbiAgICAgIChwYXJzZWQudmFsdWVzLm91dCBhcyBzdHJpbmcgfCB1bmRlZmluZWQpID8/XG4gICAgICBqb2luKGRpcm5hbWUocmVzb2x2ZShpbWFnZVBhdGgpKSwgYCR7YmFzZVN0ZW0oaW1hZ2VQYXRoKX0tbWFuaWZlc3QuanNvbmApO1xuICAgIGF3YWl0IEJ1bi53cml0ZShvdXQsIEpTT04uc3RyaW5naWZ5KG1hbmlmZXN0LCBudWxsLCAyKSk7XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgICBgRGlzY292ZXJlZCAke21hbmlmZXN0LmVsZW1lbnRzLmxlbmd0aH0gZWxlbWVudChzKSDigJQgY29zdCAkJHttYW5pZmVzdC5jb3N0X3VzZC50b0ZpeGVkKDQpfVxcbmAsXG4gICAgKTtcbiAgICBmb3IgKGNvbnN0IGUgb2YgbWFuaWZlc3QuZWxlbWVudHMpIHtcbiAgICAgIGNvbnN0IFt4MSwgeTEsIHgyLCB5Ml0gPSBlLmJib3hfcGl4ZWw7XG4gICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgICAke2UudHlwZX0gICR7ZS5uYW1lfSAgc3JjPSgke3gxfSwke3kxfSwke3gyfSwke3kyfSlcXG5gKTtcbiAgICB9XG4gICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYE1hbmlmZXN0IHdyaXR0ZW46ICR7b3V0fVxcbmApO1xuICAgIHJldHVybiAwO1xuICB9IGNhdGNoIChlKSB7XG4gICAgaWYgKGUgaW5zdGFuY2VvZiBEaXNjb3ZlckVycm9yKSB7XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgRVJST1I6ICR7ZS5tZXNzYWdlfVxcbmApO1xuICAgICAgcmV0dXJuIDE7XG4gICAgfVxuICAgIHRocm93IGU7XG4gIH1cbn1cblxuZnVuY3Rpb24gYmFzZVN0ZW0ocGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgYmFzZSA9IHBhdGguc3BsaXQoXCIvXCIpLnBvcCgpID8/IHBhdGg7XG4gIGNvbnN0IGRvdCA9IGJhc2UubGFzdEluZGV4T2YoXCIuXCIpO1xuICByZXR1cm4gZG90ID4gMCA/IGJhc2Uuc2xpY2UoMCwgZG90KSA6IGJhc2U7XG59XG5cbmlmIChpbXBvcnQubWV0YS5tYWluKSB7XG4gIC8vIGBwcm9jZXNzLmV4aXRDb2RlYCArIGEgbmF0dXJhbCByZXR1cm4sIE5FVkVSIGBwcm9jZXNzLmV4aXQoY29kZSlgOiBCdW4nc1xuICAvLyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGEgcGlwZSAoc3luY2hyb25vdXMgb24gYSBUVFkgb3IgZmlsZSksIHNvIGFuXG4gIC8vIGV4cGxpY2l0IGV4aXQgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlCBtZWFzdXJlZCBhdCBleGFjdGx5XG4gIC8vIDY1LDUzNiBieXRlcy4gVGhlIHBheWxvYWQgaXMgY29tcGxldGUgYW5kIG9ubHkgdGhlIHdyaXRlIGlzIGxvc3QsIHNvIHRoZVxuICAvLyBjYWxsZXIgZ2V0cyB3ZWxsLWZvcm1lZC1sb29raW5nIEpTT04gdGhhdCBzdG9wcyBtaWQtc3RyaW5nLiBSZXByb2R1Y2VkLFxuICAvLyBmaXhlZCBhbmQgZ2F0ZWQgaW4gYm91bnR5IGZpcnN0IChQMCwgIzc3LyM3OCk7IHNhbWUgc2hhcGUsIHNhbWUgcmVhc29uLlxuICAvLyBEbyBub3QgdGlkeSB0aGlzIGJhY2sgaW50byBhbiBleHBsaWNpdCBleGl0LlxuICBwcm9jZXNzLmV4aXRDb2RlID0gYXdhaXQgbWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMikpO1xufVxuIiwKICAgICIvLyBzaGFyZWQvdHlwZXMudHNcbi8vIFRoZSBzaW5nbGUgc2hhcmVkIGNvbnRyYWN0IGZvciBtYWdwaWUncyBjb25qdXJhdGlvbi4gSW1wb3J0ZWQgYnkgc2VydmVyLnRzLFxuLy8gcmVkdWNlLnRzLCBjbGkudHMsIEFORCB0aGUgUmVhY3QgY2xpZW50LlxuLy9cbi8vIG1hZ3BpZSAocmVidWlsdCkgaXMgYSBTVEFORElORyBSRVZJRVcgU1VSRkFDRSBvdmVyIGEgY29tcG9zaXRlIGltYWdlOiB0aGVcbi8vIGRhZW1vbiBob2xkcyB0aGUgZXh0cmFjdGlvbiBzdGF0ZSwgdGhlIFJlYWN0IHN1cmZhY2Ugc2hvd3MgdGhlIGVsZW1lbnRcbi8vIGJyZWFrZG93biwgYW5kIHRoZSB1c2VyIGp1ZGdlcyBlYWNoIGN1dG91dCwgY29tcGFyZXMgcmVtb3ZhbC1tb2RlbCByZXN1bHRzLFxuLy8gYW5kIHNlbGVjdGl2ZWx5IHJldHJpZXMuIFRoZSBhZ2VudCBkcml2ZXMgZGlzY292ZXJ5ICsgZXh0cmFjdGlvbjsgdGhlIHN1cmZhY2Vcbi8vIGlzIHdoZXJlIHRoZSB1c2VyIHN0ZWVycy5cbi8vXG4vLyBQUk9WSVNJT05BTCDigJQgdGhpcyBzdGF0ZSBzaGFwZSBpcyBhIGRlc2lnbi1pbmRlcGVuZGVudCBza2VsZXRvbi4gVGhlXG4vLyBtYWdwaWUtc3BlY2lmaWMgc3VyZmFjZSArIHRoZSBmaW5hbCBzZXR0bGVkIHNoYXBlIGFyZSBiZWluZyBkZXNpZ25lZCBpblxuLy8gcGFyYWxsZWwuIEV2ZXJ5dGhpbmcgbWFya2VkIGAvLyBUT0RPKG1vY2spOiDigKZgIGlzIGEgZGVsaWJlcmF0ZSBwbGFjZWhvbGRlciB0aGVcbi8vIG1vY2sgdHJhY2sgd2lsbCByZXBsYWNlOyBrZWVwIG11dGF0b3JzIChyZWR1Y2UudHMpIHRoaW4gYXJvdW5kIGl0LlxuXG4vLyBUaGUgZWxlbWVudCB0eXBlIHRheG9ub215IHBvcnRlZCBmcm9tIHRoZSBQeXRob24gb3JpZ2luYWwg4oCUIGRyaXZlcyB0aGUgKGZ1dHVyZSlcbi8vIGJhY2tncm91bmQtcmVtb3ZhbCBkZWNpc2lvbiBpbiBleHRyYWN0LlxuZXhwb3J0IHR5cGUgRWxlbWVudFR5cGUgPVxuICB8IFwid29yZG1hcmtcIlxuICB8IFwidGFnbGluZVwiXG4gIHwgXCJpY29uXCJcbiAgfCBcImlsbHVzdHJhdGlvblwiXG4gIHwgXCJzdGlja2VyXCJcbiAgfCBcInBhbGV0dGVcIlxuICB8IFwidHlwb2dyYXBoeVwiXG4gIHwgXCJzY3JlZW5zaG90XCJcbiAgfCBcIm90aGVyXCI7XG5cbmV4cG9ydCBjb25zdCBFTEVNRU5UX1RZUEVTOiByZWFkb25seSBFbGVtZW50VHlwZVtdID0gW1xuICBcIndvcmRtYXJrXCIsXG4gIFwidGFnbGluZVwiLFxuICBcImljb25cIixcbiAgXCJpbGx1c3RyYXRpb25cIixcbiAgXCJzdGlja2VyXCIsXG4gIFwicGFsZXR0ZVwiLFxuICBcInR5cG9ncmFwaHlcIixcbiAgXCJzY3JlZW5zaG90XCIsXG4gIFwib3RoZXJcIixcbl0gYXMgY29uc3Q7XG5cbi8vIFRoZSBsaW5lYXIgcHJvY2VzcyBzcGluZSAodGhlIHRvcC1iYXIgc3RlcHBlcikuIE9uZSBhY3RpdmUgcGhhc2UgYXQgYSB0aW1lO1xuLy8gdGhlIGN1cnNvciBhZHZhbmNlcyB3aGVuIHRoZSB1c2VyIHNlYWxzIGEgcGhhc2UuIFN0YXR1cyBpcyBERVJJVkVEIGZyb20gdGhlXG4vLyBjdXJzb3Ig4oCUIHBoYXNlcyBiZWZvcmUgaXQgYXJlIHNlYWxlZCwgdGhlIGN1cnNvciBpcyBhY3RpdmUsIGFmdGVyIGlzIHVwY29taW5nLlxuZXhwb3J0IHR5cGUgUGhhc2VLZXkgPSBcImludGFrZVwiIHwgXCJzbGljZVwiIHwgXCJyZW1vdmVcIiB8IFwiZXhwb3J0XCI7XG5leHBvcnQgY29uc3QgUEhBU0VTOiByZWFkb25seSBQaGFzZUtleVtdID0gW1wiaW50YWtlXCIsIFwic2xpY2VcIiwgXCJyZW1vdmVcIiwgXCJleHBvcnRcIl0gYXMgY29uc3Q7XG5cbi8vIEEgcGl4ZWwgYm91bmRpbmcgYm94IFt4MSwgeTEsIHgyLCB5Ml0gaW4gc291cmNlLWltYWdlIGNvb3JkaW5hdGVzIChtYXRjaGVzXG4vLyB0aGUgUHl0aG9uIG9yaWdpbmFsJ3MgYGJib3hfcGl4ZWxgKS5cbmV4cG9ydCB0eXBlIEJib3ggPSBbbnVtYmVyLCBudW1iZXIsIG51bWJlciwgbnVtYmVyXTtcblxuLy8gVGhlIGJhY2tkcm9wIHRoZSBzdXJmYWNlIHByZXZpZXdzIGN1dG91dHMgYWdhaW5zdCAoYSBjaGVja2VyIGZvciB0cmFuc3BhcmVudCkuXG5leHBvcnQgdHlwZSBCYWNrZHJvcCA9IFwid2hpdGVcIiB8IFwiZ3JheVwiIHwgXCJibGFja1wiIHwgXCJ0cmFuc3BhcmVudFwiO1xuXG4vLyBPbmUgZXh0cmFjdGFibGUgZWxlbWVudC4gTUlOSU1BTCBwcm92aXNpb25hbCBzaGFwZSDigJQgdGhlIHJldmlldy9qdWRnbWVudFxuLy8gbWFjaGluZXJ5IGlzIG1vY2tlZCBvdXQgZm9yIG5vdy4gYGJib3hgIGlzIGNhbm9uaWNhbCBpbiBTT1VSQ0UgUElYRUxTICh3aGF0XG4vLyBkaXNjb3ZlciBwcm9kdWNlcyBhbmQgY3JvcCBjb25zdW1lcyk7IHRoZSBjYW52YXMgY29udmVydHMgcHjihpRmcmFjdGlvbiB2aWFcbi8vIGBzb3VyY2Uuc2l6ZWAgZm9yIHJlbmRlcmluZy9lZGl0aW5nLlxuZXhwb3J0IHR5cGUgRWxlbWVudFN0YXR1cyA9IFwicHJvcG9zZWRcIiB8IFwiY29uZmlybWVkXCIgfCBcImRyb3BwZWRcIjtcblxuLy8gQSBwcm9kdWNlZCBhc3NldCBmb3Igb25lIGVsZW1lbnQ6IHRoZSByYXcgY3JvcCAobW9kZWw6XCJjcm9wXCIpIG9yIGEgcmVtb3ZhbFxuLy8gcmVzdWx0LiBgcGF0aGAgaXMgdGhlIG9uLWRpc2sgUE5HIHNlcnZlZCB2aWEgL2Fzc2V0czsgYHJldmAgYnVtcHMgb24gZXZlcnlcbi8vIChyZS0pcnVuIG9mIHRoZSBTQU1FIG1vZGVsIOKAlCB0aGUgZmlsZSBpcyBvdmVyd3JpdHRlbiBpbiBwbGFjZSwgc28gdGhlIHN1cmZhY2Vcbi8vIGFwcGVuZHMgP3Y9PHJldj4gdG8gYnVzdCB0aGUgYnJvd3NlciBjYWNoZS4gYGtpbmRgIGlzIGEgbGFiZWwtY2hpcCBoaW50IHRoZVxuLy8gYWdlbnQgc3VwcGxpZXM7IG5ldmVyIGluZmVycmVkIGluIHRoZSBVSS5cbmV4cG9ydCB0eXBlIEVsZW1lbnRWZXJzaW9uID0ge1xuICBpZDogc3RyaW5nO1xuICBtb2RlbDogc3RyaW5nOyAvLyBcImNyb3BcIiB8IFwicmVtYmdcIiB8IFwiYnJpYVwiIHwgXCJpZGVvZ3JhbVwiIHwg4oCmIChhZ2VudC1kZWZpbmVkKVxuICBraW5kPzogXCJyYXdcIiB8IFwibG9jYWxcIiB8IFwiY2xvdWRcIjtcbiAgcGF0aDogc3RyaW5nO1xuICByZXY6IG51bWJlcjtcbiAgbm90ZT86IHN0cmluZztcbn07XG5cbmV4cG9ydCB0eXBlIEVsZW1lbnQgPSB7XG4gIGlkOiBzdHJpbmc7XG4gIG5hbWU6IHN0cmluZztcbiAgdHlwZTogRWxlbWVudFR5cGU7XG4gIGJib3g6IEJib3g7XG4gIHN0YXR1czogRWxlbWVudFN0YXR1cztcbiAgLy8g4pSA4pSAIGV4dHJhY3Rpb24g4pSA4pSAXG4gIC8vIFByb2R1Y2VkIGFzc2V0cywgb25lIHJvdyBwZXIgbW9kZWwuIGNyb3AgPSB2ZXJzaW9uc1swXSAobW9kZWw6XCJjcm9wXCIpLlxuICAvLyBBYnNlbnQgdW50aWwgdGhlIGZpcnN0IGN1dDsgdHJlYXQgdW5kZWZpbmVkIGFzIFtdLiBUaGUgY2hvc2VuIHZlcnNpb24gaXNcbiAgLy8gd2hhdCB0aGUgcmFpbC9nYWxsZXJ5IHJlbmRlciAoY2hvc2VuVmVyc2lvbigpIGZhbGxzIGJhY2sgdG8gdmVyc2lvbnNbMF0pLlxuICB2ZXJzaW9ucz86IEVsZW1lbnRWZXJzaW9uW107XG4gIGNob3NlblZlcnNpb25JZD86IHN0cmluZztcbiAgLy8gVGhlIHNvbGUgcmV2aWV3IHNpZ25hbDogdGhlIHVzZXIgZmxhZ2dlZCB0aGlzIGVsZW1lbnQgdG8gYmUgcmUtcnVuIChyZS1zbGljZVxuICAvLyBpbiB0aGUgc2xpY2VzIHBoYXNlLCByZS1yZW1vdmUgaW4gdGhlIGJnIHBoYXNlKS4gQXBwcm92YWwgaXMgdGhlIEFCU0VOQ0Ugb2YgYVxuICAvLyBmbGFnOyBkaXNjYXJkaW5nIGlzIHN0YXR1czpcImRyb3BwZWRcIi4gQ2xlYXJlZCB3aGVuIGEgZnJlc2ggdmVyc2lvbiBsYW5kcy5cbiAgZmxhZ2dlZD86IGJvb2xlYW47XG59O1xuXG4vLyDilIDilIAgdGhlIGNvbnZlcnNhdGlvbiAodGhlIHNwaW5lLCBwb3J0ZWQgc2V0dGxlZCBmcm9tIGltYWdvKSDilIDilIBcbmV4cG9ydCB0eXBlIE1lc3NhZ2VLaW5kID1cbiAgfCBcInRleHRcIiAvLyBwbGFpbiBkaWFsb2d1ZSAoZWl0aGVyIHJvbGUpXG4gIHwgXCJnZXN0dXJlXCIgLy8gYSBzdXJmYWNlIGFjdGlvbiBzdXJmYWNlZCBhcyBhIG1lc3NhZ2UgKHVzZXIganVkZ2VkL3JldHJpZWQv4oCmKVxuICB8IFwicXVlc3Rpb25cIjsgLy8gYWdlbnQgbmVlZHMgdGhlIHVzZXIgKGFuIHVuYW5zd2VyZWQgb25lIOKGkiBcImFza2luZ1wiIHByZXNlbmNlKVxuXG5leHBvcnQgdHlwZSBNZXNzYWdlID0ge1xuICBpZDogc3RyaW5nO1xuICByb2xlOiBcInVzZXJcIiB8IFwiYWdlbnRcIjtcbiAga2luZDogTWVzc2FnZUtpbmQ7XG4gIHRleHQ6IHN0cmluZztcbiAgdHM6IG51bWJlcjtcbiAgLy8ga2luZDogXCJxdWVzdGlvblwiIOKAlCBvcHRpb25hbCBxdWljayByZXBsaWVzICh0aGUgZnVsbCBhbnN3ZXIgY2FuIGJlIGZyZWUgdGV4dClcbiAgb3B0aW9ucz86IHN0cmluZ1tdO1xuICAvLyBraW5kOiBcImdlc3R1cmVcIiDigJQgd2hhdCB0aGUgdXNlciBkaWQsIGFuZCB0byB3aGF0XG4gIGdlc3R1cmU/OiB7IGtpbmQ6IHN0cmluZzsgdGFyZ2V0SWQ/OiBzdHJpbmcgfTtcbiAgLy8gQW4gb3B0aW9uYWwgb25lLWNsaWNrIENUQSB0aGUgYWdlbnQgYXR0YWNoZXMgdG8gYSBtZXNzYWdlIOKAlCBhIFNIT1JUQ1VUIGZvciBhXG4gIC8vIGNvbnZlcnNhdGlvbmFsIGFjdCAodGhlIHVzZXIgY291bGQgaGF2ZSBqdXN0IHNhaWQgaXQpLiBDbGlja2luZyBkaXNwYXRjaGVzXG4gIC8vIGBjb21tYW5kYCAoZS5nLiB7IHR5cGU6IFwicGhhc2UuYWR2YW5jZVwiIH0pLiBDb252ZXJzYXRpb24gc3RheXMgdGhlIHByaW1hcnlcbiAgLy8gY2FwYWJpbGl0eTsgdGhpcyBpcyBzdWdhciBvbiB0b3AsIHN1cmZhY2VkIGJ5IHRoZSBhZ2VudCBhdCBpdHMgZGlzY3JldGlvbi5cbiAgYWN0aW9uPzogeyBsYWJlbDogc3RyaW5nOyBjb21tYW5kOiBDbGllbnRUb1NlcnZlciB9O1xufTtcblxuLy8gQSBib3ggYmVmb3JlIHRoZSBkYWVtb24gYXNzaWducyBpdCBhbiBpZCDigJQgZHJhd24gYnkgdGhlIHVzZXIgKFwibWFyayBhIG1pc3NlZFxuLy8gcmVnaW9uXCIpIG9yIGJ5IHRoZSBhZ2VudCBib3hpbmcgaW5jcmVtZW50YWxseS4gVGhlIGRhZW1vbiBmaWxscyBgaWRgIGFuZFxuLy8gZGVmYXVsdHMgbmFtZS90eXBlL3N0YXR1cyBvbiBlbGVtZW50LmFkZC5cbmV4cG9ydCB0eXBlIE5ld0VsZW1lbnQgPSB7XG4gIGJib3g6IEJib3g7XG4gIG5hbWU/OiBzdHJpbmc7XG4gIHR5cGU/OiBFbGVtZW50VHlwZTtcbiAgc3RhdHVzPzogRWxlbWVudFN0YXR1cztcbn07XG5cbi8vIFRoZSBzb3VyY2UgY29tcG9zaXRlIGltYWdlIHVuZGVyIHJldmlldy4gYHBhdGhgIGlzIHRoZSBvbi1kaXNrIGZpbGUgdGhlIGFnZW50XG4vLyByZWFkczsgYHNpemVgIGlzIFt3LCBoXSBpbiBweDsgYHNoYWAgaXMgdGhlIGZpcnN0LTE2IG9mIHRoZSBzaGEyNTYgKG1hdGNoZXNcbi8vIHRoZSBQeXRob24gb3JpZ2luYWwncyBgc291cmNlX3NoYTI1Nl8xNmApLlxuZXhwb3J0IHR5cGUgU291cmNlID0ge1xuICBwYXRoOiBzdHJpbmc7XG4gIHNpemU6IFtudW1iZXIsIG51bWJlcl07XG4gIHNoYTogc3RyaW5nO1xufTtcblxuLy8g4pSA4pSAIHRoZSB3aG9sZSBzdGF0ZSAoUFJPVklTSU9OQUwpIOKUgOKUgFxuZXhwb3J0IHR5cGUgTWFncGllU3RhdGUgPSB7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIGludGVudDogc3RyaW5nOyAvLyB3aGF0IHRoZSB1c2VyIHdhbnRzIG91dCBvZiB0aGlzIGJvYXJkIChmcmVlIHRleHQgdGhlIGFnZW50IHNldHMpXG4gIHBoYXNlOiBQaGFzZUtleTsgLy8gdGhlIGxpbmVhciBwcm9jZXNzIGN1cnNvciAoSW50YWtlIOKGkiBTbGljZSDihpIgUmVtb3ZlIOKGkiBFeHBvcnQpXG4gIHNvdXJjZTogU291cmNlIHwgbnVsbDtcbiAgZWxlbWVudHM6IEVsZW1lbnRbXTtcbiAgY29udmVyc2F0aW9uOiBNZXNzYWdlW107XG4gIGJhY2tkcm9wOiBCYWNrZHJvcDtcbiAgc3RhdHVzOiB7IGJ1c3k6IGJvb2xlYW47IHRleHQ6IHN0cmluZyB9O1xuICAvLyBUaGUgYnVpbHQgZXhwb3J0IGJ1bmRsZSAoRXhwb3J0IHBoYXNlKSwgaWYgYW55IOKAlCBzZXJ2ZWQgdmlhIC9hc3NldHMvPG5hbWU+LlxuICBidW5kbGU/OiB7IG5hbWU6IHN0cmluZzsgY291bnQ6IG51bWJlciB9O1xuICAvLyBUaGUgY3VycmVudCBzZXNzaW9uIGlkIChydW50aW1lOyB0aGUgZGFlbW9uIHNldHMgaXQgYXQgc3RhcnQsIE5PVCBwZXJzaXN0ZWQtXG4gIC8vIG1lYW5pbmdmdWwgc2luY2UgcmVzdG9yZSBtaW50cyBhIG5ldyBvbmUpIOKAlCBzaG93biBpbiBFeHBvcnQncyByZW9wZW4gaGludC5cbiAgc2Vzc2lvbklkPzogc3RyaW5nO1xufTtcblxuZXhwb3J0IGZ1bmN0aW9uIGRlZmF1bHRTdGF0ZSh0aXRsZTogc3RyaW5nKTogTWFncGllU3RhdGUge1xuICByZXR1cm4ge1xuICAgIHRpdGxlLFxuICAgIGludGVudDogXCJcIixcbiAgICBwaGFzZTogXCJpbnRha2VcIixcbiAgICBzb3VyY2U6IG51bGwsXG4gICAgZWxlbWVudHM6IFtdLFxuICAgIGNvbnZlcnNhdGlvbjogW10sXG4gICAgYmFja2Ryb3A6IFwidHJhbnNwYXJlbnRcIixcbiAgICBzdGF0dXM6IHsgYnVzeTogZmFsc2UsIHRleHQ6IFwiXCIgfSxcbiAgfTtcbn1cblxuLy8g4pSA4pSAIFNlcnZlciDihpIgYnJvd3NlciAoV2ViU29ja2V0KS4gVGhlIGJyb3dzZXIgaGFuZGxlcyBleGFjdGx5IHRoZXNlLiDilIDilIBcbmV4cG9ydCB0eXBlIFNlcnZlclRvQ2xpZW50ID1cbiAgfCB7IHR5cGU6IFwic3RhdGVcIjsgc3RhdGU6IE1hZ3BpZVN0YXRlIH1cbiAgfCB7IHR5cGU6IFwibWVzc2FnZVwiOyB0ZXh0OiBzdHJpbmcgfVxuICAvLyBhZ2VudCBwcmVzZW5jZSDigJQgaXMgYXQgbGVhc3Qgb25lIGFnZW50IHRhaWxpbmcgL2V2ZW50cyAod2F0Y2hpbmcgdGhlIGJvYXJkKT9cbiAgLy8gcHVzaGVkIG9uIGNoYW5nZSArIG9uIGJyb3dzZXIgY29ubmVjdDsgcnVudGltZS1vbmx5LCBuZXZlciBwZXJzaXN0ZWQgaW4gc3RhdGUuXG4gIHwgeyB0eXBlOiBcInByZXNlbmNlXCI7IGFnZW50OiBib29sZWFuIH1cbiAgfCB7IHR5cGU6IFwic3VibWl0XCIgfVxuICB8IHsgdHlwZTogXCJjYW5jZWxcIiB9O1xuXG4vLyDilIDilIAgQnJvd3NlciDihpIgc2VydmVyIChXZWJTb2NrZXQpLiBUaGUgY2xpZW50IHNlbmRzIGV4YWN0bHkgdGhlc2UuIOKUgOKUgFxuLy8gRWFjaCBlaXRoZXIgbXV0YXRlcyBzdGF0ZSAocmUtYnJvYWRjYXN0KSBhbmQvb3IgZW1pdHMgYW4gU1NFIGV2ZW50IHRoZSBhZ2VudFxuLy8gcmVhY3RzIHRvLlxuZXhwb3J0IHR5cGUgQ2xpZW50VG9TZXJ2ZXIgPVxuICB8IHsgdHlwZTogXCJzYXlcIjsgdGV4dDogc3RyaW5nIH0gLy8gdXNlciBwb3N0cyBhIG1lc3NhZ2UgLyBpbnN0cnVjdGlvblxuICB8IHsgdHlwZTogXCJzb3VyY2UuaW1wb3J0XCI7IG5hbWU6IHN0cmluZzsgZGF0YVVybDogc3RyaW5nIH0gLy8gdXNlciBkcm9wcGVkIGEgY29tcG9zaXRlIOKGkiBkYWVtb24gbWF0ZXJpYWxpemVzIGl0XG4gIHwgeyB0eXBlOiBcImVsZW1lbnQuYWRkXCI7IGVsZW1lbnQ6IE5ld0VsZW1lbnQgfSAvLyB1c2VyIGRyZXcgYSBtaXNzZWQgcmVnaW9uIG9uIHRoZSBjYW52YXNcbiAgfCB7IHR5cGU6IFwiZWxlbWVudC51cGRhdGVcIjsgaWQ6IHN0cmluZzsgcGF0Y2g6IFBhcnRpYWw8RWxlbWVudD4gfSAvLyBtb3ZlIC8gcmVzaXplIC8gcmVuYW1lIC8gcmV0eXBlXG4gIHwgeyB0eXBlOiBcImVsZW1lbnQucmVtb3ZlXCI7IGlkOiBzdHJpbmcgfSAvLyBoYXJkLWRlbGV0ZSBhIGJveCAodXN1YWxseSBhIHVzZXItZHJhd24gb25lKVxuICB8IHsgdHlwZTogXCJlbGVtZW50Lmp1ZGdlXCI7IGlkOiBzdHJpbmc7IHN0YXR1czogRWxlbWVudFN0YXR1cyB9IC8vIHNvZnQgY29uZmlybS9kcm9wIGEgZGlzY292ZXJlZCBlbGVtZW50XG4gIHwgeyB0eXBlOiBcImV4dHJhY3RcIjsgaWRzPzogc3RyaW5nW10gfSAvLyBjdXQgc2xpY2VzIGZvciBhbGwgY29uZmlybWVkIGVsZW1lbnRzLCBvciBhIHN1YnNldCAocmUtY3V0KVxuICB8IHsgdHlwZTogXCJlbGVtZW50LmZsYWdcIjsgaWQ6IHN0cmluZzsgZmxhZ2dlZDogYm9vbGVhbiB9IC8vIGZsYWcvdW5mbGFnIGZvciByZS1ydW4gKHJlLXNsaWNlIG9yIHJlLXJlbW92ZSlcbiAgfCB7IHR5cGU6IFwidmVyc2lvbi5jaG9vc2VcIjsgaWQ6IHN0cmluZzsgdmVyc2lvbklkOiBzdHJpbmcgfSAvLyB1c2VyIHBpY2tlZCBhIHZlcnNpb24g4oaSIGl0IGJlY29tZXMgY2hvc2VuIChhbWJpZW50KVxuICB8IHsgdHlwZTogXCJyZW1vdmVCZ1wiOyBpZHM/OiBzdHJpbmdbXSB9IC8vIHJlbW92ZSBiYWNrZ3JvdW5kcyBmb3IgdGhlc2UgYWxwaGEtZWxpZ2libGUgZWxlbWVudHMgKGFic2VudCDihpIgYWxsIGVsaWdpYmxlKVxuICB8IHsgdHlwZTogXCJyZXRyeVJlbW92YWxcIjsgaWRzOiBzdHJpbmdbXSB9IC8vIFwidHJ5IGEgZGlmZmVyZW50IHJlbW92YWxcIiDigJQgYWdlbnQgcGlja3MgYW4gVU5VU0VEIG1vZGVsOyBwYXlsb2FkIGlzIGlkcyBvbmx5XG4gIHwgeyB0eXBlOiBcImJhY2tkcm9wLnNldFwiOyBiYWNrZHJvcDogQmFja2Ryb3AgfSAvLyBhbWJpZW50IHByZXZpZXcgYmFja2Ryb3BcbiAgfCB7IHR5cGU6IFwicGhhc2UuYWR2YW5jZVwiIH0gLy8gc2VhbCB0aGUgYWN0aXZlIHBoYXNlLCBtb3ZlIHRoZSBjdXJzb3IgdG8gdGhlIG5leHQgKGltcGVyYXRpdmUgaGFuZC1vZmYpXG4gIHwgeyB0eXBlOiBcInBoYXNlLnNldFwiOyBwaGFzZTogUGhhc2VLZXkgfSAvLyBiYWNrLW5hdiAvIGp1bXAgdG8gYSBwaGFzZSAoYW1iaWVudClcbiAgfCB7IHR5cGU6IFwiZXhwb3J0XCI7IGlkcz86IHN0cmluZ1tdIH0gLy8gYnVpbGQgdGhlIGRvd25sb2FkYWJsZSBhc3NldCBidW5kbGUgKGNob3NlbiB2ZXJzaW9ucyBvZiB0aGVzZSAvIGFsbCBub24tZHJvcHBlZClcbiAgfCB7IHR5cGU6IFwic3VibWl0XCIgfVxuICB8IHsgdHlwZTogXCJjYW5jZWxcIiB9O1xuXG4vLyDilIDilIAgQWdlbnQg4oaSIHNlcnZlciAoUE9TVCAvY21kKS4gVGhlIGFnZW50IGRyaXZlcyB0aGUgZGFlbW9uIHdpdGggZXhhY3RseSB0aGVzZS4g4pSA4pSAXG5leHBvcnQgdHlwZSBBZ2VudENvbW1hbmQgPVxuICB8IHsgdHlwZTogXCJpbml0XCI7IHRpdGxlPzogc3RyaW5nOyBpbnRlbnQ/OiBzdHJpbmcgfVxuICB8IHtcbiAgICAgIHR5cGU6IFwic2F5XCI7XG4gICAgICB0ZXh0OiBzdHJpbmc7XG4gICAgICBhY3Rpb24/OiB7IGxhYmVsOiBzdHJpbmc7IGNvbW1hbmQ6IENsaWVudFRvU2VydmVyIH07XG4gICAgfSAvLyBwb3N0IGFnZW50IGRpYWxvZ3VlIChraW5kOlwidGV4dFwiKTsgb3B0aW9uYWwgaW5saW5lIENUQSBzaG9ydGN1dFxuICB8IHsgdHlwZTogXCJhc2tcIjsgdGV4dDogc3RyaW5nOyBvcHRpb25zPzogc3RyaW5nW10gfSAvLyBwb3N0IGFuIGluLXRocmVhZCBxdWVzdGlvblxuICB8IHsgdHlwZTogXCJzb3VyY2Uuc2V0XCI7IHBhdGg6IHN0cmluZzsgc2l6ZTogW251bWJlciwgbnVtYmVyXTsgc2hhOiBzdHJpbmcgfSAvLyB0aGUgY29tcG9zaXRlIHVuZGVyIHJldmlld1xuICB8IHsgdHlwZTogXCJlbGVtZW50cy5zZXRcIjsgZWxlbWVudHM6IEVsZW1lbnRbXSB9IC8vIHBvc3QgdGhlIGRpc2NvdmVyZWQgYnJlYWtkb3duXG4gIHwgeyB0eXBlOiBcImVsZW1lbnQuYWRkXCI7IGVsZW1lbnQ6IE5ld0VsZW1lbnQgfSAvLyBhZ2VudCBib3hlcyBhIHJlZ2lvbiBpbmNyZW1lbnRhbGx5XG4gIHwgeyB0eXBlOiBcImVsZW1lbnQudXBkYXRlXCI7IGlkOiBzdHJpbmc7IHBhdGNoOiBQYXJ0aWFsPEVsZW1lbnQ+IH0gLy8gbW92ZS9yZXNpemUvcmVuYW1lL3JldHlwZSAodmVyc2lvbnMgYXBwZW5kIHZpYSBlbGVtZW50LmFkZFZlcnNpb24pXG4gIHwgeyB0eXBlOiBcImVsZW1lbnQucmVtb3ZlXCI7IGlkOiBzdHJpbmcgfSAvLyBhZ2VudCByZXRyYWN0cyBhIGJveFxuICB8IHsgdHlwZTogXCJlbGVtZW50LmFkZFZlcnNpb25cIjsgaWQ6IHN0cmluZzsgdmVyc2lvbjogRWxlbWVudFZlcnNpb247IGNob29zZT86IGJvb2xlYW4gfSAvLyBhZ2VudCBhcHBlbmRzIGEgcHJvZHVjZWQgdmVyc2lvblxuICB8IHsgdHlwZTogXCJwaGFzZS5zZXRcIjsgcGhhc2U6IFBoYXNlS2V5IH0gLy8gYWdlbnQgYWR2YW5jZXMvbW92ZXMgdGhlIGN1cnNvciBvbiB0aGUgdXNlcidzIGNvbnZlcnNhdGlvbmFsIHJlcXVlc3RcbiAgfCB7IHR5cGU6IFwiYnVuZGxlLnNldFwiOyBuYW1lOiBzdHJpbmc7IGNvdW50OiBudW1iZXIgfSAvLyBhZ2VudCBwb3N0cyB0aGUgYnVpbHQgZXhwb3J0IGJ1bmRsZSAoc2VydmVkIHZpYSAvYXNzZXRzLzxuYW1lPilcbiAgfCB7IHR5cGU6IFwic3RhdHVzXCI7IGJ1c3k6IGJvb2xlYW47IHRleHQ/OiBzdHJpbmcgfVxuICB8IHsgdHlwZTogXCJjbG9zZVwiIH07XG5cbi8vIFRoZSBhZ2VudCBldmVudCBzZXQgKHNlcnZlciDihpIgYWdlbnQgU1NFKSDigJQgSU1QRVJBVElWRVMgT05MWTogdGhlIG1vdmVzIHdoZXJlXG4vLyB0aGUgdXNlciAqaGFuZHMgd29yayB0byB0aGUgYWdlbnQqLCBwbHVzIGxpZmVjeWNsZS4gQW1iaWVudCBlZGl0aW5nIG9mIHRoZVxuLy8gYnJlYWtkb3duIGlzIGRlbGliZXJhdGVseSBOT1QgaGVyZSDigJQgYm94IG1vdmUvcmVzaXplL3JlbmFtZS9yZXR5cGVcbi8vIChlbGVtZW50LnVwZGF0ZSksIGRyYXcgKGVsZW1lbnQuYWRkKSwgZGVsZXRlIChlbGVtZW50LnJlbW92ZSksIGNvbmZpcm0vZHJvcFxuLy8gKGVsZW1lbnQuanVkZ2UpLCByZS1ydW4gZmxhZyAoZWxlbWVudC5mbGFnKSwgdmVyc2lvbiBwaWNrICh2ZXJzaW9uLmNob29zZSksIGFuZFxuLy8gYmFja2Ryb3AgYXJlIGFsbCByZWFjaGFibGUgZnJvbSAvc3RhdGUsIHdoaWNoIHRoZSBhZ2VudCByZWFkcyBhdCB0aGUgbW9tZW50IGFuXG4vLyBpbXBlcmF0aXZlIGZpcmVzLiBQdXNoaW5nIGVhY2ggZWRpdCB3b3VsZCBqdXN0IG5hcnJhdGUgdGhlIHVzZXIncyBidXN5IHdvcmsuXG4vLyBUaGUgaW1wZXJhdGl2ZXM6IGBzYXlgLCBgc291cmNlLmFkZGVkYCAo4oaSIGRpc2NvdmVyKSwgYGV4dHJhY3RgICjihpIgY3V0IHRoZVxuLy8gY3VycmVudCBib3hlcyksIGByZW1vdmVCZ2AgKOKGkiByZW1vdmUgYmFja2dyb3VuZHMsIGFnZW50IHBpY2tzIHRoZSBtb2RlbCksXG4vLyBgcmV0cnlSZW1vdmFsYCAo4oaSIHRyeSBhIGRpZmZlcmVudCByZW1vdmFsLCBhZ2VudCBwaWNrcyBhbiB1bnVzZWQgbW9kZWwpLFxuLy8gYHBoYXNlLmFkdmFuY2VgICjihpIgdXNlciBzZWFsZWQgYSBwaGFzZTsgYSBoYW5kLW9mZiB0byB0aGUgbmV4dCBsZWcpLFxuLy8gYHBoYXNlLnNldGAgKOKGkiB1c2VyIHN0ZXBwZWQgQkFDSyB0byBhIHBoYXNlIOKAlCBub3QgYW4gYWN0aW9uIHRvIHRha2UsIGJ1dFxuLy8gY29udGV4dCBmb3Igd2hhdCdzIGNvbWluZywgZS5nLiByZS1jdXRzKSwgYHN1Ym1pdGAsICsgbGlmZWN5Y2xlLiBBIHBoYXNlIHN3aXRjaFxuLy8gaXMgYSBkZWxpYmVyYXRlIHJlbG9jYXRpb24sIE5PVCBhbWJpZW50IGVkaXRpbmcg4oCUIHNvIGJvdGggZGlyZWN0aW9ucyBhcmUgcHVzaGVkLlxuZXhwb3J0IGNvbnN0IEFHRU5UX0VWRU5UX1RZUEVTID0gT2JqZWN0LmZyZWV6ZShbXG4gIFwicmVhZHlcIixcbiAgXCJjb25uZWN0ZWRcIixcbiAgXCJkaXNjb25uZWN0ZWRcIixcbiAgXCJzYXlcIixcbiAgXCJzb3VyY2UuYWRkZWRcIiwgLy8gdXNlciBkcm9wcGVkIGEgY29tcG9zaXRlIOKAlCB0aGUgYWdlbnQgcnVucyBkaXNjb3ZlciBvbiBpdFxuICBcImV4dHJhY3RcIiwgLy8gdXNlciBhc2tlZCB0byAocmUtKWN1dCDigJQgdGhlIGFnZW50IHJlYWRzIHRoZSBib3hlcyBmcm9tIC9zdGF0ZVxuICBcInJlbW92ZUJnXCIsIC8vIHVzZXIgYXNrZWQgdG8gcmVtb3ZlIGJhY2tncm91bmRzIOKAlCB0aGUgYWdlbnQgcGlja3MgdGhlIG1vZGVsXG4gIFwicmV0cnlSZW1vdmFsXCIsIC8vIHVzZXIgYXNrZWQgdG8gdHJ5IGEgZGlmZmVyZW50IHJlbW92YWwg4oCUIHRoZSBhZ2VudCBwaWNrcyBhbiBVTlVTRUQgbW9kZWxcbiAgXCJwaGFzZS5hZHZhbmNlXCIsIC8vIHVzZXIgc2VhbGVkIHRoZSBhY3RpdmUgcGhhc2Ug4oCUIGEgaGFuZC1vZmYgdG8gdGhlIG5leHQgbGVnIG9mIHdvcmtcbiAgXCJwaGFzZS5zZXRcIiwgLy8gdXNlciBzdGVwcGVkIEJBQ0sgdG8gYSBwaGFzZSDigJQgY29udGV4dCAocmUtY3V0cyBsaWtlbHkpLCBubyBhY3Rpb24gcmVxdWlyZWRcbiAgXCJleHBvcnRcIiwgLy8gdXNlciBhc2tlZCB0byBidWlsZCB0aGUgZG93bmxvYWRhYmxlIGFzc2V0IGJ1bmRsZSDigJQgdGhlIGFnZW50IHppcHMgaXRcbiAgXCJzdWJtaXRcIixcbiAgXCJjbG9zZWRcIixcbl0gYXMgY29uc3QpO1xuZXhwb3J0IHR5cGUgQWdlbnRFdmVudFR5cGUgPSAodHlwZW9mIEFHRU5UX0VWRU5UX1RZUEVTKVtudW1iZXJdO1xuXG4vLyBUeXBlZCBwYXlsb2FkcyBmb3IgdGhlIGV2ZW50cyB0aGF0IGNhcnJ5IGRhdGEuXG5leHBvcnQgdHlwZSBBZ2VudEV2ZW50UGF5bG9hZCA9IHtcbiAgc2F5OiB7IHRleHQ6IHN0cmluZyB9O1xuICBcInNvdXJjZS5hZGRlZFwiOiB7IHBhdGg6IHN0cmluZzsgc2l6ZTogW251bWJlciwgbnVtYmVyXTsgc2hhOiBzdHJpbmcgfTtcbiAgZXh0cmFjdDogeyBpZHM/OiBzdHJpbmdbXSB9OyAvLyB3aGljaCBlbGVtZW50cyB0byAocmUtKWN1dDsgYWJzZW50IOKGkiBhbGwgY29uZmlybWVkXG4gIHJlbW92ZUJnOiB7IGlkcz86IHN0cmluZ1tdIH07IC8vIHdoaWNoIGVsZW1lbnRzIHRvIHJlbW92ZSBiZyBmb3I7IGFic2VudCDihpIgYWxsIGVsaWdpYmxlXG4gIHJldHJ5UmVtb3ZhbDogeyBpZHM6IHN0cmluZ1tdIH07IC8vIHdoaWNoIChmbGFnZ2VkKSBlbGVtZW50cyB0byByZS1yZW1vdmU7IG1vZGVsIGlzIHRoZSBhZ2VudCdzIGNhbGxcbiAgXCJwaGFzZS5hZHZhbmNlXCI6IHsgcGhhc2U6IFBoYXNlS2V5IH07IC8vIHRoZSBORVcgcGhhc2UgdGhlIHVzZXIgYWR2YW5jZWQgdG9cbiAgXCJwaGFzZS5zZXRcIjogeyBwaGFzZTogUGhhc2VLZXkgfTsgLy8gdGhlIHBoYXNlIHRoZSB1c2VyIHN0ZXBwZWQgYmFjayB0b1xuICBleHBvcnQ6IHsgaWRzPzogc3RyaW5nW10gfTsgLy8gd2hpY2ggZWxlbWVudHMgdG8gYnVuZGxlIChhYnNlbnQg4oaSIGFsbCBub24tZHJvcHBlZClcbn07XG4iLAogICAgIi8vIHNjcmlwdHMvcmVkdWNlLnRzXG4vLyBQdXJlLCBpbi1wbGFjZSBtdXRhdG9ycyBvdmVyIE1hZ3BpZVN0YXRlICsgdGhlIGxlYW4gcHJvamVjdGlvbi4gVGhlIGRhZW1vblxuLy8gKHNlcnZlci50cykgb3JjaGVzdHJhdGVzIHRoZXNlIChpdCBvd25zIGlkcywgYnJvYWRjYXN0LCBTU0UpOyB0aGVzZSBmdW5jdGlvbnNcbi8vIGp1c3QgbXV0YXRlIGNhbm9uaWNhbCBzdGF0ZSBhbmQgcmVwb3J0IHdoZXRoZXIgYW55dGhpbmcgY2hhbmdlZCwgc28gdGhleSdyZVxuLy8gdW5pdC10ZXN0YWJsZSB3aXRoIG5vIHN1YnByb2Nlc3MuIEtlZXAgdGhlbSBUSElOIOKAlCB0aGUgbWFncGllLXNwZWNpZmljIHJldmlld1xuLy8gbWFjaGluZXJ5IChqdWRnbWVudCwgY3V0b3V0cykgaXMgbW9ja2VkIG91dCBmb3Igbm93OyB3aWRlbiB0aGVzZSBhcyBpdCBsYW5kcy5cblxuaW1wb3J0IHtcbiAgdHlwZSBCYWNrZHJvcCxcbiAgdHlwZSBFbGVtZW50LFxuICB0eXBlIEVsZW1lbnRTdGF0dXMsXG4gIHR5cGUgRWxlbWVudFZlcnNpb24sXG4gIHR5cGUgTWFncGllU3RhdGUsXG4gIHR5cGUgTWVzc2FnZSxcbiAgdHlwZSBOZXdFbGVtZW50LFxuICBQSEFTRVMsXG4gIHR5cGUgUGhhc2VLZXksXG4gIHR5cGUgU291cmNlLFxufSBmcm9tIFwiLi4vc2hhcmVkL3R5cGVzXCI7XG5cbi8vIOKUgOKUgCBpZCBoZWxwZXJzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuZnVuY3Rpb24gcmFuZEhleChieXRlczogbnVtYmVyKTogc3RyaW5nIHtcbiAgY29uc3QgYnVmID0gbmV3IFVpbnQ4QXJyYXkoYnl0ZXMpO1xuICBjcnlwdG8uZ2V0UmFuZG9tVmFsdWVzKGJ1Zik7XG4gIHJldHVybiBBcnJheS5mcm9tKGJ1ZiwgKGIpID0+IGIudG9TdHJpbmcoMTYpLnBhZFN0YXJ0KDIsIFwiMFwiKSkuam9pbihcIlwiKTtcbn1cbmV4cG9ydCBmdW5jdGlvbiBuZXdJZChwcmVmaXg6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtwcmVmaXh9LSR7cmFuZEhleCg0KX1gO1xufVxuXG4vLyDilIDilIAgbXV0YXRvcnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmV4cG9ydCBmdW5jdGlvbiBwdXNoTWVzc2FnZShcbiAgczogTWFncGllU3RhdGUsXG4gIG06IE9taXQ8TWVzc2FnZSwgXCJpZFwiIHwgXCJ0c1wiPiAmIHsgaWQ/OiBzdHJpbmcgfSxcbik6IE1lc3NhZ2Uge1xuICBjb25zdCBtc2c6IE1lc3NhZ2UgPSB7IGlkOiBtLmlkID8/IG5ld0lkKFwibVwiKSwgdHM6IERhdGUubm93KCksIC4uLm0gfSBhcyBNZXNzYWdlO1xuICBzLmNvbnZlcnNhdGlvbi5wdXNoKG1zZyk7XG4gIHJldHVybiBtc2c7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRTdGF0dXMoczogTWFncGllU3RhdGUsIGJ1c3k6IGJvb2xlYW4sIHRleHQgPSBcIlwiKTogdm9pZCB7XG4gIHMuc3RhdHVzID0geyBidXN5LCB0ZXh0IH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRJbnRlbnQoczogTWFncGllU3RhdGUsIGludGVudDogc3RyaW5nKTogdm9pZCB7XG4gIHMuaW50ZW50ID0gaW50ZW50O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2V0U291cmNlKHM6IE1hZ3BpZVN0YXRlLCBzb3VyY2U6IFNvdXJjZSk6IHZvaWQge1xuICBzLnNvdXJjZSA9IHNvdXJjZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNldEVsZW1lbnRzKHM6IE1hZ3BpZVN0YXRlLCBlbGVtZW50czogRWxlbWVudFtdKTogdm9pZCB7XG4gIC8vIFRydXN0IHRoZSBhZ2VudCdzIGRpc2NvdmVyZWQgYnJlYWtkb3duIHdob2xlc2FsZTsgZGVmYXVsdCBhbnkgbWlzc2luZ1xuICAvLyBzdGF0dXMgdG8gXCJwcm9wb3NlZFwiIHNvIHRoZSBzdXJmYWNlIGFsd2F5cyBoYXMgYSBqdWRnZWFibGUgZWxlbWVudCwgYW5kXG4gIC8vIChkZWZlbnNpdmVseSkgbWludCBhbiBpZCBmb3IgYW55IGVsZW1lbnQgcG9zdGVkIHdpdGhvdXQgb25lIOKAlCBkaXNjb3ZlclxuICAvLyBhc3NpZ25zIGlkcywgYnV0IGEgaGFuZC1yb2xsZWQgYGVsZW1lbnRzLnNldGAgYm9keSBtaWdodCBub3QuXG4gIHMuZWxlbWVudHMgPSBlbGVtZW50cy5tYXAoKGUpID0+ICh7XG4gICAgLi4uZSxcbiAgICBpZDogZS5pZCB8fCBuZXdJZChcImVcIiksXG4gICAgc3RhdHVzOiBlLnN0YXR1cyA/PyBcInByb3Bvc2VkXCIsXG4gIH0pKTtcbn1cblxuLy8gRGVmYXVsdCBuYW1lIGZvciBhbiB1bm5hbWVkIGRyYXduIHJlZ2lvbjogcmVnaW9uXzxuPiwgd2hlcmUgbiBpcyBvbmUgcGFzdCB0aGVcbi8vIGNvdW50IG9mIGV4aXN0aW5nIHJlZ2lvbl9cXGQrIG5hbWVzIChzbyBhIGRlbGV0ZS10aGVuLWRyYXcgZG9lc24ndCBjb2xsaWRlIHdpdGhcbi8vIGEgbGl2ZSBvbmUg4oCUIGl0IG51bWJlcnMgb2ZmIHRoZSBjdXJyZW50IHBvcHVsYXRpb24sIHRoZSBjaGVhcCBob3VzZSBoZXVyaXN0aWMpLlxuY29uc3QgUkVHSU9OX1JFID0gL15yZWdpb25fXFxkKyQvO1xuZnVuY3Rpb24gbmV4dFJlZ2lvbk5hbWUoczogTWFncGllU3RhdGUpOiBzdHJpbmcge1xuICBjb25zdCBuID0gcy5lbGVtZW50cy5maWx0ZXIoKGUpID0+IFJFR0lPTl9SRS50ZXN0KGUubmFtZSkpLmxlbmd0aCArIDE7XG4gIHJldHVybiBgcmVnaW9uXyR7bn1gO1xufVxuXG4vLyBBZGQgYSB1c2VyLWRyYXduIChvciBhZ2VudC1ib3hlZCkgcmVnaW9uOiBtaW50IGFuIGlkLCBkZWZhdWx0IG5hbWUvdHlwZS9zdGF0dXMuXG4vLyBSZXR1cm5zIHRoZSBtYXRlcmlhbGl6ZWQgRWxlbWVudCAodGhlIGRhZW1vbiBlbWl0cyBpdCBvbiB0aGUgU1NFL2Jyb2FkY2FzdCkuXG5leHBvcnQgZnVuY3Rpb24gYWRkRWxlbWVudChzOiBNYWdwaWVTdGF0ZSwgZHJhZnQ6IE5ld0VsZW1lbnQpOiBFbGVtZW50IHtcbiAgY29uc3QgZWw6IEVsZW1lbnQgPSB7XG4gICAgaWQ6IG5ld0lkKFwiZVwiKSxcbiAgICBuYW1lOiBkcmFmdC5uYW1lIHx8IG5leHRSZWdpb25OYW1lKHMpLFxuICAgIHR5cGU6IGRyYWZ0LnR5cGUgPz8gXCJvdGhlclwiLFxuICAgIGJib3g6IGRyYWZ0LmJib3gsXG4gICAgc3RhdHVzOiBkcmFmdC5zdGF0dXMgPz8gXCJjb25maXJtZWRcIixcbiAgfTtcbiAgcy5lbGVtZW50cy5wdXNoKGVsKTtcbiAgcmV0dXJuIGVsO1xufVxuXG4vLyBIYXJkLWRlbGV0ZSBhbiBlbGVtZW50IGJ5IGlkIChhIHVzZXIgcmV0cmFjdGluZyBhIGRyYXduIGJveCkuIFJldHVybnMgd2hldGhlclxuLy8gaXQgZXhpc3RlZC5cbmV4cG9ydCBmdW5jdGlvbiByZW1vdmVFbGVtZW50KHM6IE1hZ3BpZVN0YXRlLCBpZDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGkgPSBzLmVsZW1lbnRzLmZpbmRJbmRleCgoZSkgPT4gZS5pZCA9PT0gaWQpO1xuICBpZiAoaSA8IDApIHJldHVybiBmYWxzZTtcbiAgcy5lbGVtZW50cy5zcGxpY2UoaSwgMSk7XG4gIHJldHVybiB0cnVlO1xufVxuXG4vLyBQYXJ0aWFsLW1lcmdlIGFuIGVsZW1lbnQgKHRoZSBhZ2VudCBwb3N0aW5nIG5hbWUvdHlwZS9iYm94L3N0YXR1cyBlZGl0cyBsYW5kc1xuLy8gaGVyZSkuIE5ldmVyIGxldHMgYGlkYCBiZSBvdmVyd3JpdHRlbi4gUmV0dXJucyB0cnVlIGlmIHRoZSBlbGVtZW50IGV4aXN0ZWQuXG4vLyBWZXJzaW9uIHJlc3VsdHMgZG8gTk9UIGZsb3cgdGhyb3VnaCBoZXJlIOKAlCB0aGV5IGFwcGVuZCB2aWEgYWRkVmVyc2lvbiAoYSBsaXN0XG4vLyBvcCwgbm90IGEgZmllbGQgbWVyZ2UpLlxuZXhwb3J0IGZ1bmN0aW9uIHVwZGF0ZUVsZW1lbnQoczogTWFncGllU3RhdGUsIGlkOiBzdHJpbmcsIHBhdGNoOiBQYXJ0aWFsPEVsZW1lbnQ+KTogYm9vbGVhbiB7XG4gIGNvbnN0IGVsID0gcy5lbGVtZW50cy5maW5kKChlKSA9PiBlLmlkID09PSBpZCk7XG4gIGlmICghZWwpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgeyBpZDogX2Ryb3AsIC4uLnJlc3QgfSA9IHBhdGNoO1xuICBPYmplY3QuYXNzaWduKGVsLCByZXN0KTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmNvbnN0IEVMRU1FTlRfU1RBVFVTRVM6IHJlYWRvbmx5IEVsZW1lbnRTdGF0dXNbXSA9IFtcInByb3Bvc2VkXCIsIFwiY29uZmlybWVkXCIsIFwiZHJvcHBlZFwiXTtcblxuZXhwb3J0IGZ1bmN0aW9uIGp1ZGdlRWxlbWVudChzOiBNYWdwaWVTdGF0ZSwgaWQ6IHN0cmluZywgc3RhdHVzOiBFbGVtZW50U3RhdHVzKTogYm9vbGVhbiB7XG4gIGlmICghRUxFTUVOVF9TVEFUVVNFUy5pbmNsdWRlcyhzdGF0dXMpKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGVsID0gcy5lbGVtZW50cy5maW5kKChlKSA9PiBlLmlkID09PSBpZCk7XG4gIGlmICghZWwgfHwgZWwuc3RhdHVzID09PSBzdGF0dXMpIHJldHVybiBmYWxzZTtcbiAgZWwuc3RhdHVzID0gc3RhdHVzO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuLy8gRmxhZyAob3IgdW5mbGFnKSBhbiBlbGVtZW50IGZvciBhIHJlLXJ1biDigJQgdGhlIHNvbGUgcmV2aWV3IHNpZ25hbC4gQXBwcm92YWwgaXNcbi8vIHRoZSBhYnNlbmNlIG9mIGEgZmxhZzsgZGlzY2FyZGluZyBpcyBzdGF0dXM6XCJkcm9wcGVkXCIuIFJldHVybnMgd2hldGhlciB0aGUgZmxhZ1xuLy8gYWN0dWFsbHkgY2hhbmdlZCAodGhlIGRhZW1vbiBvbmx5IGJyb2FkY2FzdHMgb24gYSBjaGFuZ2UpLlxuZXhwb3J0IGZ1bmN0aW9uIGZsYWdFbGVtZW50KHM6IE1hZ3BpZVN0YXRlLCBpZDogc3RyaW5nLCBmbGFnZ2VkOiBib29sZWFuKTogYm9vbGVhbiB7XG4gIGNvbnN0IGVsID0gcy5lbGVtZW50cy5maW5kKChlKSA9PiBlLmlkID09PSBpZCk7XG4gIGlmICghZWwpIHJldHVybiBmYWxzZTtcbiAgaWYgKChlbC5mbGFnZ2VkID8/IGZhbHNlKSA9PT0gZmxhZ2dlZCkgcmV0dXJuIGZhbHNlO1xuICBlbC5mbGFnZ2VkID0gZmxhZ2dlZDtcbiAgcmV0dXJuIHRydWU7XG59XG5cbi8vIEFwcGVuZCBhIHByb2R1Y2VkIHZlcnNpb24sIFVQU0VSVElORyBieSBtb2RlbDogcmUtcnVubmluZyB0aGUgc2FtZSBtb2RlbFxuLy8gb3ZlcndyaXRlcyBpdHMgcGF0aCArIGJ1bXBzIHJldiAoY2FjaGUtYnVzdCkgYW5kIGtlZXBzIHRoZSBzdGFibGUgaWQ7IGEgbmV3XG4vLyBtb2RlbCBhcHBlbmRzIGEgcm93LiBBIGZyZXNoIHJlc3VsdCBjbGVhcnMgYGZsYWdnZWRgICh0aGUgcmVxdWVzdCBpcyBmdWxmaWxsZWQpXG4vLyBhbmQg4oCUIHVubGVzcyB7IGNob29zZTpmYWxzZSB9IOKAlCBiZWNvbWVzIHRoZSBjaG9zZW4gdmVyc2lvbi4gUmV0dXJucyB0aGUgc3RvcmVkXG4vLyB2ZXJzaW9uLCBvciBudWxsIGlmIHRoZSBlbGVtZW50IGlzIGdvbmUuXG5leHBvcnQgZnVuY3Rpb24gYWRkVmVyc2lvbihcbiAgczogTWFncGllU3RhdGUsXG4gIGlkOiBzdHJpbmcsXG4gIHY6IEVsZW1lbnRWZXJzaW9uLFxuICBvcHRzOiB7IGNob29zZT86IGJvb2xlYW4gfSA9IHt9LFxuKTogRWxlbWVudFZlcnNpb24gfCBudWxsIHtcbiAgY29uc3QgZWwgPSBzLmVsZW1lbnRzLmZpbmQoKGUpID0+IGUuaWQgPT09IGlkKTtcbiAgaWYgKCFlbCkgcmV0dXJuIG51bGw7XG4gIGlmICghZWwudmVyc2lvbnMpIGVsLnZlcnNpb25zID0gW107XG4gIGNvbnN0IGV4aXN0aW5nID0gZWwudmVyc2lvbnMuZmluZCgoeCkgPT4geC5tb2RlbCA9PT0gdi5tb2RlbCk7XG4gIGxldCBzdG9yZWQ6IEVsZW1lbnRWZXJzaW9uO1xuICBpZiAoZXhpc3RpbmcpIHtcbiAgICBleGlzdGluZy5wYXRoID0gdi5wYXRoO1xuICAgIGV4aXN0aW5nLnJldiA9IChleGlzdGluZy5yZXYgPz8gMCkgKyAxO1xuICAgIGlmICh2LmtpbmQgIT09IHVuZGVmaW5lZCkgZXhpc3Rpbmcua2luZCA9IHYua2luZDtcbiAgICBpZiAodi5ub3RlICE9PSB1bmRlZmluZWQpIGV4aXN0aW5nLm5vdGUgPSB2Lm5vdGU7XG4gICAgc3RvcmVkID0gZXhpc3Rpbmc7XG4gIH0gZWxzZSB7XG4gICAgc3RvcmVkID0geyAuLi52LCByZXY6IHYucmV2ID8/IDAgfTtcbiAgICBlbC52ZXJzaW9ucy5wdXNoKHN0b3JlZCk7XG4gIH1cbiAgaWYgKG9wdHMuY2hvb3NlID8/IHRydWUpIGVsLmNob3NlblZlcnNpb25JZCA9IHN0b3JlZC5pZDtcbiAgZWwuZmxhZ2dlZCA9IGZhbHNlO1xuICByZXR1cm4gc3RvcmVkO1xufVxuXG4vLyBUaGUgdXNlciBzZWxlY3RpbmcgYSB2ZXJzaW9uIOKGkiBpdCBiZWNvbWVzIGNob3NlbiAoYW1iaWVudCkuIFJldHVybnMgd2hldGhlciBpdFxuLy8gY2hhbmdlZDsgcmVqZWN0cyBhbiB1bmtub3duIGVsZW1lbnQgb3IgYSB2ZXJzaW9uSWQgbm90IHByZXNlbnQgb24gaXQuXG5leHBvcnQgZnVuY3Rpb24gY2hvb3NlVmVyc2lvbihzOiBNYWdwaWVTdGF0ZSwgaWQ6IHN0cmluZywgdmVyc2lvbklkOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3QgZWwgPSBzLmVsZW1lbnRzLmZpbmQoKGUpID0+IGUuaWQgPT09IGlkKTtcbiAgaWYgKCFlbCB8fCAhKGVsLnZlcnNpb25zID8/IFtdKS5zb21lKCh2KSA9PiB2LmlkID09PSB2ZXJzaW9uSWQpKSByZXR1cm4gZmFsc2U7XG4gIGlmIChlbC5jaG9zZW5WZXJzaW9uSWQgPT09IHZlcnNpb25JZCkgcmV0dXJuIGZhbHNlO1xuICBlbC5jaG9zZW5WZXJzaW9uSWQgPSB2ZXJzaW9uSWQ7XG4gIHJldHVybiB0cnVlO1xufVxuXG5jb25zdCBCQUNLRFJPUFM6IHJlYWRvbmx5IEJhY2tkcm9wW10gPSBbXCJ3aGl0ZVwiLCBcImdyYXlcIiwgXCJibGFja1wiLCBcInRyYW5zcGFyZW50XCJdO1xuXG5leHBvcnQgZnVuY3Rpb24gc2V0QmFja2Ryb3AoczogTWFncGllU3RhdGUsIGJhY2tkcm9wOiBCYWNrZHJvcCk6IGJvb2xlYW4ge1xuICBpZiAoIUJBQ0tEUk9QUy5pbmNsdWRlcyhiYWNrZHJvcCkgfHwgcy5iYWNrZHJvcCA9PT0gYmFja2Ryb3ApIHJldHVybiBmYWxzZTtcbiAgcy5iYWNrZHJvcCA9IGJhY2tkcm9wO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuLy8g4pSA4pSAIHBoYXNlIHNwaW5lIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4vLyBBZHZhbmNlIHRoZSBsaW5lYXIgcGhhc2UgY3Vyc29yIHRvIHRoZSBuZXh0IHBoYXNlIOKAlCB3aGF0IHRoZSBzZWFsLWFuZC1oYW5kLW9mZlxuLy8gZ2F0ZSBmaXJlcy4gUmV0dXJucyB0aGUgbmV3IHBoYXNlLCBvciBudWxsIGlmIGFscmVhZHkgYXQgdGhlIGxhc3QgKG5vLW9wKS5cbmV4cG9ydCBmdW5jdGlvbiBhZHZhbmNlUGhhc2UoczogTWFncGllU3RhdGUpOiBQaGFzZUtleSB8IG51bGwge1xuICBjb25zdCBpID0gUEhBU0VTLmluZGV4T2Yocy5waGFzZSk7XG4gIGlmIChpIDwgMCB8fCBpID49IFBIQVNFUy5sZW5ndGggLSAxKSByZXR1cm4gbnVsbDtcbiAgcy5waGFzZSA9IFBIQVNFU1tpICsgMV07XG4gIHJldHVybiBzLnBoYXNlO1xufVxuXG4vLyBTZXQgdGhlIHBoYXNlIGN1cnNvciBkaXJlY3RseSAoYmFjay1uYXYgLyBqdW1wKS4gVmFsaWRhdGVzIGFnYWluc3QgUEhBU0VTO1xuLy8gcmVwb3J0cyB3aGV0aGVyIGl0IGNoYW5nZWQuXG5leHBvcnQgZnVuY3Rpb24gc2V0UGhhc2UoczogTWFncGllU3RhdGUsIHBoYXNlOiBQaGFzZUtleSk6IGJvb2xlYW4ge1xuICBpZiAoIVBIQVNFUy5pbmNsdWRlcyhwaGFzZSkgfHwgcy5waGFzZSA9PT0gcGhhc2UpIHJldHVybiBmYWxzZTtcbiAgcy5waGFzZSA9IHBoYXNlO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuLy8gUmVjb3JkIHRoZSBidWlsdCBleHBvcnQgYnVuZGxlICh0aGUgYWdlbnQgcG9zdHMgaXQgYWZ0ZXIgemlwcGluZykuIFRoZSBzdXJmYWNlXG4vLyBvZmZlcnMgaXQgYXMgYSBkb3dubG9hZCB2aWEgL2Fzc2V0cy88bmFtZT4uXG5leHBvcnQgZnVuY3Rpb24gc2V0QnVuZGxlKHM6IE1hZ3BpZVN0YXRlLCBuYW1lOiBzdHJpbmcsIGNvdW50OiBudW1iZXIpOiB2b2lkIHtcbiAgcy5idW5kbGUgPSB7IG5hbWUsIGNvdW50IH07XG59XG5cbi8vIOKUgOKUgCBsZWFuIHByb2plY3Rpb24g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vLyBTdHJpcCBhbnkgKGV2ZW50dWFsbHkgaGVhdnkpIGlubGluZWQgYmxvYnMgZnJvbSB0aGUgYWdlbnQtZmFjaW5nIC9zdGF0ZSBzbyB0aGVcbi8vIHNuYXBzaG90IHN0YXlzIHNtYWxsOyB0aGUgYWdlbnQgcmVhZHMgb24tZGlzayB2ZXJzaW9uIHBhdGhzIGluc3RlYWQuIFZlcnNpb25zXG4vLyBjYXJyeSBvbmx5IGBwYXRoYCAobm90IGlubGluZWQgaW1hZ2UgZGF0YSksIHNvIHRoaXMgaXMgbmVhci1pZGVudGl0eSDigJQgYnV0IGl0XG4vLyBkZWZlbnNpdmVseSBkcm9wcyBhbnkgYHNyY2AvYGN1dG91dHNgIGZpZWxkcyBhbiBlbGVtZW50IG1pZ2h0IGlubGluZSwgYW5kIG5ldmVyXG4vLyBtdXRhdGVzIHRoZSBzb3VyY2Ugc3RhdGUuXG5leHBvcnQgZnVuY3Rpb24gbGVhblN0YXRlKHM6IE1hZ3BpZVN0YXRlKTogTWFncGllU3RhdGUge1xuICByZXR1cm4ge1xuICAgIC4uLnMsXG4gICAgZWxlbWVudHM6IHMuZWxlbWVudHMubWFwKChlKSA9PiB7XG4gICAgICBjb25zdCBsZWFuID0geyAuLi5lIH0gYXMgRWxlbWVudCAmIHsgc3JjPzogdW5rbm93bjsgY3V0b3V0cz86IHVua25vd24gfTtcbiAgICAgIGRlbGV0ZSBsZWFuLnNyYztcbiAgICAgIGRlbGV0ZSBsZWFuLmN1dG91dHM7XG4gICAgICByZXR1cm4gbGVhbjtcbiAgICB9KSxcbiAgfTtcbn1cbiIsCiAgICAiLy8gc2hhcmVkL3ZlcnNpb25zLnRzXG4vLyBQdXJlIHZlcnNpb24gaGVscGVycyBzaGFyZWQgYnkgdGhlIGJhY2tlbmQgQ0xJIChzcmMvbWFncGllL2JhY2tlbmQvY2xpLnRzLFxuLy8gd2hpY2ggcmVhZHMgY2hvc2VuVmVyc2lvbiBmb3IgZXhwb3J0KSBBTkQgdGhlIFJlYWN0IGNsaWVudCAoTWFncGllU2hlbGwsXG4vLyBFeHBvcnRWaWV3LCBSZW1vdmVHYWxsZXJ5KS4gc2VydmVyLnRzIGRvZXMgTk9UIGltcG9ydCB0aGVtIOKAlCB0aGUgZGFlbW9uLXNpZGVcbi8vIGNvbnN1bWVyIGlzIHRoZSBDTEksIGFuZCB0aGF0IGlzIHdoYXQgbWFrZXMgdGhpcyB0d28tc2lkZWQuIE5vIG5vZGU6KiDigJQga2VlcFxuLy8gYnJvd3Nlci1zYWZlLiBBbiBlbGVtZW50J3MgcHJvZHVjZWQgYXNzZXRzIGFyZSBhIG1vZGVsLXRhZ2dlZCBsaXN0ICh2ZXJzaW9uc1tdKTtcbi8vIHRoZXNlIHJlc29sdmUgXCJ3aGljaCBvbmUgaXMgc2hvd25cIiBhbmQgXCJpdHMgY2FjaGUtYnVzdGVkIFVSTFwiLlxuXG5pbXBvcnQgdHlwZSB7IEVsZW1lbnQsIEVsZW1lbnRWZXJzaW9uIH0gZnJvbSBcIi4vdHlwZXNcIjtcblxuLy8gVGhlIHZlcnNpb24gdGhlIHN1cmZhY2UgcmVuZGVyczogdGhlIGV4cGxpY2l0bHkgY2hvc2VuIG9uZSwgZWxzZSB0aGUgZmlyc3Rcbi8vICh0aGUgY3JvcCkuIFRvbGVyYXRlcyBhbiBhYnNlbnQvZW1wdHkgbGlzdCBhbmQgYSBzdGFsZSBjaG9zZW5WZXJzaW9uSWQuXG5leHBvcnQgZnVuY3Rpb24gY2hvc2VuVmVyc2lvbihlbDogRWxlbWVudCk6IEVsZW1lbnRWZXJzaW9uIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgdnMgPSBlbC52ZXJzaW9ucyA/PyBbXTtcbiAgcmV0dXJuIHZzLmZpbmQoKHYpID0+IHYuaWQgPT09IGVsLmNob3NlblZlcnNpb25JZCkgPz8gdnNbMF07XG59XG5cbi8vIFRoZSAvYXNzZXRzIFVSTCBmb3IgYSB2ZXJzaW9uLCBjYWNoZS1idXN0ZWQgYnkgaXRzIHJldi4gQSByZS1ydW4gb3ZlcndyaXRlcyB0aGVcbi8vIGZpbGUgaW4gcGxhY2UsIHNvIHdpdGhvdXQgP3Y9PHJldj4gdGhlIGJyb3dzZXIgc2hvd3MgdGhlIHN0YWxlIGNhY2hlZCBpbWFnZS5cbmV4cG9ydCBmdW5jdGlvbiB2ZXJzaW9uVXJsKHY6IEVsZW1lbnRWZXJzaW9uKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAvYXNzZXRzLyR7di5wYXRoLnNwbGl0KFwiL1wiKS5wb3AoKX0/dj0ke3YucmV2ID8/IDB9YDtcbn1cbiIsCiAgICAiLyoqXG4gKiBUaGUgaG91c2UncyBvbmUtbGluZSBKU09OIGVtaXR0ZXIg4oCUIE9ORSBpbXBsZW1lbnRhdGlvbiwgaW1wb3J0ZWQgYnkgZXZlcnlcbiAqIHNwZWxsIHRoYXQgc3BlYWtzIHRoZSBhZ2VudCB3aXJlLlxuICpcbiAqIOKblCBUSElTIEZJTEUgSVMgYHNyYy9raXQvYCdzIEZJUlNUIElOSEFCSVRBTlQsIGFuZCB0aGF0IGlzIGxvYWQtYmVhcmluZyBiZXlvbmRcbiAqIHRoZSBzaGFyaW5nIGl0IGRvZXMuIFdhcmQgMiAoXCJ0aGUga2l0IGlzIGEgbGVhZlwiKSBoYXMgYmVlbiBncmVlbiBieVxuICogQ09OU1RSVUNUSU9OIHNpbmNlIFBoYXNlIDAg4oCUIGl0IGhhZCBub3RoaW5nIHRvIHdhbGssIGFuZCBzYWlkIHNvIG9uIGV2ZXJ5XG4gKiBydW4uIFRoaXMgbW9kdWxlIGlzIHRoZSBmaXJzdCB0aGluZyBpdCBhY3R1YWxseSBndWFyZHMsIHdoaWNoIGlzIHdoeSB0aGVcbiAqIHdhcmQncyB6ZXJvLWd1YXJkIGNlbGwgZGlzdGluZ3Vpc2hlcyBhbiBBQlNFTlQga2l0IGZyb20gYW4gRU1QVFkgb25lLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIG5vdCBhIHNwZWxsLFxuICogbm90IGEgc3VyZmFjZSwgbm90IGEgYmFja2VuZC4gVGhhdCBpcyB3YXJkIDIncyBhc3NlcnRpb24sIG5vdCBhIGNvbnZlbnRpb24sXG4gKiBhbmQgaXQgaXMgd2hhdCBtYWtlcyB0aGUga2l0IHNhZmUgdG8gaW5saW5lIGludG8gYW55IHNwZWxsJ3MgYnVuZGxlLlxuICpcbiAqIERlbGliZXJhdGVseSBkZXBlbmRlbmN5LWZyZWUgYW5kIGRlbGliZXJhdGVseSBkdWxsOiBpdCBpcyBidW5kbGVkIElOVE8gZWFjaFxuICogc3BlbGwncyBlbWl0dGVkIENMSSAoQ29udHJhY3QgNCdzIGJ1aWx0LWJhY2tlbmQgYW1lbmRtZW50KSwgc28gYW55dGhpbmcgaXRcbiAqIHJlYWNoZWQgZm9yIHdvdWxkIGJlY29tZSBhIGRlcGVuZGVuY3kgb2YgdHdvIHNoaXBwZWQgYXJ0aWZhY3RzIGF0IG9uY2UuXG4gKlxuICogVGhlIHdpcmUgY29udHJhY3QgaXQgZW5jb2RlczogZXhhY3RseSBvbmUgSlNPTiBkb2N1bWVudCwgb25lIHRyYWlsaW5nXG4gKiBuZXdsaW5lLCBub3RoaW5nIGVsc2Ugb24gc3Rkb3V0LiBBIGNhbGxlciByZWFkaW5nIG91ciBzdGRvdXQgd2l0aCBhXG4gKiBsaW5lLWRlbGltaXRlZCBwYXJzZXIgZGVwZW5kcyBvbiB0aGF0IG5ld2xpbmU7IGEgY2FsbGVyIHJlYWRpbmcgdG8gRU9GXG4gKiBkZXBlbmRzIG9uIHRoZXJlIGJlaW5nIG5vIHNlY29uZCBkb2N1bWVudC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByaW50SnNvbihkYXRhOiB1bmtub3duKTogdm9pZCB7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGRhdGEpfVxcbmApO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBDTEkgZmFpbHVyZSBjb250cmFjdCDigJQgdGhlIHRheG9ub215LCB0aGUgZXhpdCBjb2RlcywgdGhlXG4gKiBlbnZlbG9wZSwgYW5kIHRoZSBgZGllYCB0aGF0IHJhaXNlcyBvbmUuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgbm90IGEgY29udmVudGlvbiwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBpbmxpbmVcbiAqIGludG8gYW55IHNwZWxsJ3MgYnVuZGxlIChzZWUgYC4uL2xpYi9wcmludEpzb24udHNgLCB0aGUga2l0J3MgZmlyc3RcbiAqIGluaGFiaXRhbnQsIGZvciB0aGUgZnVsbCBhY2NvdW50KS5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgSVMgQSBDT05UUkFDVCBBTkQgTk9UIEEgVVRJTElUWSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBga2luZGAgaXMgdGhlIGNvbnRyYWN0OyBgbWVzc2FnZWAgaXMgcHJlc2VudGF0aW9uLiBSZXdvcmRpbmcgYSBtZXNzYWdlIG11c3RcbiAqIG5ldmVyIGJyZWFrIGEgY2FsbGVyLCB3aGljaCBpdCBkb2VzIHRoZSBtb21lbnQgYW55b25lIG1hdGNoZXMgb24gcHJvc2UuIEFuXG4gKiBhZ2VudCByb3V0ZXMgb24gYGtpbmRgIGFuZCBvbiB0aGUgZXhpdCBjb2RlLCBzbyBjaGFuZ2luZyBlaXRoZXIgaXMgYSBjaGFuZ2VcbiAqIGFuIGFnZW50IE9CU0VSVkVTIGFuZCB0aGUgc3BlbGwgbmVlZHMgYW4gYWNjIHJlLWdyYWRlLiBUaGF0IGlzIHRoZSBjdXQgdGhpc1xuICogZGlyZWN0b3J5IGlzIG5hbWVkIGZvci5cbiAqXG4gKiDilIDilIAg4puUIGBkaWVgIFRIUk9XUy4gSVQgRE9FUyBOT1QgRVhJVCwgQU5EIFRIQVQgSVMgVEhFIFBPSU5UIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBmaWxlKSwgc29cbiAqIGBwcm9jZXNzLmV4aXQoKWAgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlCBtZWFzdXJlZCBhdCBleGFjdGx5XG4gKiA2NSw1MzYgYnl0ZXMsIGFuZCB0aGUgY2FsbGVyIGdldHMgd2VsbC1mb3JtZWQtbG9va2luZyBKU09OIHRoYXQgc3RvcHNcbiAqIG1pZC1zdHJpbmcuIFJlcHJvZHVjZWQsIGZpeGVkIGFuZCBnYXRlZCBpbiBib3VudHkgZmlyc3QgKFAwLCAjNzcvIzc4KS5cbiAqXG4gKiBUaGUgb2xkIHNoYXBlIHdyb3RlIG9uZSBzaG9ydCBlbnZlbG9wZSB0byBzdGRlcnIgYW5kIGV4aXRlZCBpbW1lZGlhdGVseSxcbiAqIHdoaWNoIGlzIHNhZmUgT05MWSB3aGlsZSB0aGUgcGF5bG9hZCBmaXRzIHRoZSA2NCBLaUIgcGlwZSBidWZmZXIg4oCUIHN0ZGVyclxuICogaXMgY3V0IHNob3J0IGV4YWN0bHkgbGlrZSBzdGRvdXQgKG1lYXN1cmVkKS4gSXQgYWxzbyBtZWFudCBldmVyeSBgZGllYCB3YXMgYVxuICogc2Vjb25kIHBsYWNlIHRoZSBwcm9jZXNzIGNvdWxkIGVuZCwgb3BhcXVlIHRvIHdoYXRldmVyIHRoZSB2ZXJiIGhhZFxuICogYWxyZWFkeSB3cml0dGVuIHRvIHN0ZG91dC5cbiAqXG4gKiBTbzogYGRpZWAgcmFpc2VzIGEgYENsaUVycm9yYCwgdGhlIHNwZWxsJ3MgYG1haW5gIGNhdGNoZXMgaXQgd2l0aFxuICogYHJlcG9ydENsaUVycm9yYCwgYW5kIHRoZSBwcm9jZXNzIGVuZHMgdGhlIG9uZSB3YXkgdGhlIGhvdXNlIHNhbmN0aW9ucyDigJRcbiAqIGBwcm9jZXNzLmV4aXRDb2RlYCBwbHVzIGEgbmF0dXJhbCByZXR1cm4uIGdsYW1vdXIgYW5kIG1pbmQtbWFwcGVyIHJlYWNoZWRcbiAqIHRoaXMgc2hhcGUgaW5kZXBlbmRlbnRseSBhdCB0aGVpciBhY2MgTDAgcGFzc2VzOyB0aGlzIG1vZHVsZSBpcyB3aGVyZSB0aGVcbiAqIHRocmVlIGNvcGllcyBzdG9wIGJlaW5nIHRocmVlLlxuICpcbiAqIOKaoCBBIGBkaWVgIGluc2lkZSBhIGB0cnlgIHdob3NlIGBjYXRjaGAgU1dBTExPV1MgaXMgbm93IGEgc2lsZW50XG4gKiBjb250aW51ZSByYXRoZXIgdGhhbiBhbiBleGl0LiBFdmVyeSBjYWxsIHNpdGUgaW4gYW4gYWRvcHRpbmcgc3BlbGwgbXVzdCBiZVxuICogcmVhZCBmb3IgdGhhdCBiZWZvcmUgaXQgYWRvcHRzLiBBdWRpdGVkIGZvciBhc3Ryb2xhYmUgKDE2IHNpdGVzKSBhbmQgbWFncGllXG4gKiAoMzApIG9uIGFkb3B0aW9uOiBldmVyeSBvbmUgaXMgZWl0aGVyIG91dHNpZGUgYSBgdHJ5YCBvciBpbnNpZGUgYSBgY2F0Y2hgLFxuICogZnJvbSB3aGljaCB0aGUgdGhyb3cgcHJvcGFnYXRlcy5cbiAqL1xuXG4vKipcbiAqIFRoZSBmYWlsdXJlIHRheG9ub215LiBFeGl0IGNvZGVzIGZvbGxvdyB0aGUgYWNjIHN0YW5kYXJkOiBhIHVzYWdlIGVycm9yIGlzXG4gKiB0aGUgY2FsbGVyJ3MgdG8gZml4IGJ5IGNoYW5naW5nIHRoZSBjb21tYW5kLCBhbiBpbnRlcm5hbCBmYXVsdCBpcyBub3QsIGFuZFxuICogY29sbGFwc2luZyB0aGVtIGludG8gb25lIG51bWJlciBsZWF2ZXMgYW4gYWdlbnQgd2l0aCBub3RoaW5nIHRvIHJvdXRlIG9uLlxuICovXG5leHBvcnQgdHlwZSBFcnJLaW5kID0gXCJ1c2FnZVwiIHwgXCJpbnRlcm5hbFwiIHwgXCJub3RfZm91bmRcIiB8IFwiY29uZmxpY3RcIjtcblxuZXhwb3J0IGNvbnN0IEVYSVRfRk9SOiBSZWNvcmQ8RXJyS2luZCwgbnVtYmVyPiA9IHtcbiAgdXNhZ2U6IDIsIC8vIHRoZSBjYWxsZXIgY2FuIGZpeCB0aGlzIGJ5IGNoYW5naW5nIHRoZSBjb21tYW5kXG4gIGludGVybmFsOiAxLCAvLyB0aGUgc3BlbGwgYnJva2U7IHRoZSBpbnZvY2F0aW9uIG1heSBoYXZlIGJlZW4gZmluZVxuICBub3RfZm91bmQ6IDUsIC8vIHRoZSBuYW1lZCB0aGluZyBkb2VzIG5vdCBleGlzdFxuICBjb25mbGljdDogNiwgLy8gYSBwcmVjb25kaXRpb24gZmFpbGVkXG59O1xuXG4vKiogRXh0cmEgZmllbGRzIGEgZmFpbHVyZSBtYXkgY2FycnkuIGBoaW50YCBpcyBwcm9zZSBmb3IgYSBodW1hbiBvciBhbiBhZ2VudDtcbiAqICBgY2hvaWNlc2AgZW51bWVyYXRlcyB3aGF0IFdPVUxEIGhhdmUgYmVlbiBhY2NlcHRlZC4gKi9cbmV4cG9ydCB0eXBlIEVyckV4dHJhID0geyBoaW50Pzogc3RyaW5nOyBjaG9pY2VzPzogc3RyaW5nW10gfTtcblxuLyoqIFRoZSB2ZXJiIHVuZGVyIGV4ZWN1dGlvbiwgc28gYW4gZW52ZWxvcGUgY2FuIG5hbWUgaXQuIFNldCBvbmNlIGJ5IGBtYWluYC4gKi9cbmxldCBjdXJyZW50Q29tbWFuZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRDdXJyZW50Q29tbWFuZChjb21tYW5kOiBzdHJpbmcgfCBudWxsKTogdm9pZCB7XG4gIGN1cnJlbnRDb21tYW5kID0gY29tbWFuZDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldEN1cnJlbnRDb21tYW5kKCk6IHN0cmluZyB8IG51bGwge1xuICByZXR1cm4gY3VycmVudENvbW1hbmQ7XG59XG5cbi8qKlxuICogT05FIEpTT04gZG9jdW1lbnQgb24gc3RkZXJyLCBhbmQgc3Rkb3V0IHN0YXlzIGVtcHR5IOKAlCBzdGRvdXQgY2FycmllcyBkYXRhXG4gKiBhbmQgYSBmYWlsdXJlIGhhcyBub25lLiBBIGNhbGxlciB0aGF0IGdldHMgb25lIEpTT04gZG9jdW1lbnQgZnJvbSBhIHZlcmIgYW5kXG4gKiBwcm9zZSBmcm9tIGEgZmFpbHVyZSBoYXMgdG8gcGFyc2UgdHdvIGZvcm1hdHMgdG8gdXNlIG9uZSB0b29sLCBhbmQgdGhlXG4gKiBmYWlsdXJlIGlzIHRoZSBjYXNlIHdoZXJlIGl0IGNhbiBsZWFzdCBhZmZvcmQgdG8gZ3Vlc3MuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlcnJvckVudmVsb3BlKGtpbmQ6IEVycktpbmQsIG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiBFcnJFeHRyYSk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtKU09OLnN0cmluZ2lmeSh7XG4gICAgb2s6IGZhbHNlLFxuICAgIGVycm9yOiB7XG4gICAgICBraW5kLFxuICAgICAgZXhpdF9jb2RlOiBFWElUX0ZPUltraW5kXSxcbiAgICAgIC8vIE9ubHkgcmF0ZSBsaW1pdHMgYXJlIHdvcnRoIHJldHJ5aW5nIHVuY2hhbmdlZDsgbm90aGluZyB0aGUgaG91c2UgcmFpc2VzIGlzLlxuICAgICAgcmV0cnlhYmxlOiBmYWxzZSxcbiAgICAgIG1lc3NhZ2UsXG4gICAgICAuLi4oZXh0cmE/LmhpbnQgPyB7IGhpbnQ6IGV4dHJhLmhpbnQgfSA6IHt9KSxcbiAgICAgIC4uLihleHRyYT8uY2hvaWNlcyA/IHsgY2hvaWNlczogZXh0cmEuY2hvaWNlcyB9IDoge30pLFxuICAgIH0sXG4gICAgbWV0YTogeyBjb21tYW5kOiBjdXJyZW50Q29tbWFuZCB9LFxuICB9KX1cXG5gO1xufVxuXG4vKiogQSBmYWlsdXJlIHdpdGggYSB0YXhvbm9teSBga2luZGAsIHJhaXNlZCBieSBgZGllYCBhbmQgY2F1Z2h0IGJ5IGBtYWluYC4gKi9cbmV4cG9ydCBjbGFzcyBDbGlFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgcmVhZG9ubHkga2luZDogRXJyS2luZDtcbiAgcmVhZG9ubHkgZXh0cmE/OiBFcnJFeHRyYTtcblxuICBjb25zdHJ1Y3RvcihraW5kOiBFcnJLaW5kLCBtZXNzYWdlOiBzdHJpbmcsIGV4dHJhPzogRXJyRXh0cmEpIHtcbiAgICBzdXBlcihtZXNzYWdlKTtcbiAgICB0aGlzLm5hbWUgPSBcIkNsaUVycm9yXCI7XG4gICAgdGhpcy5raW5kID0ga2luZDtcbiAgICB0aGlzLmV4dHJhID0gZXh0cmE7XG4gIH1cblxuICBnZXQgZXhpdENvZGUoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gRVhJVF9GT1JbdGhpcy5raW5kXTtcbiAgfVxufVxuXG4vKiogUmFpc2UgYSB0YXhvbm9teSBmYWlsdXJlLiBSZXR1cm5zIGBuZXZlcmAsIHNvIGRlZmluaXRlLWFzc2lnbm1lbnQgYW5hbHlzaXNcbiAqICBzdGlsbCBuYXJyb3dzIGFmdGVyIGl0IOKAlCB0aGUgcHJvcGVydHkgdGhhdCBsZXQgdGhlIG9sZCBleGl0aW5nIGZvcm0gc2l0IGluXG4gKiAgYSBgY2F0Y2hgIGFuZCBsZWF2ZSB0aGUgdmFyaWFibGUgaXQgZ3VhcmRzIGFzc2lnbmVkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRpZShtZXNzYWdlOiBzdHJpbmcsIGtpbmQ6IEVycktpbmQgPSBcInVzYWdlXCIsIGV4dHJhPzogRXJyRXh0cmEpOiBuZXZlciB7XG4gIHRocm93IG5ldyBDbGlFcnJvcihraW5kLCBtZXNzYWdlLCBleHRyYSk7XG59XG5cbi8qKlxuICogUmVwb3J0IGEgY2F1Z2h0IGVycm9yIGFzIHRoZSBob3VzZSBlbnZlbG9wZSBhbmQgaGFuZCBiYWNrIGFuIGV4aXQgY29kZSwgb3JcbiAqIGBudWxsYCB3aGVuIHRoZSBlcnJvciBpcyBOT1QgYSBgQ2xpRXJyb3JgIOKAlCB3aGljaCB0aGUgY2FsbGVyIG11c3QgcmV0aHJvdy5cbiAqIFN3YWxsb3dpbmcgYW4gdW5rbm93biB0aHJvdyBoZXJlIHdvdWxkIHJlcG9ydCBhbiBpbnRlcm5hbCBmYXVsdCBhcyBhIHRpZHlcbiAqIHRheG9ub215IGZhaWx1cmUgYW5kIGxvc2UgdGhlIHN0YWNrIHRoYXQgc2F5cyB3aGF0IGFjdHVhbGx5IGJyb2tlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVwb3J0Q2xpRXJyb3IoXG4gIGU6IHVua25vd24sXG4gIGVycjogeyB3cml0ZShjaHVuazogc3RyaW5nKTogdW5rbm93biB9ID0gcHJvY2Vzcy5zdGRlcnIsXG4pOiBudW1iZXIgfCBudWxsIHtcbiAgaWYgKCEoZSBpbnN0YW5jZW9mIENsaUVycm9yKSkgcmV0dXJuIG51bGw7XG4gIGVyci53cml0ZShlcnJvckVudmVsb3BlKGUua2luZCwgZS5tZXNzYWdlLCBlLmV4dHJhKSk7XG4gIHJldHVybiBlLmV4aXRDb2RlO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBTU0UgdGFpbCBjbGllbnQg4oCUIHRoZSBzdGFuZGluZywgc2VsZi1oZWFsaW5nIHJlYWQgbG9vcCBldmVyeVxuICogc3BlbGwncyBgdGFpbGAvYGpvaW5gIHZlcmIgcnVucy5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCB3YXJkIDInc1xuICogYXNzZXJ0aW9uLCBhbmQgaXQgaXMgd2hhdCBtYWtlcyB0aGlzIG1vZHVsZSBzYWZlIHRvIGlubGluZSBpbnRvIGFueSBzcGVsbCdzXG4gKiBidW5kbGUuIEl0IHJlYWNoZXMgZm9yIG5vdGhpbmcsIG5vdCBldmVuIHRoZSBzaWJsaW5nIGVycm9yIGNvbnRyYWN0LlxuICpcbiAqIERlc2lnbmVkIGFnYWluc3QgYWxsIHNldmVuIG9mIHRoZSBob3VzZSdzIGhhbmQtd3JpdHRlbiB0YWlscyAodGhlIGNvbnZlcmdlbmNlXG4gKiBkZXNpZ24sIGBkb2NzL2ludmVzdGlnYXRpb25zLzIwMjYtMDktMDgtdGFpbC1yZWFkZXItY29udmVyZ2VuY2UubWRgKSBhbmRcbiAqIGFkb3B0ZWQgZmlyc3QgYnkgYXN0cm9sYWJlIGFuZCBtYWdwaWUuXG4gKlxuICog4pSA4pSAIFRIRSBUV08gREVDSVNJT05TIFRIQVQgTUFLRSBPTkUgQ0xJRU5UIFBPU1NJQkxFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqICoqMS4gXCJXaGVyZSBpcyB0aGUgZGFlbW9uXCIgaXMgYSBDQUxMQkFDSywgbm90IGEgVVJMLioqIGByZXNvbHZlYCBpcyBjYWxsZWRcbiAqIGJlZm9yZSBFVkVSWSBjb25uZWN0IGF0dGVtcHQgYW5kIGl0cyBhbnN3ZXIgaXMgbmV2ZXIgY2FwdHVyZWQuIFRoYXQgc2luZ2xlXG4gKiBjaGFuZ2UgdW5pZmllcyBmb3VyIGluY29tcGF0aWJsZSBkaXNjb3ZlcnkgbW9kZWxzIOKAlCBzZXNzaW9uLXBvaW50ZXIgcmUtcmVhZCxcbiAqIHBpZC1jaGVja2VkIHBvcnQgZmlsZSwgcmVzcGF3bi1pZi1hYnNlbnQg4oCUIGFuZCBpdCByZXBhaXJzIGEgZGVmZWN0IGJ5XG4gKiBjb25zdHJ1Y3Rpb24gcmF0aGVyIHRoYW4gYnkgYW55b25lIGZpeGluZyBpdDogYXN0cm9sYWJlIHJlc29sdmVkIGl0cyBkYWVtb25cbiAqIGJhc2UgT05DRSBhbmQgcmVjb25uZWN0ZWQgdG8gdGhhdCBvbmUgY2FwdHVyZWQgcG9ydCBmb3JldmVyLCBzbyBgam9pbmAg4oCUIHRoZSB2ZXJiXG4gKiBkZXNpZ25lZCB0byBydW4gZm9yIGhvdXJzIGNhcnJ5aW5nIHByZXNlbmNlIOKAlCBzcHVuIHNpbGVudGx5IGFnYWluc3QgYSBkZWFkXG4gKiBwb3J0IGFmdGVyIGFueSBkYWVtb24gcmVzdGFydCwgYW5kIGFzdHJvbGFiZSBiaW5kcyBhbiBlcGhlbWVyYWwgcG9ydC5cbiAqXG4gKiAqKjIuIFRoaXMgY2xpZW50IE5FVkVSIGNhbGxzIGBwcm9jZXNzLmV4aXRgLiBJdCBSRVRVUk5TIGFuIGV4aXQgY29kZS4qKiBTZWVcbiAqIHRoZSBzY2FyIGJlbG93OyB0aGF0IGlzIHRoZSB3aG9sZSBvZiBpdC5cbiAqXG4gKiDilIDilIAg4puUIFRIRSBTQ0FSOiBQMGYsIFNIQVBFIEIg4oCUIFJFLUhPTUVEIEhFUkUsIFdSSVRURU4gT05DRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBGaXZlIHNwZWxscyBlYWNoIGNhcnJpZWQgYSBjb3B5IG9mIHRoaXMgcGFyYWdyYXBoLCBiZWNhdXNlIGZpdmUgc2l0ZXMgZWFjaFxuICogaGFkIHRvIHByb3ZlIExPQ0FMTFkgdGhhdCBlbmRpbmcgYSB0YWlsIGRvZXMgbm90IGN1dCBpdHMgb3duIGxhc3QgbGluZSBzaG9ydC5cbiAqIEl0IGRvY3VtZW50cyBhIDIzLW1pbnV0ZSBoYW5nIHRoYXQgc2hpcHBlZC4gVGhlIHJlYXNvbmluZyBub3cgbGl2ZXMgaW4gb25lXG4gKiBwbGFjZTsgdGhlIGNvcGllcyBhcmUgZ29uZSwgYW5kIHRoaXMgaXMgd2hhdCB0aGV5IHNhaWQuXG4gKlxuICogQnVuJ3Mgc3Rkb3V0IGlzIEFTWU5DSFJPTk9VUyBvbiBhIHBpcGUgKHN5bmNocm9ub3VzIG9uIGEgVFRZIG9yIGEgZmlsZSkuIEFuXG4gKiBleHBsaWNpdCBgcHJvY2Vzcy5leGl0KClgIHRoZXJlZm9yZSBkaXNjYXJkcyB3aGF0ZXZlciBoYXMgbm90IGRyYWluZWQg4oCUXG4gKiBtZWFzdXJlZCBhdCBleGFjdGx5IDY1LDUzNiBieXRlcywgb25lIHBpcGUgYnVmZmVyLiBUaGUgcGF5bG9hZCBpcyBjb21wbGV0ZVxuICogYW5kIG9ubHkgdGhlIHdyaXRlIGlzIGxvc3QsIHNvIGEgY2FsbGVyIHJlY2VpdmVzIHdlbGwtZm9ybWVkLUxPT0tJTkcgSlNPTlxuICogdGhhdCBzdG9wcyBtaWQtc3RyaW5nLiBNZWFzdXJlZCwgQnVuIDEuMy4xNCwgMzAwS0Igd3JpdGVzOlxuICpcbiAqICAgICB3cml0ZShiaWcsIGNiIC0+IGV4aXQpICAgICAgICAgICAgICAgICAgICDinIUgMzAwMDAxIGJ5dGVzIGFycml2ZVxuICogICAgIGF3YWl0IEJ1bi53cml0ZShCdW4uc3Rkb3V0LCBiaWcpICAgICAgICAgIOKchVxuICogICAgIG5hdHVyYWwgcmV0dXJuLCBwcm9jZXNzLmV4aXRDb2RlICAgICAgICAgIOKchVxuICogICAgIHdyaXRlKGJpZyk7IHdyaXRlKFwiXCIsIGNiIC0+IGV4aXQpICAgICAgICAg4p2MIDY1NTM2XG4gKiAgICAgNXggd3JpdGUoYmlnKTsgd3JpdGUoXCJcIiwgY2IgLT4gZXhpdCkgICAgICDinYwgZXhhY3RseSA1eDY1NTM2XG4gKlxuICog4puUIFRoZSBsYXN0IHR3byByb3dzIGFyZSB3aHkgYSB0cmFpbGluZyBgd3JpdGUoXCJcIiwgY2IpYCBpcyBOT1QgYSBiYXJyaWVyOiBhXG4gKiBkcmFpbiBjYWxsYmFjayBjb3ZlcnMgT05MWSBJVFMgT1dOIFdSSVRFLiBUaGF0IGlzIGV4YWN0bHkgdGhlIGhlbHBlciBhXG4gKiB3cml0ZS10aGVuLWV4aXQgc2hhcGUgaW52aXRlcywgYW5kIGl0IG1lYXN1cmVkIGJ5dGUtZm9yLWJ5dGUgYXMgYnJva2VuIGFzIG5vXG4gKiBmaXggYXQgYWxsLiBEbyBub3QgcmVpbnRyb2R1Y2UgaXQuXG4gKlxuICogVGhlIGZpdmUgY29waWVzIHRoZW4gZWFjaCBoYWQgdG8gZXN0YWJsaXNoIGEgUEVSLVNJVEUgUFJFQ09ORElUSU9OIOKAlCB3aGV0aGVyXG4gKiBhIGByZXR1cm5gIGVzY2FwZXMgdGhlIHRocmVlIG5lc3RlZCBsb29wcyAob3V0ZXIgcmVjb25uZWN0LCBpbm5lciByZWFkLCBmcmFtZVxuICogZHJhaW4pIG9yIG1lcmVseSBmYWxscyB0aHJvdWdoIGludG8gYW5vdGhlciByZXRyeS4gVGhleSBkaWQgbm90IGFncmVlOiB0d29cbiAqIG5lZWRlZCBhbiBleHBsaWNpdCBgcmV0dXJuYCwgb25lIG5lZWRlZCBhIGBzdG9wcGVkYCBmbGFnIGFzIHdlbGwsIGFuZFxuICogYXN0cm9sYWJlJ3Mgc2l0ZSBjb3VsZCBgcmV0dXJuYCBvbmx5IGJlY2F1c2UgaXRzIGNhbGxlciByZXR1cm5lZCBzdHJhaWdodFxuICogYWZ0ZXIuIOKtkCAqKlJFVFVSTklORyBBTiBFWElUIENPREUgUkVUSVJFUyBUSEFUIFFVRVNUSU9OIEVOVElSRUxZLioqIFRoZXJlIGlzXG4gKiBvbmUgbG9vcCBub3c7IGl0IGJyZWFrcyB0byBvbmUgcGxhY2U7IHRoZSBjYWxsZXIgYXNzaWducyBgcHJvY2Vzcy5leGl0Q29kZWBcbiAqIGFuZCByZXR1cm5zIG5hdHVyYWxseSwgYW5kIHRoZSBydW50aW1lIGRyYWlucyBzdGRvdXQgYmVmb3JlIHRoZSBwcm9jZXNzIGVuZHMuXG4gKiBOb3RoaW5nIGhlcmUgbmVlZHMgdG8ga25vdyB3aGF0IGl0cyBjYWxsZXIgZG9lcyBuZXh0LlxuICpcbiAqIFRoYXQgYWxzbyByZXBhaXJzIGEgZGVmZWN0IHRoZSBjb3BpZXMgc2hhcmVkOiB0aGUgZHJhaW4gZml4IHdhcyBhcHBsaWVkIHRvXG4gKiB0aGUgdGVybWluYWwgZnJhbWUgYnV0IE5PVCB0byB0aGUgc2lnbmFsIGhhbmRsZXIgdHdlbHZlIGxpbmVzIGFib3ZlIGl0LCBzb1xuICogQ3RybC1DIG9uIGEgdGFpbCBwaXBlZCBpbnRvIGEgcmVhZGVyIGRpc2NhcmRlZCB1bmRyYWluZWQgc3Rkb3V0LiBTYW1lIGxvb3AsXG4gKiBzYW1lIGV4aXQgcGF0aCwgb25lIGFuc3dlci5cbiAqXG4gKiDimqAgTk9UIHJlLWhvbWVkLCBkZWxpYmVyYXRlbHk6IG1pbmQtbWFwcGVyJ3MgbWVhc3VyZWQgQnVuIDEuMy4xNCBmaW5kaW5nIHRoYXRcbiAqIGBjb250cm9sbGVyLmVucXVldWUoKWAgb24gYW4gb3JwaGFuZWQgc3RyZWFtIG5ldmVyIHRocm93cy4gSXQgaXMgYSBEQUVNT04tc2lkZVxuICogZmFjdCBhYm91dCBkZWFkLXNvY2tldCBkZXRlY3Rpb24gYW5kIGJlYXJzIG9uIGBzc2VSZXNwb25zZWAsIG5vdCBvbiBhbnlcbiAqIGNsaWVudC4gSXQgc3RheXMgd2hlcmUgaXQgd2FzIG1lYXN1cmVkLlxuICpcbiAqIOKUgOKUgCBUSEUgV0lSRSBGT1JNQVQsIEFORCBUSEUgYFwiZGF0YTogXCJgIFFVRVNUSU9OIFJFU09MVkVEIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIFBlciBXSEFUV0cgSFRNTCwgXCJJbnRlcnByZXRpbmcgYW4gZXZlbnQgc3RyZWFtXCI6IHNwbGl0IGVhY2ggbGluZSBhdCB0aGUgRklSU1RcbiAqIGNvbG9uOyBpZiB0aGUgdmFsdWUgYmVnaW5zIHdpdGggRVhBQ1RMWSBPTkUgc3BhY2UsIHJlbW92ZSB0aGF0IG9uZSBzcGFjZTtcbiAqIGFwcGVuZCBlYWNoIGRhdGEgdmFsdWUgcGx1cyBhIG5ld2xpbmUsIHRoZW4gc3RyaXAgdGhlIGZpbmFsIG5ld2xpbmUuXG4gKlxuICogVGhlIGhvdXNlJ3Mgc2V2ZW4gdGFpbHMgc3BsaXQgaW50byB0d28gbm9uLWNvbmZvcm1hbnQgY2FtcHMsIGFuZCBuZWl0aGVyIGlzXG4gKiBjdXJyZW50bHkgd3JvbmcgaW4gcHJvZHVjdGlvbiwgYmVjYXVzZSBldmVyeSBob3VzZSBkYWVtb24gZW1pdHMgb25lIGRhdGEgbGluZVxuICogcGVyIGZyYW1lIFdJVEggdGhlIHNwYWNlOlxuICpcbiAqICAg4oCiIGBzdGFydHNXaXRoKFwiZGF0YTogXCIpYCDigJQgdGhlIG1vcmUgZGFuZ2Vyb3VzIGVycm9yLiBBIHNwZWMtbGVnYWxcbiAqICAgICBgZGF0YTp7Li4ufWAgbWF0Y2hlcyBub3RoaW5nLCBzbyB0aGUgZnJhbWUgaXMgc2lsZW50bHkgZHJvcHBlZCBBTkQgVEhFXG4gKiAgICAgQ1VSU09SIERPRVMgTk9UIEFEVkFOQ0UuIEl0IGFsc28ga2VlcHMgb25seSB0aGUgZmlyc3QgZGF0YSBsaW5lLlxuICogICDigKIgYC5zbGljZSg1KS50cmltKClgIOKAlCB0aGUgbW9yZSBmb3JnaXZpbmcgZXJyb3IuIEl0IGFjY2VwdHMgYm90aCBmb3JtcyBidXRcbiAqICAgICBzdHJpcHMgQUxMIHdoaXRlc3BhY2UgcmF0aGVyIHRoYW4gb25lIGxlYWRpbmcgc3BhY2UsIHdoaWNoIHdvdWxkIGNvcnJ1cHRcbiAqICAgICBhIHBheWxvYWQgd2l0aCBtZWFuaW5nZnVsIGluZGVudGF0aW9uLlxuICpcbiAqIFRoaXMgY2xpZW50IGRvZXMgbmVpdGhlci4gU3BlYy1jb3JyZWN0IGlzIHNpbXVsdGFuZW91c2x5IGJ5dGUtY29tcGF0aWJsZSB3aXRoXG4gKiBhbGwgc2V2ZW4gZGFlbW9ucyDigJQgdGhlIHJhcmUgY2FzZSB3aGVyZSB0aGUgcmlnaHQgYW5zd2VyIGNvc3RzIG5vdGhpbmcuXG4gKlxuICogYGlkOmAgLyBMYXN0LUV2ZW50LUlEIC8gYHJldHJ5OmAgYXJlIE5PVCBpbXBsZW1lbnRlZCwgYW5kIHRoYXQgaXMgYSBzdGF0ZWRcbiAqIGhvdXNlIGNob2ljZSByYXRoZXIgdGhhbiBhbiBvbWlzc2lvbjogcmVzdW1lIGlzIGEgcXVlcnktcGFyYW0gY3Vyc29yLCBzbyB0aGVcbiAqIHNlcnZlcidzIHJlcGxheSB3aW5kb3cgYW5kIHRoZSBjbGllbnQncyBgc2luY2VgIGFyZSB0aGUgb25lIG1lY2hhbmlzbS5cbiAqL1xuXG4vKiogT25lIHBhcnNlZCBTU0UgZnJhbWUuIGBldmVudGAgZGVmYXVsdHMgdG8gXCJtZXNzYWdlXCIgcGVyIHRoZSBzcGVjLiAqL1xuZXhwb3J0IHR5cGUgU3NlRnJhbWUgPSB7XG4gIGV2ZW50OiBzdHJpbmc7XG4gIC8qKiBUaGUgYWNjdW11bGF0ZWQgYGRhdGFgIHZhbHVlOiBmaWVsZHMgam9pbmVkIHdpdGggXCJcXG5cIiwgZmluYWwgbmV3bGluZSBzdHJpcHBlZC4gKi9cbiAgZGF0YTogc3RyaW5nO1xufTtcblxuLyoqIEEgd3JpdGFibGUgc2luay4gTmFycm93IG9uIHB1cnBvc2Ug4oCUIGBwcm9jZXNzLnN0ZG91dGAgYW5kIGEgdGVzdCBkb3VibGVcbiAqICBib3RoIHNhdGlzZnkgaXQsIGFuZCB0aGUga2l0IG1heSBub3QgbmFtZSBhIG5vZGUgdHlwZSBpdCBkb2VzIG5vdCBpbXBvcnQuICovXG5leHBvcnQgdHlwZSBTaW5rID0geyB3cml0ZShjaHVuazogc3RyaW5nKTogdW5rbm93biB9O1xuXG5leHBvcnQgdHlwZSBUYWlsT3B0aW9uczxFdj4gPSB7XG4gIC8vIOKUgOKUgCBXSEVSRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqXG4gICAqIFRoZSBkYWVtb24ncyBiYXNlIFVSTCAobm8gdHJhaWxpbmcgc2xhc2gpLCBvciBgbnVsbGAgd2hlbiBpdCBjYW5ub3QgYmVcbiAgICogZm91bmQgcmlnaHQgbm93LiDim5QgQ0FMTEVEIEJFRk9SRSBFVkVSWSBDT05ORUNUIEFUVEVNUFQgQU5EIE5FVkVSIENBUFRVUkVEXG4gICAqIOKAlCBhIHRhaWwgb3V0bGl2ZXMgdGhlIGRhZW1vbiBpdCBzdGFydGVkIGFnYWluc3QsIGFuZCBhIGNhcHR1cmVkIGJhc2UgaXNcbiAgICogdGhlIGRlZmVjdCB0aGlzIHBhcmFtZXRlciBleGlzdHMgdG8gbWFrZSB1bnJlYWNoYWJsZS4gSXQgbWF5IHJlLXJlYWQgYVxuICAgKiBwb2ludGVyIGZpbGUsIHByb2JlIGxpdmVuZXNzLCBvciBzcGF3bjsgaXQgbWF5IHRocm93LCBhbmQgdGhlIHRocm93IGlzIHRoZVxuICAgKiBjYWxsZXIncyB0byBhbnN3ZXIgKHdoaWNoIGlzIHN0cmljdGx5IGJldHRlciB0aGFuIGEgYGRpZWAgcmVhY2hhYmxlIGZyb21cbiAgICogaW5zaWRlIGEgcmVjb25uZWN0IGxvb3ApLlxuICAgKi9cbiAgcmVzb2x2ZTogKCkgPT4gc3RyaW5nIHwgbnVsbCB8IFByb21pc2U8c3RyaW5nIHwgbnVsbD47XG4gIC8qKlxuICAgKiBXaGF0IHRvIGRvIHdoZW4gYHJlc29sdmVgIHNheXMgXCJub3QgZm91bmRcIi4gRGVmYXVsdCBgXCJyZXRyeVwiYCBmb3JldmVyLlxuICAgKiBgXCJzdG9wXCJgIGVuZHMgdGhlIHRhaWwgYXQgZXhpdCBjb2RlIDAg4oCUIHRoZSBzaGFwZSBhIHNwZWxsIHdhbnRzIHdoZW4gdGhlXG4gICAqIHNlc3Npb24gaXQgUElOTkVEIGhhcyBnb25lIGF3YXksIHdoaWNoIGlzIGEgY29tcGxldGVkIHdhdGNoIGFuZCBub3QgYVxuICAgKiBmYWlsdXJlLiBUaGUgZmxhZ3MgZGlzdGluZ3Vpc2ggXCJuZXZlciBmb3VuZCBvbmVcIiBmcm9tIFwiaGFkIG9uZSwgbG9zdCBpdFwiLlxuICAgKi9cbiAgb25VbnJlc29sdmVkPzogKHM6IHsgZXZlclJlc29sdmVkOiBib29sZWFuOyBldmVyQ29ubmVjdGVkOiBib29sZWFuIH0pID0+IFwicmV0cnlcIiB8IFwic3RvcFwiO1xuXG4gIC8vIOKUgOKUgCBXSEFUIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogUGF0aCBvbiB0aGUgZGFlbW9uLCBlLmcuIGBcIi9ldmVudHNcImAuIEpvaW5lZCB0byBgcmVzb2x2ZWAncyBhbnN3ZXIuICovXG4gIHBhdGg6IHN0cmluZztcbiAgLyoqIFRoZSBzdGFydGluZyBjdXJzb3IuIFNlbnQgYXMgYHNpbmNlYCB1bmxlc3MgYHF1ZXJ5YCBzYXlzIG90aGVyd2lzZS4gKi9cbiAgc2luY2U6IG51bWJlcjtcbiAgLyoqIFJlYWQgdGhlIGN1cnNvciBvZmYgYW4gZXZlbnQgKGBldi5pZGAsIGBldi5zZXFgLCBgcGF5bG9hZC5pZGAsIOKApikuICovXG4gIGN1cnNvck9mPzogKGV2OiBFdikgPT4gbnVtYmVyIHwgdW5kZWZpbmVkO1xuICAvKipcbiAgICogYFwibW9ub3RvbmljXCJgIChkZWZhdWx0KSB0YWtlcyB0aGUgbWF4LCBzbyBhIHJlcGxheWVkIG9yIG91dC1vZi1vcmRlciBmcmFtZVxuICAgKiBjYW5ub3QgcmVncmVzcyB0aGUgY3Vyc29yIGFuZCBtYWtlIHRoZSBuZXh0IHJlY29ubmVjdCByZS1yZXF1ZXN0IGV2ZW50c1xuICAgKiBhbHJlYWR5IHNlZW4uIGBcImFzc2lnblwiYCB0YWtlcyB0aGUgdmFsdWUgYXMgZ2l2ZW4g4oCUIGF2YWlsYWJsZSBiZWNhdXNlIG9uZVxuICAgKiBzcGVsbCBkb2VzIHRoYXQgdG9kYXkgYW5kIG5vYm9keSBoYXMgcnVsZWQgd2hldGhlciBpdCB3YXMgaW50ZW5kZWQuXG4gICAqL1xuICBjdXJzb3JQb2xpY3k/OiBcIm1vbm90b25pY1wiIHwgXCJhc3NpZ25cIjtcbiAgLyoqIFBlci1hdHRlbXB0IHF1ZXJ5IHBhcmFtZXRlcnMuIERlZmF1bHQgYHsgc2luY2U6IFN0cmluZyhjdXJzb3IpIH1gLlxuICAgKiAgYGZpcnN0Q29ubmVjdGAgaXMgd2hhdCBsZXRzIGEgYC0tbGFzdCBOYCB3aW5kb3cgcmlkZSB0aGUgZmlyc3QgY29ubmVjdGlvblxuICAgKiAgb25seSwgbmV2ZXIgcmUtYmFja2ZpbGxpbmcgb24gYSByZWNvbm5lY3QuICovXG4gIHF1ZXJ5PzogKGN1cnNvcjogbnVtYmVyLCBmaXJzdENvbm5lY3Q6IGJvb2xlYW4pID0+IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG5cbiAgLy8g4pSA4pSAIEVQT0NIIChvcHQtaW47IHJlcXVpcmVzIGEgZGFlbW9uIHRoYXQgc3RhbXBzIG9uZSkg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBSZWFkIHRoZSBkYWVtb24ncyBlcG9jaCBvZmYgYW4gZXZlbnQuICovXG4gIGVwb2NoT2Y/OiAoZXY6IEV2KSA9PiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIC8qKiBBIHJlY29ubmVjdCBsYW5kZWQgb24gYSBESUZGRVJFTlQgZXBvY2g6IHRoZSBkYWVtb24gcmVzdGFydGVkLCBzbyB0aGVcbiAgICogIGN1cnNvciByZXNldHMgdG8gMC4gUmV0dXJuIGEgbGluZSB0byBlbWl0IChhIHN5bnRoZXNpemVkIG5vdGljZSwgbmV2ZXIgYVxuICAgKiAgYnVzIGV2ZW50KSBvciBudWxsLiAqL1xuICBvbkVwb2NoQ2hhbmdlPzogKG5leHQ6IHN0cmluZykgPT4gc3RyaW5nIHwgbnVsbDtcblxuICAvLyDilIDilIAgRklMVEVSIGFuZCBTSEFQRSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFNjb3BlIOKIpyDCrHNlbGYtZWNoby4gQSByZWplY3RlZCBldmVudCBzdGlsbCBBRFZBTkNFUyBUSEUgQ1VSU09SLiAqL1xuICBhY2NlcHQ/OiAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUpID0+IGJvb2xlYW47XG4gIC8qKiBUaGUgbGluZSB0byB3cml0ZSBmb3IgYW4gYWNjZXB0ZWQgZXZlbnQsIG9yIG51bGwgdG8gd3JpdGUgbm90aGluZy5cbiAgICogIERlZmF1bHQ6IHRoZSBmcmFtZSdzIGRhdGEgdmVyYmF0aW0uIFJlY2VpdmVzIHRoZSBmcmFtZSwgc28gYSBjbGllbnQgdGhhdFxuICAgKiAgYnJhbmNoZXMgb24gYSBuYW1lZCBub24tZGF0YSBmcmFtZSAoYGV2ZW50OiBzdWJzY3JpYmVkYCkgaXMgc2VydmVkIGhlcmVcbiAgICogIHJhdGhlciB0aGFuIG5lZWRpbmcgYSBoYXRjaCBvZiBpdHMgb3duLiAqL1xuICByZW5kZXI/OiAoZXY6IEV2LCBmcmFtZTogU3NlRnJhbWUpID0+IHN0cmluZyB8IG51bGw7XG4gIC8qKiBBIGZyYW1lIHdob3NlIGRhdGEgd2lsbCBub3QgcGFyc2UuIERlZmF1bHQ6IHNraXAgaXQuIFJldHVybmluZyBhIHN0cmluZ1xuICAgKiAgZW1pdHMgaXQuIOKaoCBUaGUgY3Vyc29yIGNhbm5vdCBhZHZhbmNlIHBhc3QgYSBmcmFtZSBub2JvZHkgY2FuIHJlYWQsIHNvIGFcbiAgICogIFBFUk1BTkVOVExZIG1hbGZvcm1lZCBmcmFtZSBpcyByZS1kZWxpdmVyZWQgb24gZXZlcnkgcmVjb25uZWN0IGZvciB0aGVcbiAgICogIGRhZW1vbidzIGxpZmU7IGEgc3BlbGwgdGhhdCBjYW4gaGFwcGVuIHRvIHNob3VsZCBsb2cgaXQuICovXG4gIG9uTWFsZm9ybWVkPzogKGZyYW1lOiBTc2VGcmFtZSwgZXJyb3I6IHVua25vd24pID0+IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIEVORCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFRoZSBmcmFtZSB0aGF0IGVuZHMgdGhlIHdhdGNoIChhIGBjbG9zZWRgIGxpZmVjeWNsZSBldmVudCkuIE9wdGlvbmFsLCBhbmRcbiAgICogIHRoYXQgaXMgdGhlIGFjdHVhbCBzaGFwZSBvZiB0aGUgcm9zdGVyIHJhdGhlciB0aGFuIGEgaGVkZ2U6IHNvbWUgdGFpbHMgcnVuXG4gICAqICBmb3JldmVyIGFuZCBoYXZlIG5vIHRlcm1pbmFsIGZyYW1lIGF0IGFsbC4gKi9cbiAgdGVybWluYWw/OiAoZXY6IEV2KSA9PiBib29sZWFuO1xuICAvKiogRW1pdCB0aGUgdGVybWluYWwgZnJhbWUgZXZlbiB3aGVuIGBhY2NlcHRgIHJlamVjdGVkIGl0LiBEZWZhdWx0IGZhbHNlLiAqL1xuICB0ZXJtaW5hbEVtaXRzRmlsdGVyZWQ/OiBib29sZWFuO1xuXG4gIC8vIOKUgOKUgCBUUkFOU1BPUlQgSEVBTFRIIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKipcbiAgICogVGhlIGlkbGUgd2F0Y2hkb2csIGluIG1zLiBEZWZhdWx0IDQ1XzAwMCDiiYggdGhyZWUgbWlzc2VkIDE1cyBoZWFydGJlYXRzLlxuICAgKiAwIGRpc2FibGVzIGl0LiBXaXRob3V0IG9uZSwgYGF3YWl0IHJlYWRlci5yZWFkKClgIHBhcmtzIEZPUkVWRVIgb24gYVxuICAgKiBoYWxmLW9wZW4gc29ja2V0IGFmdGVyIGxhcHRvcCBzbGVlcCwgYSBOQVQgcmViaW5kLCBvciBhIFNJR0tJTExlZCBkYWVtb24uXG4gICAqXG4gICAqIOKaoCBIb2xkIGl0IHdlbGwgYWJvdmUgdGhlIGRhZW1vbidzIGhlYXJ0YmVhdC4gV2hlcmUgaG9sZGluZyB0aGUgY29ubmVjdGlvblxuICAgKiBvcGVuIElTIHRoZSBwcmVzZW5jZSBzaWduYWwsIGV2ZXJ5IHdhdGNoZG9nIGZpcmUgZmxhcHMgYSBjYXJkIGluIGEgaHVtYW4nc1xuICAgKiB2aWV3IOKAlCB0aGF0IGlzIHRoZSBvbmUgcGxhY2UgdGhpcyBjb252ZXJnZW5jZSBzaG93cyB1cCBmb3IgYSBwZXJzb24uIEl0XG4gICAqIHN0aWxsIHdhbnRzIHRoZSB3YXRjaGRvZzogYSB3ZWRnZWQgaGFsZi1vcGVuIGNvbm5lY3Rpb24gc2hvd3MgYSBjYXJkIGFzXG4gICAqIHBlcm1hbmVudGx5IHByZXNlbnQsIHdoaWNoIGlzIHdvcnNlLlxuICAgKi9cbiAgaWRsZU1zPzogbnVtYmVyO1xuICAvKiogUmVjb25uZWN0IGJhY2tvZmYuIERlZmF1bHQgYHsgaW5pdGlhbE1zOiAyNTAsIG1heE1zOiA1MDAwIH1gOyBkb3VibGVzIG9uXG4gICAqICBldmVyeSBmYWlsZWQgYXR0ZW1wdCBhbmQgUkVTRVRTIG9uIGEgc3VjY2Vzc2Z1bCBvcGVuLiBBIGJyYW5jaCB0aGF0IHNsZWVwc1xuICAgKiAgd2l0aG91dCBncm93aW5nIHRoZSBkZWxheSBpcyBhIGNvbnN0YW50LWludGVydmFsIHJlY29ubmVjdCBzdG9ybSDigJQgdGhhdCBpcyBhXG4gICAqICBsaXZlIGRlZmVjdCBpbiBvbmUgc3BlbGwgdG9kYXksIGFuZCB0aGVyZSBpcyBvbmUgY29kZSBwYXRoIGhlcmUuICovXG4gIHJldHJ5PzogeyBpbml0aWFsTXM6IG51bWJlcjsgbWF4TXM6IG51bWJlciB9O1xuICAvKiogQSBub24tMnh4IHJlc3BvbnNlLiBEZWZhdWx0OiByZXRyeSB3aXRoIGJhY2tvZmYuIE1heSB0aHJvdyDigJQgYSByZWZ1c2VkXG4gICAqICBjb25uZWN0aW9uIChhbiB1bmtub3duIHByb2plY3QsIGEgc3RvcmUgdGhhdCBuZWVkcyBvbmUpIGlzIGEgdXNhZ2UgZXJyb3IsXG4gICAqICBub3QgYSB0cmFuc3BvcnQgYmxpcCwgYW5kIHJldHJ5aW5nIGl0IGZvcmV2ZXIganVzdCBzcGlucyBzaWxlbnRseS4gKi9cbiAgb25IdHRwRXJyb3I/OiAocmVzOiBSZXNwb25zZSkgPT4gXCJyZXRyeVwiIHwgUHJvbWlzZTxcInJldHJ5XCI+O1xuICAvKiogQSBgOmAgY29tbWVudCBsaW5lIChhIGtlZXBhbGl2ZSkuIOKblCBDb21tZW50cyBGRUVEIFRIRSBXQVRDSERPRyBldmVuXG4gICAqICB0aG91Z2ggdGhlIGRhdGEgZmlsdGVyIGRpc2NhcmRzIHRoZW0g4oCUIHRoYXQgaXMgaGFuZGxlZCBoZXJlLCBiZWZvcmUgdGhpc1xuICAgKiAgaG9vayBpcyBjYWxsZWQuICovXG4gIG9uQ29tbWVudD86ICh0ZXh0OiBzdHJpbmcpID0+IHZvaWQ7XG5cbiAgLy8g4pSA4pSAIFBMVU1CSU5HIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICBvdXQ/OiBTaW5rO1xuICBlcnI/OiBTaW5rO1xuICAvKiogQ2FsbGVyLW93bmVkIGFib3J0LiBBYm9ydGluZyBlbmRzIHRoZSB0YWlsIGF0IGV4aXQgY29kZSAwLiAqL1xuICBzaWduYWw/OiBBYm9ydFNpZ25hbDtcbiAgLyoqXG4gICAqIEluc3RhbGwgU0lHSU5UL1NJR1RFUk0gaGFuZGxlcnMgdGhhdCBlbmQgdGhlIHRhaWwgY2xlYW5seSAoZGVmYXVsdCB0cnVlKS5cbiAgICog4puUIFRoZXkgZW5kIGl0IGJ5IFJFVFVSTklORywgbm90IGJ5IGV4aXRpbmcg4oCUIHNlZSB0aGUgUDBmIHNjYXI6IGEgc2lnbmFsXG4gICAqIGhhbmRsZXIgdGhhdCBjYWxscyBgcHJvY2Vzcy5leGl0YCBkaXNjYXJkcyB1bmRyYWluZWQgc3Rkb3V0LCB3aGljaCBpcyB0aGVcbiAgICogaGFsZiBvZiB0aGUgZml4IGZpdmUgc3BlbGxzIGRpZCBub3QgYXBwbHkuXG4gICAqL1xuICBzaWduYWxzPzogYm9vbGVhbjtcbn07XG5cbmNvbnN0IERFRkFVTFRfSURMRV9NUyA9IDQ1XzAwMDtcbmNvbnN0IERFRkFVTFRfUkVUUlkgPSB7IGluaXRpYWxNczogMjUwLCBtYXhNczogNTAwMCB9O1xuXG5jb25zdCBzbGVlcCA9IChtczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiA9PiBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBtcykpO1xuXG4vKipcbiAqIFBhcnNlIGEgY29tcGxldGUgU1NFIGZyYW1lIGJvZHkgKHRoZSB0ZXh0IGJldHdlZW4gYmxhbmsgbGluZXMpIHBlciB0aGUgc3BlYydzXG4gKiBcIkludGVycHJldGluZyBhbiBldmVudCBzdHJlYW1cIjogc3BsaXQgYXQgdGhlIEZJUlNUIGNvbG9uLCBzdHJpcCBBVCBNT1NUIE9ORVxuICogbGVhZGluZyBzcGFjZSBmcm9tIHRoZSB2YWx1ZSwgYWNjdW11bGF0ZSBgZGF0YWAgZmllbGRzIHdpdGggXCJcXG5cIi5cbiAqXG4gKiBSZXR1cm5zIG51bGwgZm9yIGEgY29tbWVudC1vbmx5IGZyYW1lOyBgY29tbWVudHNgIGNhcnJpZXMgdGhlaXIgdGV4dCBzbyB0aGVcbiAqIGNhbGxlciBjYW4gc3VyZmFjZSBhIGtlZXBhbGl2ZSBzZW50aW5lbC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlU3NlRnJhbWUoYmxvY2s6IHN0cmluZyk6IHsgZnJhbWU6IFNzZUZyYW1lIHwgbnVsbDsgY29tbWVudHM6IHN0cmluZ1tdIH0ge1xuICBjb25zdCBjb21tZW50czogc3RyaW5nW10gPSBbXTtcbiAgY29uc3QgZGF0YUxpbmVzOiBzdHJpbmdbXSA9IFtdO1xuICBsZXQgZXZlbnQgPSBcIm1lc3NhZ2VcIjtcbiAgbGV0IHNhd0RhdGEgPSBmYWxzZTtcblxuICBmb3IgKGNvbnN0IGxpbmUgb2YgYmxvY2suc3BsaXQoXCJcXG5cIikpIHtcbiAgICBpZiAobGluZSA9PT0gXCJcIikgY29udGludWU7XG4gICAgaWYgKGxpbmUuc3RhcnRzV2l0aChcIjpcIikpIHtcbiAgICAgIGNvbW1lbnRzLnB1c2gobGluZS5zbGljZSgxKSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgY29sb24gPSBsaW5lLmluZGV4T2YoXCI6XCIpO1xuICAgIGNvbnN0IGZpZWxkID0gY29sb24gPT09IC0xID8gbGluZSA6IGxpbmUuc2xpY2UoMCwgY29sb24pO1xuICAgIGxldCB2YWx1ZSA9IGNvbG9uID09PSAtMSA/IFwiXCIgOiBsaW5lLnNsaWNlKGNvbG9uICsgMSk7XG4gICAgaWYgKHZhbHVlLnN0YXJ0c1dpdGgoXCIgXCIpKSB2YWx1ZSA9IHZhbHVlLnNsaWNlKDEpO1xuICAgIGlmIChmaWVsZCA9PT0gXCJkYXRhXCIpIHtcbiAgICAgIGRhdGFMaW5lcy5wdXNoKHZhbHVlKTtcbiAgICAgIHNhd0RhdGEgPSB0cnVlO1xuICAgIH0gZWxzZSBpZiAoZmllbGQgPT09IFwiZXZlbnRcIikge1xuICAgICAgZXZlbnQgPSB2YWx1ZTtcbiAgICB9XG4gICAgLy8gYGlkOmAgYW5kIGByZXRyeTpgIGFyZSBkZWxpYmVyYXRlbHkgaWdub3JlZCDigJQgc2VlIHRoZSBoZWFkZXIuXG4gIH1cblxuICBpZiAoIXNhd0RhdGEpIHJldHVybiB7IGZyYW1lOiBudWxsLCBjb21tZW50cyB9O1xuICByZXR1cm4geyBmcmFtZTogeyBldmVudCwgZGF0YTogZGF0YUxpbmVzLmpvaW4oXCJcXG5cIikgfSwgY29tbWVudHMgfTtcbn1cblxuLyoqXG4gKiBSdW4gYSBzdGFuZGluZyBTU0UgdGFpbCB1bnRpbCBpdCBlbmRzLCBhbmQgcmV0dXJuIHRoZSBwcm9jZXNzIGV4aXQgY29kZS5cbiAqXG4gKiDim5QgSVQgTkVWRVIgQ0FMTFMgYHByb2Nlc3MuZXhpdGAuIFRoZSBjYWxsZXIgZG9lcyBgcHJvY2Vzcy5leGl0Q29kZSA9IGF3YWl0XG4gKiB0YWlsRXZlbnRzKC4uLilgIGFuZCByZXR1cm5zIG5hdHVyYWxseS4gU2VlIHRoZSBQMGYgc2NhciBpbiB0aGlzIGZpbGUnc1xuICogaGVhZGVyIGZvciB3aHkgdGhhdCBpcyB0aGUgd2hvbGUgZGVzaWduIGFuZCBub3QgYSBzdHlsZSBwcmVmZXJlbmNlLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdGFpbEV2ZW50czxFdj4ob3B0czogVGFpbE9wdGlvbnM8RXY+KTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3Qgb3V0ID0gb3B0cy5vdXQgPz8gcHJvY2Vzcy5zdGRvdXQ7XG4gIGNvbnN0IGlkbGVNcyA9IG9wdHMuaWRsZU1zID8/IERFRkFVTFRfSURMRV9NUztcbiAgY29uc3QgcmV0cnkgPSBvcHRzLnJldHJ5ID8/IERFRkFVTFRfUkVUUlk7XG4gIGNvbnN0IGN1cnNvclBvbGljeSA9IG9wdHMuY3Vyc29yUG9saWN5ID8/IFwibW9ub3RvbmljXCI7XG5cbiAgbGV0IGN1cnNvciA9IG9wdHMuc2luY2U7XG4gIGxldCBlcG9jaDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIGxldCBldmVyUmVzb2x2ZWQgPSBmYWxzZTtcbiAgbGV0IGV2ZXJDb25uZWN0ZWQgPSBmYWxzZTtcbiAgbGV0IGZpcnN0Q29ubmVjdCA9IHRydWU7XG4gIGxldCBkZWxheSA9IHJldHJ5LmluaXRpYWxNcztcbiAgbGV0IGNvZGUgPSAwO1xuXG4gIC8vIE9uZSBzdG9wIHN3aXRjaCBmb3IgZXZlcnkgd2F5IHRoaXMgbG9vcCBjYW4gZW5kOiBhIHNpZ25hbCwgYSBjYWxsZXInc1xuICAvLyBhYm9ydCwgYSBkb3duc3RyZWFtIHJlYWRlciBjbG9zaW5nIG91ciBzdGRvdXQuIEVhY2ggc2V0cyBpdCBhbmQgYWJvcnRzIHRoZVxuICAvLyBpbi1mbGlnaHQgYXR0ZW1wdDsgdGhlIGxvb3AgdGhlbiBmYWxscyBvdXQgYW5kIFJFVFVSTlMuXG4gIGxldCBzdG9wcGVkID0gZmFsc2U7XG4gIGxldCBhdHRlbXB0OiBBYm9ydENvbnRyb2xsZXIgfCBudWxsID0gbnVsbDtcbiAgY29uc3Qgc3RvcCA9IChleGl0Q29kZTogbnVtYmVyKSA9PiB7XG4gICAgc3RvcHBlZCA9IHRydWU7XG4gICAgY29kZSA9IGV4aXRDb2RlO1xuICAgIGF0dGVtcHQ/LmFib3J0KCk7XG4gIH07XG5cbiAgY29uc3Qgb25TaWduYWwgPSAoKSA9PiBzdG9wKDApO1xuICBjb25zdCB1c2VTaWduYWxzID0gb3B0cy5zaWduYWxzICE9PSBmYWxzZTtcbiAgaWYgKHVzZVNpZ25hbHMpIHtcbiAgICBwcm9jZXNzLm9uKFwiU0lHSU5UXCIsIG9uU2lnbmFsKTtcbiAgICBwcm9jZXNzLm9uKFwiU0lHVEVSTVwiLCBvblNpZ25hbCk7XG4gIH1cblxuICAvLyBBIGRvd25zdHJlYW0gYGhlYWRgL3JlYWRlciBjbG9zaW5nIG91ciBzdGRvdXQgaXMgYSBjb21wbGV0ZWQgcmVhZCwgbm90IGFcbiAgLy8gY3Jhc2g6IGVuZCBhdCAwIGluc3RlYWQgb2YgZHlpbmcgb24gRVBJUEUuXG4gIGNvbnN0IG9uT3V0RXJyb3IgPSAoZTogdW5rbm93bikgPT4ge1xuICAgIGlmICgoZSBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24gfCB1bmRlZmluZWQpPy5jb2RlID09PSBcIkVQSVBFXCIpIHN0b3AoMCk7XG4gIH07XG4gIGNvbnN0IG91dEVtaXR0ZXIgPSBvdXQgYXMgdW5rbm93biBhcyB7XG4gICAgb24/OiAoZXY6IHN0cmluZywgZm46IChlOiB1bmtub3duKSA9PiB2b2lkKSA9PiB2b2lkO1xuICAgIG9mZj86IChldjogc3RyaW5nLCBmbjogKGU6IHVua25vd24pID0+IHZvaWQpID0+IHZvaWQ7XG4gIH07XG4gIG91dEVtaXR0ZXIub24/LihcImVycm9yXCIsIG9uT3V0RXJyb3IpO1xuXG4gIGNvbnN0IG9uQ2FsbGVyQWJvcnQgPSAoKSA9PiBzdG9wKDApO1xuICBvcHRzLnNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICBpZiAob3B0cy5zaWduYWw/LmFib3J0ZWQpIHN0b3AoMCk7XG5cbiAgY29uc3QgZW1pdCA9IChsaW5lOiBzdHJpbmcpID0+IHtcbiAgICBvdXQud3JpdGUoYCR7bGluZX1cXG5gKTtcbiAgfTtcblxuICB0cnkge1xuICAgIHdoaWxlICghc3RvcHBlZCkge1xuICAgICAgLy8g4pqgIERFTElCRVJBVEVMWSBVTkdVQVJERUQuIGByZXNvbHZlYCBtYXkgc3Bhd24sIHByb2JlLCBvciByYWlzZSBhXG4gICAgICAvLyB0YXhvbm9teSBmYWlsdXJlLCBhbmQgdGhhdCB0aHJvdyBpcyB0aGUgQ0FMTEVSJ3MgdG8gYW5zd2VyIOKAlCB3aGljaCBpc1xuICAgICAgLy8gc3RyaWN0bHkgYmV0dGVyIHRoYW4gdGhlIGNvcGllcycgc2hhcGUsIHdoZXJlIGEgYGRpZWAgd2FzIHJlYWNoYWJsZVxuICAgICAgLy8gZnJvbSBpbnNpZGUgYSByZWNvbm5lY3QgbG9vcCBhbmQgZW5kZWQgdGhlIHByb2Nlc3MgZnJvbSB0aHJlZSBmcmFtZXNcbiAgICAgIC8vIGRvd24uXG4gICAgICBjb25zdCBiYXNlID0gYXdhaXQgb3B0cy5yZXNvbHZlKCk7XG4gICAgICBpZiAoYmFzZSA9PT0gbnVsbCkge1xuICAgICAgICBjb25zdCB2ZXJkaWN0ID0gb3B0cy5vblVucmVzb2x2ZWQ/Lih7IGV2ZXJSZXNvbHZlZCwgZXZlckNvbm5lY3RlZCB9KSA/PyBcInJldHJ5XCI7XG4gICAgICAgIGlmICh2ZXJkaWN0ID09PSBcInN0b3BcIikgcmV0dXJuIGNvZGU7XG4gICAgICAgIGF3YWl0IHNsZWVwKGRlbGF5KTtcbiAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBldmVyUmVzb2x2ZWQgPSB0cnVlO1xuXG4gICAgICBjb25zdCBwYXJhbXMgPSBvcHRzLnF1ZXJ5Py4oY3Vyc29yLCBmaXJzdENvbm5lY3QpID8/IHsgc2luY2U6IFN0cmluZyhjdXJzb3IpIH07XG4gICAgICBjb25zdCBxcyA9IG5ldyBVUkxTZWFyY2hQYXJhbXMocGFyYW1zKS50b1N0cmluZygpO1xuICAgICAgY29uc3QgdXJsID0gYCR7YmFzZX0ke29wdHMucGF0aH0ke3FzID8gYD8ke3FzfWAgOiBcIlwifWA7XG5cbiAgICAgIGF0dGVtcHQgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gICAgICBjb25zdCBjb250cm9sbGVyID0gYXR0ZW1wdDtcbiAgICAgIGxldCB3YXRjaGRvZzogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsID0gbnVsbDtcbiAgICAgIGNvbnN0IHJlc2V0V2F0Y2hkb2cgPSAoKSA9PiB7XG4gICAgICAgIGlmIChpZGxlTXMgPD0gMCkgcmV0dXJuO1xuICAgICAgICBpZiAod2F0Y2hkb2cgIT09IG51bGwpIGNsZWFyVGltZW91dCh3YXRjaGRvZyk7XG4gICAgICAgIHdhdGNoZG9nID0gc2V0VGltZW91dCgoKSA9PiBjb250cm9sbGVyLmFib3J0KCksIGlkbGVNcyk7XG4gICAgICB9O1xuXG4gICAgICAvLyDim5QgVEhFIFRSWSBJUyBBUk9VTkQgVEhFIFRSQU5TUE9SVCBDQUxMUyBPTkxZIOKAlCBgZmV0Y2hgIGFuZFxuICAgICAgLy8gYHJlYWRlci5yZWFkKClgIOKAlCBhbmQgTkVWRVIgYXJvdW5kIHRoZSBjYWxsZXIncyBob29rcy4gQSBibGFua2V0XG4gICAgICAvLyB0cnkvY2F0Y2ggaGVyZSByZWFkcyBhIGhvb2sncyB0aHJvdyBhcyBhIGRyb3BwZWQgY29ubmVjdGlvbiBhbmRcbiAgICAgIC8vIHJlY29ubmVjdHMgZm9yZXZlcjogdGhlIHRhaWwgc3BpbnMgc2lsZW50bHkgb24gYW4gZXJyb3Igbm9ib2R5IGNhblxuICAgICAgLy8gc2VlLCB3aGljaCBpcyB0aGUgZXhhY3QgZmFpbHVyZSB0aGlzIGNsaWVudCBleGlzdHMgdG8gbWFrZVxuICAgICAgLy8gdW5yZWFjaGFibGUuIChDYXVnaHQgYnkgaXRzIG93biB0ZXN0OiBhIHJlZnVzYWwgaG9vayB0aGF0IHRocm93cyBodW5nXG4gICAgICAvLyB0aGUgc3VpdGUgdW50aWwgdGhlIGNhdGNoIHdhcyBuYXJyb3dlZC4pXG4gICAgICBsZXQgcmVzOiBSZXNwb25zZTtcbiAgICAgIHRyeSB7XG4gICAgICAgIHJlcyA9IGF3YWl0IGZldGNoKHVybCwgeyBzaWduYWw6IGNvbnRyb2xsZXIuc2lnbmFsIH0pO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgYXR0ZW1wdCA9IG51bGw7XG4gICAgICAgIGlmIChzdG9wcGVkKSBicmVhaztcbiAgICAgICAgYXdhaXQgc2xlZXAoZGVsYXkpO1xuICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgdHJ5IHtcbiAgICAgICAgaWYgKCFyZXMub2spIHtcbiAgICAgICAgICAvLyBNYXkgdGhyb3cg4oCUIGEgdHlwZWQgcmVmdXNhbCBpcyBhIHVzYWdlIGVycm9yLCBub3QgYSBibGlwLlxuICAgICAgICAgIGF3YWl0IG9wdHMub25IdHRwRXJyb3I/LihyZXMpO1xuICAgICAgICAgIGF3YWl0IHNsZWVwKGRlbGF5KTtcbiAgICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGlmICghcmVzLmJvZHkpIHtcbiAgICAgICAgICAvLyDim5QgQSAyMDAgV0lUSCBOTyBCT0RZIE1VU1QgR1JPVyBUSEUgQkFDS09GRiBsaWtlIGV2ZXJ5IG90aGVyIGZhaWxlZFxuICAgICAgICAgIC8vIGF0dGVtcHQuIE9uZSBzcGVsbCBzcGxpdCB0aGlzIGd1YXJkIGZyb20gaXRzIHNpYmxpbmcgYW5kIHRoZSBzZWNvbmRcbiAgICAgICAgICAvLyBoYWxmIGxvc3QgdGhlIGdyb3d0aCBsaW5lLCB3aGljaCBpcyBhIDI1MG1zIHJlY29ubmVjdCBzdG9ybSBhdCBhIGNvbnN0YW50XG4gICAgICAgICAgLy8gaW50ZXJ2YWwuXG4gICAgICAgICAgYXdhaXQgc2xlZXAoZGVsYXkpO1xuICAgICAgICAgIGRlbGF5ID0gTWF0aC5taW4oZGVsYXkgKiAyLCByZXRyeS5tYXhNcyk7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICBldmVyQ29ubmVjdGVkID0gdHJ1ZTtcbiAgICAgICAgZmlyc3RDb25uZWN0ID0gZmFsc2U7XG4gICAgICAgIGRlbGF5ID0gcmV0cnkuaW5pdGlhbE1zOyAvLyByZXNldCBvbiBhIHN1Y2Nlc3NmdWwgb3BlblxuICAgICAgICByZXNldFdhdGNoZG9nKCk7XG5cbiAgICAgICAgY29uc3QgcmVhZGVyID0gcmVzLmJvZHkuZ2V0UmVhZGVyKCk7XG4gICAgICAgIGNvbnN0IGRlY29kZXIgPSBuZXcgVGV4dERlY29kZXIoKTtcbiAgICAgICAgbGV0IGJ1ZiA9IFwiXCI7XG5cbiAgICAgICAgd2hpbGUgKCFzdG9wcGVkKSB7XG4gICAgICAgICAgbGV0IGNodW5rOiBBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIHJlYWRlci5yZWFkPj47XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNodW5rID0gYXdhaXQgcmVhZGVyLnJlYWQoKTtcbiAgICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICAgIC8vIFdhdGNoZG9nIGFib3J0LCBjYWxsZXIgYWJvcnQsIG9yIGEgZHJvcHBlZCBjb25uZWN0aW9uLiBBbGwgdGhyZWVcbiAgICAgICAgICAgIC8vIG1lYW4gdGhlIHNhbWUgdGhpbmcgaGVyZTogdGhpcyBhdHRlbXB0IGlzIG92ZXIsIHJlY29ubmVjdCBiZWxvdy5cbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoY2h1bmsuZG9uZSkgYnJlYWs7XG4gICAgICAgICAgLy8g4puUIEJFRk9SRSBGUkFNRSBQQVJTSU5HLiBBIGtlZXBhbGl2ZSBjb21tZW50IGNhcnJpZXMgbm8gZGF0YSBhbmQgaXNcbiAgICAgICAgICAvLyBkaXNjYXJkZWQgd2hlbiBkYXRhIGZyYW1lcyBhcmUgc2VsZWN0ZWQgYmVsb3csIGJ1dCBpdCBpcyB0aGUgcHJvb2YgdGhlIHNvY2tldCBpc1xuICAgICAgICAgIC8vIGFsaXZlIOKAlCBmZWVkaW5nIHRoZSB3YXRjaGRvZyBvbmx5IG9uIERBVEEgYWJvcnRzIGV2ZXJ5IGhlYWx0aHkgYnV0XG4gICAgICAgICAgLy8gcXVpZXQgY29ubmVjdGlvbi5cbiAgICAgICAgICByZXNldFdhdGNoZG9nKCk7XG4gICAgICAgICAgYnVmICs9IGRlY29kZXIuZGVjb2RlKGNodW5rLnZhbHVlLCB7IHN0cmVhbTogdHJ1ZSB9KTtcblxuICAgICAgICAgIGZvciAobGV0IHNlcCA9IGJ1Zi5pbmRleE9mKFwiXFxuXFxuXCIpOyBzZXAgPj0gMDsgc2VwID0gYnVmLmluZGV4T2YoXCJcXG5cXG5cIikpIHtcbiAgICAgICAgICAgIGNvbnN0IGJsb2NrID0gYnVmLnNsaWNlKDAsIHNlcCk7XG4gICAgICAgICAgICBidWYgPSBidWYuc2xpY2Uoc2VwICsgMik7XG4gICAgICAgICAgICBjb25zdCB7IGZyYW1lLCBjb21tZW50cyB9ID0gcGFyc2VTc2VGcmFtZShibG9jayk7XG4gICAgICAgICAgICBmb3IgKGNvbnN0IHRleHQgb2YgY29tbWVudHMpIG9wdHMub25Db21tZW50Py4odGV4dCk7XG4gICAgICAgICAgICBpZiAoIWZyYW1lKSBjb250aW51ZTtcblxuICAgICAgICAgICAgbGV0IGV2OiBFdjtcbiAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgIGV2ID0gSlNPTi5wYXJzZShmcmFtZS5kYXRhKSBhcyBFdjtcbiAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgY29uc3QgbGluZSA9IG9wdHMub25NYWxmb3JtZWQ/LihmcmFtZSwgZSkgPz8gbnVsbDtcbiAgICAgICAgICAgICAgaWYgKGxpbmUgIT09IG51bGwpIGVtaXQobGluZSk7XG4gICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAob3B0cy5lcG9jaE9mKSB7XG4gICAgICAgICAgICAgIGNvbnN0IG5leHQgPSBvcHRzLmVwb2NoT2YoZXYpO1xuICAgICAgICAgICAgICBpZiAodHlwZW9mIG5leHQgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgICAgICAgICBpZiAoZXBvY2ggIT09IG51bGwgJiYgbmV4dCAhPT0gZXBvY2gpIHtcbiAgICAgICAgICAgICAgICAgIGN1cnNvciA9IDA7XG4gICAgICAgICAgICAgICAgICBjb25zdCBsaW5lID0gb3B0cy5vbkVwb2NoQ2hhbmdlPy4obmV4dCkgPz8gbnVsbDtcbiAgICAgICAgICAgICAgICAgIGlmIChsaW5lICE9PSBudWxsKSBlbWl0KGxpbmUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBlcG9jaCA9IG5leHQ7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8g4puUIFRIRSBDVVJTT1IgQURWQU5DRVMgT04gRVZFUlkgRVZFTlQsIElOQ0xVRElORyBBIEZJTFRFUkVEIE9ORS5cbiAgICAgICAgICAgIC8vIEEgc2NvcGUgZmlsdGVyIGlzIGFib3V0IHdoYXQgdGhlIENBTExFUiByZWFkcywgbmV2ZXIgYWJvdXQgd2hhdFxuICAgICAgICAgICAgLy8gdGhlIGRhZW1vbiBoYXMgZGVsaXZlcmVkOyBhZHZhbmNpbmcgb25seSBvbiBlbWl0dGVkIGV2ZW50cyBtYWtlc1xuICAgICAgICAgICAgLy8gZXZlcnkgcmVjb25uZWN0IHJlLXJlcXVlc3QgdGhlIGZpbHRlcmVkIG9uZXMgZm9yZXZlci5cbiAgICAgICAgICAgIGNvbnN0IG4gPSBvcHRzLmN1cnNvck9mPy4oZXYpO1xuICAgICAgICAgICAgaWYgKHR5cGVvZiBuID09PSBcIm51bWJlclwiICYmIE51bWJlci5pc0Zpbml0ZShuKSkge1xuICAgICAgICAgICAgICBjdXJzb3IgPSBjdXJzb3JQb2xpY3kgPT09IFwiYXNzaWduXCIgPyBuIDogTWF0aC5tYXgoY3Vyc29yLCBuKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29uc3QgYWNjZXB0ZWQgPSBvcHRzLmFjY2VwdD8uKGV2LCBmcmFtZSkgPz8gdHJ1ZTtcbiAgICAgICAgICAgIGNvbnN0IGlzVGVybWluYWwgPSBvcHRzLnRlcm1pbmFsPy4oZXYpID8/IGZhbHNlO1xuXG4gICAgICAgICAgICBpZiAoYWNjZXB0ZWQgfHwgKGlzVGVybWluYWwgJiYgb3B0cy50ZXJtaW5hbEVtaXRzRmlsdGVyZWQgPT09IHRydWUpKSB7XG4gICAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBvcHRzLnJlbmRlciA/IG9wdHMucmVuZGVyKGV2LCBmcmFtZSkgOiBmcmFtZS5kYXRhO1xuICAgICAgICAgICAgICBpZiAobGluZSAhPT0gbnVsbCkgZW1pdChsaW5lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChpc1Rlcm1pbmFsKSByZXR1cm4gY29kZTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0gZmluYWxseSB7XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgYXR0ZW1wdCA9IG51bGw7XG4gICAgICB9XG5cbiAgICAgIGlmIChzdG9wcGVkKSBicmVhaztcbiAgICAgIGF3YWl0IHNsZWVwKGRlbGF5KTtcbiAgICB9XG4gICAgcmV0dXJuIGNvZGU7XG4gIH0gZmluYWxseSB7XG4gICAgaWYgKHVzZVNpZ25hbHMpIHtcbiAgICAgIHByb2Nlc3Mub2ZmKFwiU0lHSU5UXCIsIG9uU2lnbmFsKTtcbiAgICAgIHByb2Nlc3Mub2ZmKFwiU0lHVEVSTVwiLCBvblNpZ25hbCk7XG4gICAgfVxuICAgIG91dEVtaXR0ZXIub2ZmPy4oXCJlcnJvclwiLCBvbk91dEVycm9yKTtcbiAgICBvcHRzLnNpZ25hbD8ucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICB9XG59XG4iCiAgXSwKICAibWFwcGluZ3MiOiAiOzs7O0FBd0JBO0FBQ0E7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFVQTtBQUNBLDhCQUFtQixrQkFBUztBQUM1QjtBQUNBLHNCQUFTOzs7QUMzQlQ7OztBQ0RPLElBQU0sbUJBQTZDLElBQUksSUFBSTtBQUFBLEVBQ2hFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQ0YsQ0FBQztBQUdNLElBQU0sd0JBQWtELElBQUksSUFBSTtBQUFBLEVBQ3JFO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFDRixDQUFDO0FBSU0sU0FBUyxZQUFZLENBQUMsTUFBYyxRQUE4QjtBQUFBLEVBQ3ZFLElBQUksV0FBVztBQUFBLElBQVEsT0FBTztBQUFBLEVBQzlCLElBQUksV0FBVztBQUFBLElBQU8sT0FBTyxDQUFDLHNCQUFzQixJQUFJLElBQW1CO0FBQUEsRUFDM0UsT0FBTyxpQkFBaUIsSUFBSSxJQUFtQjtBQUFBOzs7QURpQ2pELElBQU0sWUFBWSxLQUFLLFlBQVksS0FBSyxXQUFXO0FBRW5ELFNBQVMsT0FBTyxDQUFDLFFBQXdCO0FBQUEsRUFDdkMsTUFBTSxNQUFNLElBQUksV0FBVyxDQUFDO0FBQUEsRUFDNUIsT0FBTyxnQkFBZ0IsR0FBRztBQUFBLEVBQzFCLE1BQU0sTUFBTSxNQUFNLEtBQUssS0FBSyxDQUFDLE1BQU0sRUFB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
