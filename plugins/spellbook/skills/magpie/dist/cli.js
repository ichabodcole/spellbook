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
var SSE_HEARTBEAT_MS = 15000;
var TAIL_IDLE_MS = SSE_HEARTBEAT_MS * 3;
function sleep(ms) {
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
    idleMs: TAIL_IDLE_MS,
    onComment: () => ": magpie-keepalive"
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

//# debugId=DCCE9F8BC844A32F64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vc3JjL21hZ3BpZS9iYWNrZW5kL2NsaS50cyIsICIuLi9zY3JpcHRzL2JhY2tlbmQudHMiLCAiLi4vc2hhcmVkL2FscGhhLnRzIiwgIi4uL3NjcmlwdHMvZGlzY292ZXIudHMiLCAiLi4vc2hhcmVkL3R5cGVzLnRzIiwgIi4uL3NjcmlwdHMvcmVkdWNlLnRzIiwgIi4uL3NoYXJlZC92ZXJzaW9ucy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L2xpYi9wcmludEpzb24udHMiLCAiLi4vLi4vLi4vLi4vLi4vc3JjL2tpdC93aXJlL2Vycm9ycy50cyIsICIuLi8uLi8uLi8uLi8uLi9zcmMva2l0L3dpcmUvdGFpbEV2ZW50cy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsKICAgICIjIS91c3IvYmluL2VudiBidW5cblxuLy8gbWFncGllIENMSSDigJQgdGhpbiwgc3RhdGVsZXNzIHdyYXBwZXIgYXJvdW5kIHRoZSBwZXItc2Vzc2lvbiBkYWVtb24ncyBIVFRQXG4vLyBzdXJmYWNlIChzZXJ2ZXIudHMpLiBPbmUgSFRUUCByb3VuZC10cmlwIHBlciB2ZXJiLiBgdGFpbGAgc3RyZWFtcyBTU0UgdXNlclxuLy8gZXZlbnRzIGFzIEpTT05MIGZvciBNb25pdG9yIHRvIHdyYXAgKGEgYGdyb3VuZGluZ2AgYW5jaG9yIGxpbmUgZmlyc3QpLlxuLy9cbi8vIExpZmVjeWNsZTpcbi8vICAgYnVuIGNsaS50cyBvcGVuIFstLXRpdGxlIC4uXSBbLS1pbnRlbnQgLi5dIFstLXJlc3RvcmUgPGlkPl0gWy0tdGltZW91dCBTXSBbLS1uby1vcGVuXVxuLy8gICBidW4gY2xpLnRzIHRhaWwgWy0tc2luY2UgTl0gICAgICAgICAgICAjIFNTRSB1c2VyIGV2ZW50cyDihpIgSlNPTkwgKE1vbml0b3IgdGhpcylcbi8vICAgYnVuIGNsaS50cyBzdGF0ZSBbLS1mdWxsXSAgICAgICAgICAgICAgIyBsZWFuIHN0YXRlIHNuYXBzaG90IChhZGQgLS1mdWxsIGZvciByYXcpXG4vL1xuLy8gRHJpdmluZyB0aGUgc3VyZmFjZSAoUE9TVCAvY21kKTpcbi8vICAgYnVuIGNsaS50cyBzYXkgW3RleHQuLi5dIFstLXN0ZGluXSAgICAgICAgICAgICAgICAgIyBwb3N0IGFnZW50IGRpYWxvZ3VlICh0ZXh0IG9yIHBpcGVkIHN0ZGluKVxuLy8gICBidW4gY2xpLnRzIGFzayA8dGV4dC4uLj4gWy0tb3B0aW9ucyBcImF8YnxjXCJdICAgICAgICMgYXNrIHRoZSB1c2VyIChpbi10aHJlYWQpXG4vLyAgIGJ1biBjbGkudHMgc3RhdHVzIG9uIFt0ZXh0Li4uXSB8IHN0YXR1cyBvZmYgICAgICAgICMgdGhlIHdvcmtpbmcgc3Bpbm5lclxuLy8gICBidW4gY2xpLnRzIHNvdXJjZSA8aW1hZ2VQYXRoPiAgICAgICAgICAgICAgICAgICAgICAjIHNldCB0aGUgY29tcG9zaXRlIHVuZGVyIHJldmlldyAoY29tcHV0ZXMgc2hhICsgc2l6ZSlcbi8vICAgYnVuIGNsaS50cyBjbWQgWy0tc3RkaW5dICAgICAgICAgICAgICAgICAgICAgICAgICAgICMgUE9TVCBhIHJhdyBBZ2VudENvbW1hbmQgSlNPTiBib2R5IChmcm9tIHN0ZGluKVxuLy8gICBidW4gY2xpLnRzIGNsb3NlIHwgaW5mbyB8IHNlc3Npb25zIHwgaGVscFxuLy9cbi8vIGAtLXN0ZGluYCByZWFkcyB0aGUgYm9keSBmcm9tIHN0ZGluIHNvIG5hdHVyYWwtbGFuZ3VhZ2UgdGV4dCBpcyBuZXZlciBpbmxpbmVkXG4vLyBpbnRvIGEgc2hlbGwtcGFyc2VkIGFyZy4gUGF5bG9hZCBvbiBzdGRvdXQsIGxpdmVuZXNzL2VjaG8gb24gc3RkZXJyLlxuLy9cbi8vIEFsbCB2ZXJicyB0YXJnZXQgdGhlIG1vc3QgcmVjZW50IHNlc3Npb24gYnkgZGVmYXVsdDsgcGFzcyAtLXNlc3Npb24gPGlkPi5cblxuaW1wb3J0IHsgc3Bhd24gfSBmcm9tIFwibm9kZTpjaGlsZF9wcm9jZXNzXCI7XG5pbXBvcnQge1xuICBjb3B5RmlsZVN5bmMsXG4gIGV4aXN0c1N5bmMsXG4gIG1rZGlyU3luYyxcbiAgcmVhZGRpclN5bmMsXG4gIHJlYWRGaWxlU3luYyxcbiAgcm1TeW5jLFxuICBzdGF0U3luYyxcbiAgd3JpdGVGaWxlU3luYyxcbn0gZnJvbSBcIm5vZGU6ZnNcIjtcbmltcG9ydCB7IHRtcGRpciB9IGZyb20gXCJub2RlOm9zXCI7XG5pbXBvcnQgeyBiYXNlbmFtZSwgZGlybmFtZSwgam9pbiB9IGZyb20gXCJub2RlOnBhdGhcIjtcbmltcG9ydCB7IGZpbGVVUkxUb1BhdGggfSBmcm9tIFwibm9kZTp1cmxcIjtcbmltcG9ydCB7IHBhcnNlQXJncyBhcyBub2RlUGFyc2VBcmdzIH0gZnJvbSBcIm5vZGU6dXRpbFwiO1xuaW1wb3J0IHtcbiAgdHlwZSBBbHBoYVBvbGljeSxcbiAgaXNNZWRpYUZvcmdlTW9kZWwsXG4gIG1lZGlhRm9yZ2VCYWNrZW5kLFxuICByZW1iZ0JhY2tlbmQsXG4gIHNob3VsZFJlbW92ZSxcbn0gZnJvbSBcIi4uLy4uLy4uL3BsdWdpbnMvc3BlbGxib29rL3NraWxscy9tYWdwaWUvc2NyaXB0cy9iYWNrZW5kXCI7XG5pbXBvcnQgeyBEaXNjb3ZlckVycm9yLCBkaXNjb3ZlciB9IGZyb20gXCIuLi8uLi8uLi9wbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvbWFncGllL3NjcmlwdHMvZGlzY292ZXJcIjtcbmltcG9ydCB7IG5ld0lkIH0gZnJvbSBcIi4uLy4uLy4uL3BsdWdpbnMvc3BlbGxib29rL3NraWxscy9tYWdwaWUvc2NyaXB0cy9yZWR1Y2VcIjtcbmltcG9ydCB0eXBlIHsgRWxlbWVudCB9IGZyb20gXCIuLi8uLi8uLi9wbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvbWFncGllL3NoYXJlZC90eXBlc1wiO1xuaW1wb3J0IHsgY2hvc2VuVmVyc2lvbiB9IGZyb20gXCIuLi8uLi8uLi9wbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvbWFncGllL3NoYXJlZC92ZXJzaW9uc1wiO1xuaW1wb3J0IHsgcHJpbnRKc29uIH0gZnJvbSBcIi4uLy4uL2tpdC9saWIvcHJpbnRKc29uXCI7XG5pbXBvcnQgeyBkaWUsIGVycm9yRW52ZWxvcGUsIHJlcG9ydENsaUVycm9yLCBzZXRDdXJyZW50Q29tbWFuZCB9IGZyb20gXCIuLi8uLi9raXQvd2lyZS9lcnJvcnNcIjtcbmltcG9ydCB7IHRhaWxFdmVudHMgfSBmcm9tIFwiLi4vLi4va2l0L3dpcmUvdGFpbEV2ZW50c1wiO1xuXG4vLyBTd2FsbG93IEVQSVBFIChhIGRvd25zdHJlYW0gYGhlYWRgL01vbml0b3IgY2xvc2luZyBvdXIgc3Rkb3V0IHNob3VsZG4ndCBjcmFzaCkuXG5wcm9jZXNzLnN0ZG91dC5vbihcImVycm9yXCIsIChlOiBOb2RlSlMuRXJybm9FeGNlcHRpb24pID0+IHtcbiAgaWYgKGUuY29kZSA9PT0gXCJFUElQRVwiKSBwcm9jZXNzLmV4aXQoMCk7XG59KTtcblxuY29uc3QgU0NSSVBUX0RJUiA9IGRpcm5hbWUoZmlsZVVSTFRvUGF0aChpbXBvcnQubWV0YS51cmwpKTtcbi8vIFNlZSB0aGUgYXN0cm9sYWJlIHR3aW46IGBkaXN0L2AgYW5kIGBzY3JpcHRzL2AgYXJlIHRoZSBzYW1lIGRlcHRoLCBzbyBvbmx5XG4vLyBhIFNJQkxJTkctcmVsYXRpdmUgcGF0aCBicmVha3Mgd2hlbiB0aGlzIGV4ZWN1dGVzIGFzIGAuLi9kaXN0L2NsaS5qc2AuXG5jb25zdCBTRVJWRVJfU0NSSVBUID0gam9pbihTQ1JJUFRfRElSLCBcIi4uXCIsIFwic2NyaXB0c1wiLCBcInNlcnZlci50c1wiKTtcbmNvbnN0IFNLSUxMX1JPT1QgPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIik7XG5jb25zdCBESVNUX0RJUiA9IGpvaW4oU0tJTExfUk9PVCwgXCJkaXN0XCIpO1xuLy8gZGV2OiB0aGUgZGFlbW9uIHNlcnZlcyBhIEJ1bi1idW5kbGVkIFJlYWN0IHN1cmZhY2UsIGFuZCBCdW4gcmVhZHMgYnVuZmlnLnRvbWxcbi8vICh0aGUgVGFpbHdpbmQgcGx1Z2luKSBmcm9tIGN3ZCBPTkxZLCBzbyB0aGUgZGFlbW9uJ3MgY3dkIE1VU1QgYmUgc3JjL21hZ3BpZS9cbi8vIChzZWFtcyBDb250cmFjdCA1IGN3ZC1waW4pIOKAlCBsYXVuY2hlZCBhbnl3aGVyZSBlbHNlIHRoZSBkZXYgYnVuZGxlciBjYW5ub3Rcbi8vIGNvbXBpbGUgdGhlIHN0eWxlc2hlZXQgKG1lYXN1cmVkIG9uIGdsYW1vdXI6IHRoZSBQQUdFIDUwMHMgd2l0aCBubyBzdHlsZXNoZWV0XG4vLyBsaW5rOyBub3QgXCJ1bnN0eWxlZCBhdCAyMDBcIiDigJQgdGhhdCBzZW50ZW5jZSB3YXMgbmV2ZXIgcnVuOyBtYWdwaWUncyBvd24gZmFpbHVyZVxuLy8gc2hhcGUgaXMgdW5tZWFzdXJlZCkuIHJlbGVhc2U6IGRpc3QvIGlzIHByZS1idWlsdCBhbmRcbi8vIHN0YXRpYyDigJQgbm8gYnVuZmlnIHJlYWQsIHNvIHRoaXMgcGF0aCBuZWVkIG5vdCBleGlzdCBhdCBhbGwgKGEgc291cmNlLWZyZWVcbi8vIG1hcmtldHBsYWNlIGNsb25lIGhhcyBubyB0b3AtbGV2ZWwgc3JjLyksIGFuZCBwaW5uaW5nIGN3ZCB0aGVyZSBhbnl3YXkgd291bGRcbi8vIGJyZWFrIHRoZSBzcGF3bi5cbi8vXG4vLyDim5QgVEhFIERJU0NSSU1JTkFUT1IgSVMgZGlzdC9pbmRleC5odG1sLCBOT1QgZGlzdC8uIG1hZ3BpZSdzIGRpc3QvIGhhcyBoZWxkXG4vLyBjbGkuanMgc2luY2UgU2xpY2UgMiB3aXRoIG5vIGluZGV4Lmh0bWwsIHdoaWNoIGlzIGV4YWN0bHkgd2h5IHRoaXMgZGFlbW9uXG4vLyBzdGF5ZWQgY29ycmVjdGx5IGluIGRldiBtb2RlOyB0aGUgZmlyc3Qgc3VyZmFjZSBidWlsZCB0byBsYW5kIGhlcmUgZmxpcHMgaXQuXG5jb25zdCBTVVJGQUNFX0NXRCA9IGpvaW4oU0tJTExfUk9PVCwgXCIuLlwiLCBcIi4uXCIsIFwiLi5cIiwgXCIuLlwiLCBcInNyY1wiLCBcIm1hZ3BpZVwiKTtcblxuZnVuY3Rpb24gZGFlbW9uQ3dkKCk6IHN0cmluZyB7XG4gIGlmIChwcm9jZXNzLmVudi5TUEVMTEJPT0tfU1VSRkFDRV9NT0RFID09PSBcInJlbGVhc2VcIikgcmV0dXJuIFNLSUxMX1JPT1Q7XG4gIGlmIChwcm9jZXNzLmVudi5TUEVMTEJPT0tfU1VSRkFDRV9NT0RFID09PSBcImRldlwiKSByZXR1cm4gU1VSRkFDRV9DV0Q7XG4gIHJldHVybiBleGlzdHNTeW5jKGpvaW4oRElTVF9ESVIsIFwiaW5kZXguaHRtbFwiKSkgPyBTS0lMTF9ST09UIDogU1VSRkFDRV9DV0Q7XG59XG5cbi8vIE91ciBwbHVnaW4gdmVyc2lvbiAoZnJvbSBwbHVnaW4uanNvbikg4oCUIHRoZSBvbmUgbnVtYmVyIG1hZ3BpZSBjYW4gaG9uZXN0bHlcbi8vIHJlcG9ydCBhcyBpdHMgb3duLiBEMSBhc2tzIGEgQ0xJIHRvIGFuc3dlciBgLS12ZXJzaW9uYDsgYW4gYWdlbnQgdGhhdCBjYW5ub3Rcbi8vIHRlbGwgd2hpY2ggYnVpbGQgaXQgaXMgZHJpdmluZyBjYW5ub3QgdGVsbCBhIG1pc3NpbmcgZmVhdHVyZSBmcm9tIGEgc3RhbGVcbi8vIGluc3RhbGwuIEJlc3QtZWZmb3J0OiBudWxsIGlmIHRoZSByZWFkIGZhaWxzLCBhbmQgYC0tdmVyc2lvbmAgc2F5cyBzbyByYXRoZXJcbi8vIHRoYW4gaW52ZW50aW5nIG9uZS4gU2FtZSByZXNvbHV0aW9uIGdyYXBldmluZSB1c2VzLlxuZnVuY3Rpb24gcmVhZFBsdWdpblZlcnNpb24oKTogc3RyaW5nIHwgbnVsbCB7XG4gIHRyeSB7XG4gICAgY29uc3QgcGx1Z2luSnNvblBhdGggPSBqb2luKFNDUklQVF9ESVIsIFwiLi5cIiwgXCIuLlwiLCBcIi4uXCIsIFwiLmNsYXVkZS1wbHVnaW5cIiwgXCJwbHVnaW4uanNvblwiKTtcbiAgICByZXR1cm4gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocGx1Z2luSnNvblBhdGgsIFwidXRmLThcIikpLnZlcnNpb24gPz8gbnVsbDtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cbmNvbnN0IFBMVUdJTl9WRVJTSU9OID0gcmVhZFBsdWdpblZlcnNpb24oKTtcblxuLy8g4puUIFRIRSBXQVRDSERPRyBJUyBERVJJVkVEIEZST00gVEhFIERBRU1PTidTIEhFQVJUQkVBVCwgTk9UIENIT1NFTi4gVGhlIG9ubHlcbi8vIHRoaW5nIGtlZXBpbmcgYSBxdWlldCBTU0UgY29ubmVjdGlvbiBhbGl2ZSBpcyB0aGUgZGFlbW9uJ3MgYDogaGJgIGNvbW1lbnQsIHNvXG4vLyB0aGUgdHdvIG51bWJlcnMgYXJlIG9uZSBpbnZhcmlhbnQ6IHRoZSB3YXRjaGRvZyBtdXN0IGNsZWFyIHNldmVyYWwgbWlzc2VkXG4vLyBiZWF0cyBvciBhIGhlYWx0aHktYnV0LWlkbGUgdGFpbCByZWNvbm5lY3RzIGZvcmV2ZXIuIG1hZ3BpZSdzIGRhZW1vblxuLy8gaGVhcnRiZWF0cyBvbiBhIExJVEVSQUwgMTUsMDAwIG1zIHdpdGggbm8gZW52IG92ZXJyaWRlXG4vLyAoYHBsdWdpbnMvc3BlbGxib29rL3NraWxscy9tYWdwaWUvc2NyaXB0cy9zZXJ2ZXIudHNgLCBpbnNpZGUgYHNzZVJlc3BvbnNlYCksXG4vLyBzbyB0aHJlZSBtaXNzZWQgYmVhdHMgaXMgNDVzLlxuLy9cbi8vIOKaoCBNaXJyb3JlZCBieSBoYW5kOiB0aGUgQ0xJIGNhbm5vdCBpbXBvcnQgdGhlIGRhZW1vbiB3aXRob3V0IGRyYWdnaW5nIHRoZVxuLy8gd2hvbGUgc2VydmVyIGdyYXBoIGludG8gYGRpc3QvY2xpLmpzYC4gQW4gZWRpdCB0aGVyZSBpcyBhbiBlZGl0IGhlcmUsIGFuZFxuLy8gUGhhc2UgMWIncyBzaGFyZWQgc3BpbmUgaXMgd2hlcmUgdGhlIHBhaXIgc2hvdWxkIGJlY29tZSBvbmUgY29uc3RhbnQuXG5jb25zdCBTU0VfSEVBUlRCRUFUX01TID0gMTVfMDAwO1xuY29uc3QgVEFJTF9JRExFX01TID0gU1NFX0hFQVJUQkVBVF9NUyAqIDM7XG5cbi8vIFdpdGhvdXQgYSB3YXRjaGRvZywgYGF3YWl0IHJlYWRlci5yZWFkKClgIHBhcmtzIGZvcmV2ZXIgb24gYSBoYWxmLW9wZW4gc29ja2V0XG4vLyBhZnRlciBsYXB0b3Agc2xlZXAsIGEgTkFUIHJlYmluZCBvciBhIFNJR0tJTExlZCBkYWVtb24g4oCUIGFuZCB0aGUgdGFpbCBsb29rc1xuLy8gYWxpdmUgd2hpbGUgcmVjZWl2aW5nIG5vdGhpbmcuXG5cbnR5cGUgU2Vzc2lvbiA9IHtcbiAgdXJsOiBzdHJpbmc7XG4gIHBvcnQ6IG51bWJlcjtcbiAgc2Vzc2lvbl9pZDogc3RyaW5nO1xuICB0aXRsZTogc3RyaW5nO1xuICBmaWxlc19kaXI/OiBzdHJpbmc7XG59O1xuXG4vLyDilIDilIAgZXJyb3IgZW52ZWxvcGUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vL1xuLy8g4puUIFRIRSBUQVhPTk9NWSwgVEhFIEVYSVQgQ09ERVMsIFRIRSBFTlZFTE9QRSBBTkQgYGRpZWAgTk9XIExJVkUgT05DRSwgYXRcbi8vIGBzcmMva2l0L3dpcmUvZXJyb3JzLnRzYC4gbWFncGllIGhlbGQgdGhlIGZ1bGxlc3Qgb2YgdGhlIGhvdXNlJ3MgZm91ciBjb3BpZXNcbi8vIGFuZCBpdCBpcyB0aGUgb25lIHRoZSBzaGFyZWQgY29udHJhY3Qgd2FzIGRyYXduIGZyb20sIGJ5dGUgZm9yIGJ5dGUg4oCUIHNvXG4vLyBub3RoaW5nIGEgY2FsbGVyIGNhbiBvYnNlcnZlIGFib3V0IGEgbWFncGllIGZhaWx1cmUgY2hhbmdlZCB3aGVuIHRoaXMgbW92ZWQuXG4vLyBUaGUgb25lIGJlaGF2aW91cmFsIGNoYW5nZSBpcyB0aGF0IGBkaWVgIFRIUk9XUyByYXRoZXIgdGhhbiBleGl0aW5nLCBhbmRcbi8vIGBtYWluYCByZXBvcnRzIGl0OyBzZWUgdGhlIGZ1bm5lbCB0aGVyZS5cbi8vXG4vLyBXaGF0IGl0IHNheXMsIGtlcHQgaGVyZSBiZWNhdXNlIHRoaXMgaXMgd2hlcmUgYSByZWFkZXIgb2YgbWFncGllIGxvb2tzOlxuLy8gbWFncGllIGRlY2xhcmVzIGBkZWZhdWx0T3V0cHV0OiBcImpzb25cImAsIGFuZCB0aGF0IGRlY2xhcmF0aW9uIGlzIGFib3V0IEVWRVJZXG4vLyBzdHJlYW0sIG5vdCBqdXN0IHRoZSBoYXBweSBwYXRoLiBBIGNhbGxlciB0aGF0IGdldHMgb25lIEpTT04gZG9jdW1lbnQgZnJvbSBhXG4vLyB2ZXJiIGFuZCBwcm9zZSBmcm9tIGEgZmFpbHVyZSBoYXMgdG8gcGFyc2UgdHdvIGZvcm1hdHMgdG8gdXNlIG9uZSB0b29sIOKAlCBhbmRcbi8vIHRoZSBmYWlsdXJlIGlzIHRoZSBjYXNlIHdoZXJlIGl0IGNhbiBsZWFzdCBhZmZvcmQgdG8gZ3Vlc3MuIFNvIGEgZmFpbHVyZSBpc1xuLy8gT05FIEpTT04gZG9jdW1lbnQgb24gc3RkZXJyLCBhbmQgc3Rkb3V0IHN0YXlzIGVtcHR5IGJlY2F1c2Ugc3Rkb3V0IGNhcnJpZXNcbi8vIGRhdGEgYW5kIGEgZmFpbHVyZSBoYXMgbm9uZS5cblxuZnVuY3Rpb24gc2xlZXAobXM6IG51bWJlcik6IFByb21pc2U8dm9pZD4ge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHIpID0+IHNldFRpbWVvdXQociwgbXMpKTtcbn1cblxuZnVuY3Rpb24gc2Vzc2lvbkZpbGVQYXRoKHNlc3Npb24/OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gc2Vzc2lvbiA/IGpvaW4odG1wZGlyKCksIGBtYWdwaWUtJHtzZXNzaW9ufS5qc29uYCkgOiBqb2luKHRtcGRpcigpLCBcIm1hZ3BpZS1sYXRlc3QuanNvblwiKTtcbn1cblxuLyoqIOKblCBOVUxMIE1FQU5TIFwiTk8gU0VTU0lPTlwiLCBBTkQgTk9USElORyBFTFNFLlxuICpcbiAqICBUaGlzIGNhdWdodCBldmVyeSBlcnJvciBmcm9tIHRoZSByZWFkIGFuZCByZXR1cm5lZCBudWxsLCBzbyBhIGNvcnJ1cHRcbiAqICBwb2ludGVyLCBhbiBFQUNDRVMsIGFuZCBhbnkgdHJhbnNpZW50IHRoZSBPUyByYWlzZXMgdW5kZXIgbG9hZCBhbGwgYXJyaXZlZFxuICogIGF0IHRoZSBjYWxsZXJzIHdlYXJpbmcgYWJzZW5jZSdzIGNsb3RoZXMg4oCUIGFuZCB0aGUgY2FsbGVycyBhY3Qgb24gYWJzZW5jZTpcbiAqICB0aGV5IHJlcG9ydCBcIm5vIHJ1bm5pbmcgc2Vzc2lvblwiLCBhbmQgYSB0YWlsIGxvb3AgcmVhZHMgaXQgYXMgXCJ0aGUgcGlubmVkXG4gKiAgc2Vzc2lvbiB3ZW50IGF3YXlcIiBhbmQgZXhpdHMgMC4gQSByZXNvdXJjZSBmYWlsdXJlIHdhcyB0aGVyZWZvcmUgcmVwb3J0ZWRcbiAqICBhcyBhIFNVQ0NFU1NGVUwgZW5kIG9mIHdhdGNoLlxuICpcbiAqICBNZWFzdXJlZCBpbiBnbGFtb3VyLCB3aG9zZSBjb3B5IG9mIHRoaXMgZnVuY3Rpb24gaXMgYnl0ZS1pZGVudGljYWw6IGl0cyBDTElcbiAqICBjb250cmFjdCBjZWxsIGZhaWxlZCBvbmNlIHVuZGVyIHRoZSBmdWxsIGdhdGUgd2l0aCB0aGUgbm90X2ZvdW5kIGV4aXQgd2hlcmVcbiAqICB0aGUgY29udHJhY3Qgc2FpZCB1c2FnZSwgYW5kIHBhc3NlZCBhbG9uZSBhbmQgb24gcmUtcnVuLiBGaXhlZCB0aGVyZVxuICogIDIwMjYtMDktMDc7IGZvdW5kIHN0aWxsIHN0YW5kaW5nIGhlcmUgMjAyNi0wOS0wOCBieSB0aGUgYmFja2VuZCBkdXBsaWNhdGlvblxuICogIHJlY29uIChkb2NzL2ludmVzdGlnYXRpb25zLzIwMjYtMDktMDgtYmFja2VuZC1kdXBsaWNhdGlvbi1yZWNvbi5tZCkuXG4gKlxuICogIEVOT0VOVCBpcyB0aGUgb25seSBob25lc3QgYWJzZW5jZS4gRXZlcnl0aGluZyBlbHNlIHNheXMgd2hhdCBpdCB3YXMuXG4gKlxuICogIOKaoCBUaGUgZGFlbW9uIHdyaXRlcyB0aGlzIGZpbGUgYXRvbWljYWxseSAoc2VydmVyLnRzKSwgd2hpY2ggaXMgd2hhdCBsZXRzXG4gKiAgdW5wYXJzZWFibGUgY29udGVudCBjb3VudCBhcyBjb3JydXB0aW9uIHJhdGhlciB0aGFuIGEgaGFsZi13cml0dGVuIHJlYWQuICovXG5mdW5jdGlvbiByZWFkU2Vzc2lvbihzZXNzaW9uPzogc3RyaW5nKTogU2Vzc2lvbiB8IG51bGwge1xuICBjb25zdCBwYXRoID0gc2Vzc2lvbkZpbGVQYXRoKHNlc3Npb24pO1xuICBsZXQgcmF3OiBzdHJpbmc7XG4gIHRyeSB7XG4gICAgcmF3ID0gcmVhZEZpbGVTeW5jKHBhdGgsIFwidXRmOFwiKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnN0IGNvZGUgPSAoZSBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24pLmNvZGU7XG4gICAgaWYgKGNvZGUgPT09IFwiRU5PRU5UXCIpIHJldHVybiBudWxsO1xuICAgIGRpZShgY2Fubm90IHJlYWQgdGhlIHNlc3Npb24gcG9pbnRlciAoJHtjb2RlID8/IFwidW5rbm93biBlcnJvclwifSk6ICR7cGF0aH1gLCBcImludGVybmFsXCIpO1xuICB9XG4gIHRyeSB7XG4gICAgcmV0dXJuIEpTT04ucGFyc2UocmF3KSBhcyBTZXNzaW9uO1xuICB9IGNhdGNoIHtcbiAgICBkaWUoYHRoZSBzZXNzaW9uIHBvaW50ZXIgaXMgbm90IHZhbGlkIEpTT046ICR7cGF0aH1gLCBcImludGVybmFsXCIpO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlcXVpcmVTZXNzaW9uKHNlc3Npb24/OiBzdHJpbmcpOiBTZXNzaW9uIHtcbiAgY29uc3QgcyA9IHJlYWRTZXNzaW9uKHNlc3Npb24pO1xuICBpZiAoIXMpIGRpZShcIm5vIHJ1bm5pbmcgbWFncGllIHNlc3Npb24g4oCUIHJ1bjogY2xpLnRzIG9wZW5cIiwgXCJub3RfZm91bmRcIik7XG4gIHJldHVybiBzO1xufVxuXG5hc3luYyBmdW5jdGlvbiBhcGkoXG4gIHBvcnQ6IG51bWJlcixcbiAgbWV0aG9kOiBzdHJpbmcsXG4gIHBhdGg6IHN0cmluZyxcbiAgYm9keT86IHVua25vd24sXG4pOiBQcm9taXNlPHsgc3RhdHVzOiBudW1iZXI7IGRhdGE6IHVua25vd24gfT4ge1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgaHR0cDovLzEyNy4wLjAuMToke3BvcnR9JHtwYXRofWAsIHtcbiAgICBtZXRob2QsXG4gICAgaGVhZGVyczogYm9keSAhPT0gdW5kZWZpbmVkID8geyBcImNvbnRlbnQtdHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9IDogdW5kZWZpbmVkLFxuICAgIGJvZHk6IGJvZHkgIT09IHVuZGVmaW5lZCA/IEpTT04uc3RyaW5naWZ5KGJvZHkpIDogdW5kZWZpbmVkLFxuICB9KTtcbiAgbGV0IGRhdGE6IHVua25vd24gPSBudWxsO1xuICB0cnkge1xuICAgIGRhdGEgPSBhd2FpdCByZXMuanNvbigpO1xuICB9IGNhdGNoIHt9XG4gIHJldHVybiB7IHN0YXR1czogcmVzLnN0YXR1cywgZGF0YSB9O1xufVxuXG4vLyBTcGxpdCBhcmd2IGludG8gcG9zaXRpb25hbHMgKyBmbGFncy4gYC0tZmxhZyB2YWx1ZWAsIGAtLWZsYWc9dmFsdWVgLCBvciBib29sZWFuLlxuLy8gIzgxIC8gRDQg4oCUIFRIRSBSRUNPR05JWkVEIFNFVCwgQVQgUEFSU0VSIEFMVElUVURFLlxuLy9cbi8vIFRoZSBoYW5kLXJvbGxlZCBwYXJzZXIgaGFkIG5vIHJlZ2lzdHJ5LCBzbyBhbiB1bmtub3duIGZsYWcgd2FzIGFjY2VwdGVkIGF0XG4vLyBleGl0IDAgYW5kIHRoZSB2ZXJiIHJhbiBhbnl3YXksIGFuZCBmcmVlIHByb3NlIGNvbnRhaW5pbmcgYSBgLS13b3JkYCB3YXNcbi8vIHNpbGVudGx5IHRydW5jYXRlZCBhdCB0aGF0IHdvcmQuIGBub2RlOnV0aWxgIHN0cmljdCBzdXBwbGllcyByZWplY3Rpb24sIHRoZVxuLy8gYD1gIGZvcm0gYW5kIHRoZSBgLS1gIHRlcm1pbmF0b3IgZnJvbSB0aGUgc3RhbmRhcmQgbGlicmFyeS5cbi8vXG4vLyBUeXBlcyBhcmUgdGhvdGgncyBhdWRpdGVkIGFydGlmYWN0ICgxNSBzdHJpbmcgwrcgNCBib29sZWFuKSwgZWFjaCBzZXR0bGVkIGJ5XG4vLyB1bmFtYmlndW91cyBldmlkZW5jZSBhdCBldmVyeSBjb25zdW1wdGlvbiBzaXRlLiBHZXR0aW5nIG9uZSB3cm9uZyBpcyBub3QgYVxuLy8gbm8tb3A6IGEgXCJzdHJpbmdcIiB0aGF0IHNob3VsZCBiZSBib29sZWFuIFNXQUxMT1dTIFRIRSBORVhUIFBPU0lUSU9OQUwsIGFuZCBhXG4vLyBcImJvb2xlYW5cIiB0aGF0IHNob3VsZCBiZSBzdHJpbmcgYnJlYWtzIHRoZSBzcGFjZSBmb3JtLlxuY29uc3QgQ0xJX09QVElPTlMgPSB7XG4gIGFscGhhOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgYmJveDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGlkczogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGludGVudDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIGxhYmVsOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgbW9kZWw6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBuYW1lOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgb3B0aW9uczogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHBhZDogeyB0eXBlOiBcInN0cmluZ1wiIH0sXG4gIHJlc3RvcmU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICBzZXNzaW9uOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgc2luY2U6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0aW1lb3V0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgdGl0bGU6IHsgdHlwZTogXCJzdHJpbmdcIiB9LFxuICB0eXBlOiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgZnVsbDogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICBcIm5vLW9wZW5cIjogeyB0eXBlOiBcImJvb2xlYW5cIiB9LFxuICByZW1vdmU6IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbiAgc3RkaW46IHsgdHlwZTogXCJib29sZWFuXCIgfSxcbn0gYXMgY29uc3Q7XG5cbi8vIFdISUNIIEZMQUdTIEVBQ0ggVkVSQiBBQ0NFUFRTIOKAlCBhbmQgdGhlIG9ubHkgc291cmNlIG9mIHRoZSB2ZXJiIHNldC5cbi8vXG4vLyBUaGUgcGFyc2VyIHVzZWQgdG8gZW5mb3JjZSBPTkUgR0xPQkFMIHJlZ2lzdHJ5OiBldmVyeSB2ZXJiIGFjY2VwdGVkIGV2ZXJ5XG4vLyBmbGFnLCBzbyBgY2xvc2UgLS1hbHBoYSBhdXRvYCBhbmQgYHNheSAtLWJib3ggMSwyLDMsNGAgcGFyc2VkIGNsZWFuIGFuZCBkaWRcbi8vIG5vdGhpbmcuIEEgcmVjb3JkZWQtc3VyZmFjZSBjZW5zdXMgY291bnRlZCAyODkgc3VjaCBmbGFnL3BhdGggcGFpcnMg4oCUIDI4OVxuLy8gaW52b2NhdGlvbnMgbWFncGllIGFjY2VwdGVkIGF0IGV4aXQgMCBhbmQgY291bGQgbm90IGFjdCBvbi4gVGhhdCBpcyB0aGVcbi8vIGZhaWx1cmUgdGhpcyB3aG9sZSBraXQgaXMgbmFtZWQgZm9yOiB0aGUgdG9vbCBkb2VzIHRoZSB3cm9uZyB0aGluZyBhbmQgcmVwb3J0c1xuLy8gc3VjY2Vzcy4gQW4gdW5rbm93bi1mbGFnIGNoZWNrIGF0IHRoZSByb290IGNhbm5vdCBzZWUgaXQsIGJlY2F1c2Ugbm9uZSBvZiB0aGVcbi8vIGZsYWdzIGFyZSB1bmtub3duIOKAlCB0aGV5IGFyZSBqdXN0IG5vdCBrbm93biBIRVJFLlxuLy9cbi8vIFNvIHRoZSByZWNvZ25pemVkIHNldCBpcyBwZXIgdmVyYiwgYW5kIHRoaXMgdGFibGUgaXMgaXQuIGBWRVJCU2AgaXMgZGVyaXZlZFxuLy8gZnJvbSBpdHMga2V5cyBhbmQgZWFjaCB2ZXJiIHBhcnNlcyBhZ2FpbnN0IGl0cyBvd24gb3B0aW9ucywgd2hpY2ggbWVhbnMgdGhlXG4vLyBoZWxwIHRleHQsIHRoZSByZWplY3Rpb24ncyBgY2hvaWNlc2AgYW5kIHRoZSBwYXJzZXIgY2FuIG5vIGxvbmdlciBkaXNhZ3JlZTpcbi8vIHRoZXJlIGlzIG9uZSBvYmplY3QsIGFuZCBhZGRpbmcgYSBmbGFnIHRvIGEgdmVyYiBpcyBvbmUgZWRpdC5cbmV4cG9ydCBjb25zdCBWRVJCX1NQRUMgPSB7XG4gIG9wZW46IFtcInRpdGxlXCIsIFwiaW50ZW50XCIsIFwidGltZW91dFwiLCBcInJlc3RvcmVcIiwgXCJuby1vcGVuXCJdLFxuICBzZXNzaW9uczogW10sXG4gIHRhaWw6IFtcInNlc3Npb25cIiwgXCJzaW5jZVwiXSxcbiAgc3RhdGU6IFtcInNlc3Npb25cIiwgXCJmdWxsXCJdLFxuICBzYXk6IFtcInNlc3Npb25cIiwgXCJzdGRpblwiXSxcbiAgYXNrOiBbXCJzZXNzaW9uXCIsIFwib3B0aW9uc1wiXSxcbiAgc3RhdHVzOiBbXCJzZXNzaW9uXCJdLFxuICBzb3VyY2U6IFtcInNlc3Npb25cIl0sXG4gIGRpc2NvdmVyOiBbXCJzZXNzaW9uXCJdLFxuICBleHRyYWN0OiBbXCJzZXNzaW9uXCIsIFwiaWRzXCIsIFwicmVtb3ZlXCIsIFwiYWxwaGFcIiwgXCJwYWRcIiwgXCJtb2RlbFwiLCBcImxhYmVsXCJdLFxuICBleHBvcnQ6IFtcInNlc3Npb25cIiwgXCJpZHNcIl0sXG4gIFwiZWxlbWVudC1hZGRcIjogW1wic2Vzc2lvblwiLCBcImJib3hcIiwgXCJuYW1lXCIsIFwidHlwZVwiXSxcbiAgXCJlbGVtZW50LXJlbW92ZVwiOiBbXCJzZXNzaW9uXCJdLFxuICBjbWQ6IFtcInNlc3Npb25cIiwgXCJzdGRpblwiXSxcbiAgY2xvc2U6IFtcInNlc3Npb25cIl0sXG4gIGluZm86IFtcInNlc3Npb25cIl0sXG4gIGhlbHA6IFtdLFxufSBhcyBjb25zdCBzYXRpc2ZpZXMgUmVjb3JkPHN0cmluZywgcmVhZG9ubHkgKGtleW9mIHR5cGVvZiBDTElfT1BUSU9OUylbXT47XG5cbnR5cGUgVmVyYiA9IGtleW9mIHR5cGVvZiBWRVJCX1NQRUM7XG5cbmNvbnN0IFZFUkJTID0gT2JqZWN0LmtleXMoVkVSQl9TUEVDKSBhcyBWZXJiW107XG5cbmNvbnN0IGlzVmVyYiA9ICh2OiBzdHJpbmcpOiB2IGlzIFZlcmIgPT4gT2JqZWN0Lmhhc093bihWRVJCX1NQRUMsIHYpO1xuXG4vLyBUaGUgZmxhZ3Mgb25lIHZlcmIgYWNjZXB0cywgYXMgdGhlIGNhbGxlciBzcGVsbHMgdGhlbS5cbmNvbnN0IGZsYWdzRm9yID0gKHZlcmI6IFZlcmIpOiBzdHJpbmdbXSA9PiBWRVJCX1NQRUNbdmVyYl0ubWFwKChrKSA9PiBgLS0ke2t9YCkuc29ydCgpO1xuXG5jbGFzcyBVc2FnZUVycm9yIGV4dGVuZHMgRXJyb3Ige31cblxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQXJncyhcbiAgYXJnczogc3RyaW5nW10sXG4gIHZlcmI/OiBWZXJiLFxuKToge1xuICBwb3M6IHN0cmluZ1tdO1xuICBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj47XG59IHtcbiAgLy8gVFdPIFNUQUdFUywgQU5EIFRIRSBPUkRFUiBJUyBUSEUgUE9JTlQuXG4gIC8vXG4gIC8vIFN0YWdlIDEgcGFyc2VzIGFnYWluc3QgdGhlIFdIT0xFIHJlZ2lzdHJ5LCBzbyBhIHRva2VuIG1hZ3BpZSBoYXMgbmV2ZXJcbiAgLy8gaGVhcmQgb2YgaXMgcmVmdXNlZCBieSBgbm9kZTp1dGlsYCB3aXRoIGl0cyBvd24gbWVzc2FnZS4gU3RhZ2UgMiB0aGVuIGFza3NcbiAgLy8gdGhlIHF1ZXN0aW9uIHRoZSBwYXJzZXIgY2Fubm90OiBpcyB0aGlzIGZsYWcgYWNjZXB0ZWQgQVQgVEhJUyBWRVJCLlxuICAvL1xuICAvLyBEb2luZyBpdCB0aGUgb3RoZXIgd2F5IOKAlCBoYW5kaW5nIHBhcnNlQXJncyBhIHBlci12ZXJiIHN1YnNldCDigJQgd2FzIHRoZSBmaXJzdFxuICAvLyBzaGFwZSwgYW5kIGl0IGFuc3dlcmVkIGBzYXkgLS1iYm94YCB3aXRoIFwiVW5rbm93biBvcHRpb24gJy0tYmJveCdcIiwgd2hpY2ggaXNcbiAgLy8gZmFsc2UuIGAtLWJib3hgIGlzIGEgcGVyZmVjdGx5IGdvb2QgZmxhZzsgaXQganVzdCBpcyBub3QgYHNheWAncy4gQW4gYWdlbnRcbiAgLy8gdG9sZCBhIHJlYWwgZmxhZyBpcyB1bmtub3duIGdvZXMgbG9va2luZyBmb3IgYSB0eXBvIGl0IGRpZCBub3QgbWFrZS5cbiAgLy9cbiAgLy8gSXQgYWxzbyBjb3N0IHRoZSBncmltb2lyZSdzIGZsYWctaW52YXJpYW50IHdhcmQgaXRzIGZvb3Rpbmc6IHRoYXQgY2hlY2tcbiAgLy8gcmVzb2x2ZXMgYG9wdGlvbnM6IDxpZGVudGlmaWVyPmAgYmFjayB0byBhIGxpdGVyYWwgZGVjbGFyYXRpb24sIGFuZCBhIHN1YnNldFxuICAvLyBjb21wdXRlZCBhdCB0aGUgY2FsbCBzaXRlIGlzIG5vdCBvbmUuIFRoZSB3YXJkIGNvdWxkIG5vIGxvbmdlciByZWFkIG1hZ3BpZSdzXG4gIC8vIHJlZ2lzdHJ5IGF0IGFsbCBhbmQgcmVwb3J0ZWQgdGhlIGVudHJ5IHBvaW50IHVucmVzb2x2ZWQg4oCUIHRoZSBpbnN0cnVtZW50XG4gIC8vIHNheWluZyBcIkkgY2Fubm90IHNlZSB0aGlzXCIsIGV4YWN0bHkgYXMgZGVzaWduZWQuIEtlZXBpbmcgYENMSV9PUFRJT05TYCBhdFxuICAvLyB0aGUgY2FsbCBzaXRlIGtlZXBzIHRoZSByZWdpc3RyeSBsZWdpYmxlIHRvIGl0LlxuICBsZXQgcGFyc2VkOiB7IHZhbHVlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj47IHBvc2l0aW9uYWxzOiBzdHJpbmdbXSB9O1xuICB0cnkge1xuICAgIHBhcnNlZCA9IG5vZGVQYXJzZUFyZ3Moe1xuICAgICAgYXJncyxcbiAgICAgIG9wdGlvbnM6IENMSV9PUFRJT05TLFxuICAgICAgc3RyaWN0OiB0cnVlLFxuICAgICAgYWxsb3dQb3NpdGlvbmFsczogdHJ1ZSxcbiAgICB9KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHRocm93IG5ldyBVc2FnZUVycm9yKGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSk7XG4gIH1cblxuICBpZiAodmVyYikge1xuICAgIGNvbnN0IGFsbG93ZWQgPSBuZXcgU2V0PHN0cmluZz4oVkVSQl9TUEVDW3ZlcmJdKTtcbiAgICBjb25zdCBzdHJheSA9IE9iamVjdC5rZXlzKHBhcnNlZC52YWx1ZXMpLmZpbmQoKGspID0+ICFhbGxvd2VkLmhhcyhrKSk7XG4gICAgaWYgKHN0cmF5KSB7XG4gICAgICB0aHJvdyBuZXcgVXNhZ2VFcnJvcihcbiAgICAgICAgYC0tJHtzdHJheX0gaXMgbm90IGFjY2VwdGVkIGJ5IFxcYCR7dmVyYn1cXGAgKGl0IGlzIGEgcmVjb2duaXplZCBtYWdwaWUgZmxhZywganVzdCBub3QgdGhpcyB2ZXJiJ3MpYCxcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBwb3M6IHBhcnNlZC5wb3NpdGlvbmFscyxcbiAgICBmbGFnczogcGFyc2VkLnZhbHVlcyBhcyBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPixcbiAgfTtcbn1cblxuLy8gUmVhZCBhbGwgb2Ygc3RkaW4gYXMgdGV4dCAoQnVuLnN0ZGluKS4gVXNlZCBieSBgLS1zdGRpbmAgc28gTkwgdGV4dCBpc24ndCBhXG4vLyBzaGVsbC1wYXJzZWQgYXJnLlxuYXN5bmMgZnVuY3Rpb24gcmVhZFN0ZGluKCk6IFByb21pc2U8c3RyaW5nPiB7XG4gIHJldHVybiAoYXdhaXQgQnVuLnN0ZGluLnRleHQoKSkudHJpbSgpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBwb3N0Q21kKHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCwgbXNnOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikge1xuICBjb25zdCBzID0gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbik7XG4gIGNvbnN0IHsgc3RhdHVzIH0gPSBhd2FpdCBhcGkocy5wb3J0LCBcIlBPU1RcIiwgXCIvY21kXCIsIG1zZyk7XG4gIGlmIChzdGF0dXMgIT09IDIwMCkgZGllKGBjbWQgZmFpbGVkIChIVFRQICR7c3RhdHVzfSkg4oCUIGlzIHRoZSBzZXNzaW9uIHN0aWxsIGFsaXZlP2AsIFwiaW50ZXJuYWxcIik7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBzZW50OiBtc2cudHlwZSB9KTtcbn1cblxuLy8g4pSA4pSAIHZlcmJzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5hc3luYyBmdW5jdGlvbiBjbWRPcGVuKGZsYWdzOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmcgfCBib29sZWFuPikge1xuICBjb25zdCBhcmdzID0gW1wicnVuXCIsIFNFUlZFUl9TQ1JJUFRdO1xuICBpZiAoZmxhZ3MudGl0bGUpIGFyZ3MucHVzaChcIi0tdGl0bGVcIiwgU3RyaW5nKGZsYWdzLnRpdGxlKSk7XG4gIGlmIChmbGFncy5pbnRlbnQpIGFyZ3MucHVzaChcIi0taW50ZW50XCIsIFN0cmluZyhmbGFncy5pbnRlbnQpKTtcbiAgaWYgKGZsYWdzLnRpbWVvdXQpIGFyZ3MucHVzaChcIi0tdGltZW91dFwiLCBTdHJpbmcoZmxhZ3MudGltZW91dCkpO1xuICBpZiAoZmxhZ3MucmVzdG9yZSkgYXJncy5wdXNoKFwiLS1yZXN0b3JlXCIsIFN0cmluZyhmbGFncy5yZXN0b3JlKSk7XG4gIGlmIChmbGFnc1tcIm5vLW9wZW5cIl0pIGFyZ3MucHVzaChcIi0tbm8tb3BlblwiKTtcblxuICBjb25zdCBwcmV2SWQgPSByZWFkU2Vzc2lvbigpPy5zZXNzaW9uX2lkO1xuICAvLyBEZXRhY2hlZCBub2RlOmNoaWxkX3Byb2Nlc3MgKG5vdCBCdW4uc3Bhd24pIHNvIHRoZSBkYWVtb24gU1VSVklWRVMgdGhpcyBDTElcbiAgLy8gcHJvY2VzcyBleGl0aW5nIOKAlCB0aGUgaG91c2UgcGF0dGVybiBmb3IgYSBzdGFuZGluZyBkYWVtb24uIGN3ZCBwaW5uZWQgdG8gdGhlXG4gIC8vIHNraWxsIHJvb3Qgc28gQnVuIGZpbmRzIGJ1bmZpZy50b21sIChyZWdpc3RlcnMgYnVuLXBsdWdpbi10YWlsd2luZCkuXG4gIGNvbnN0IHByb2MgPSBzcGF3bihwcm9jZXNzLmV4ZWNQYXRoLCBhcmdzLCB7XG4gICAgZGV0YWNoZWQ6IHRydWUsXG4gICAgc3RkaW86IFtcImlnbm9yZVwiLCBcImlnbm9yZVwiLCBcImlnbm9yZVwiXSxcbiAgICBlbnY6IHByb2Nlc3MuZW52LFxuICAgIC8vIENvbnRyYWN0IDUg4oCUIHNlZSBkYWVtb25Dd2QoKS4gQSB3cm9uZyBjd2Qgc2tpcHMgdGhlIFRhaWx3aW5kIHBsdWdpbjsgb25cbiAgICAvLyBnbGFtb3VyIHRoYXQgZmFpbHMgdGhlIHBhZ2Ugb3V0cmlnaHQgKDUwMCkuIEFzc2VydCB0aGUgaW52YXJpYW50LCBub3QgdGhlXG4gICAgLy8gc3RhdHVzOiB0aGUgdXRpbGl0eSBuZXZlciByZWFjaGVzIHRoZSBicm93c2VyIHdoZW4gY3dkIGlzIHdyb25nLlxuICAgIGN3ZDogZGFlbW9uQ3dkKCksXG4gIH0pO1xuICBwcm9jLnVucmVmKCk7XG5cbiAgY29uc3QgZGVhZGxpbmUgPSBEYXRlLm5vdygpICsgNTAwMDtcbiAgd2hpbGUgKERhdGUubm93KCkgPCBkZWFkbGluZSkge1xuICAgIGF3YWl0IHNsZWVwKDgwKTtcbiAgICBjb25zdCBzID0gcmVhZFNlc3Npb24oKTtcbiAgICBpZiAocyAmJiBzLnNlc3Npb25faWQgIT09IHByZXZJZCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgciA9IGF3YWl0IGZldGNoKGBodHRwOi8vMTI3LjAuMC4xOiR7cy5wb3J0fS9zdGF0ZWApO1xuICAgICAgICBpZiAoci5vaykge1xuICAgICAgICAgIHByaW50SnNvbihzKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2gge1xuICAgICAgICAvKiBub3QgdXAgeWV0ICovXG4gICAgICB9XG4gICAgfVxuICB9XG4gIGRpZShcIm1hZ3BpZSBzZXJ2ZXIgZmFpbGVkIHRvIHN0YXJ0IHdpdGhpbiA1c1wiLCBcImludGVybmFsXCIpO1xufVxuXG5hc3luYyBmdW5jdGlvbiBjbWRTdGF0ZShzZXNzaW9uPzogc3RyaW5nLCBmdWxsID0gZmFsc2UpIHtcbiAgY29uc3QgcyA9IHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pO1xuICBjb25zdCB7IHN0YXR1cywgZGF0YSB9ID0gYXdhaXQgYXBpKHMucG9ydCwgXCJHRVRcIiwgYC9zdGF0ZSR7ZnVsbCA/IFwiXCIgOiBcIj9sZWFuPTFcIn1gKTtcbiAgaWYgKHN0YXR1cyAhPT0gMjAwKSBkaWUoYHN0YXRlIGZhaWxlZCAoSFRUUCAke3N0YXR1c30pYCwgXCJpbnRlcm5hbFwiKTtcbiAgcHJpbnRKc29uKGRhdGEpO1xufVxuXG4vKipcbiAqIFRoZSBldmVudCB0YWlsIOKAlCBvbmUgY2FsbCBpbnRvIHRoZSBob3VzZSdzIHNoYXJlZCBTU0UgY2xpZW50XG4gKiAoYHNyYy9raXQvd2lyZS90YWlsRXZlbnRzLnRzYCksIHdoZXJlIHRoZSByZWNvbm5lY3QgbG9vcCwgdGhlIHNwZWMtY29ycmVjdFxuICogZnJhbWUgcGFyc2VyLCB0aGUgYmFja29mZiwgdGhlIGlkbGUgd2F0Y2hkb2cgYW5kIHRoZSBkcmFpbmVkIGV4aXQgbGl2ZSBvbmNlXG4gKiBmb3IgZXZlcnkgc3BlbGwuXG4gKlxuICog4puUIGByZXNvbHZlYCBSRS1SRUFEUyBUSEUgU0VTU0lPTiBQT0lOVEVSIE9OIEVWRVJZIEFUVEVNUFQsIHdoaWNoIGlzIHdoYXRcbiAqIG1hZ3BpZSdzIG93biBsb29wIGRpZCBhbmQgd2hhdCB0aGUgc2hhcmVkIGNsaWVudCBtYWtlcyBzdHJ1Y3R1cmFsOiB0aGUgZGFlbW9uXG4gKiBiaW5kcyBhbiBlcGhlbWVyYWwgcG9ydCwgc28gYSBjYXB0dXJlZCBiYXNlIGlzIGEgdGFpbCB0aGF0IHN1cnZpdmVzIGV4YWN0bHlcbiAqIG9uZSBkYWVtb24uXG4gKlxuICogVGhlIHBpbiwgdGhlIGdyb3VuZGluZyBhbmNob3IgYW5kIHRoZSBcIm91ciBzZXNzaW9uIHdlbnQgYXdheVwiIGV4aXQgYXJlIGFsbFxuICogcHJlc2VydmVkIHZlcmJhdGltOiB0aGUgRklSU1QgcmVzb2x2ZWQgc2Vzc2lvbiBpcyBwaW5uZWQgZm9yIHRoZSBsaWZlIG9mIHRoZVxuICogd2F0Y2gsIHRoZSBncm91bmRpbmcgbGluZSBuYW1lcyB0aGF0IGJpbmRpbmcgb25jZSwgYW5kIGEgcG9pbnRlciB0aGF0XG4gKiBkaXNhcHBlYXJzIEFGVEVSIHdlIHdlcmUgYm91bmQgZW5kcyB0aGUgd2F0Y2ggYXQgMCDigJQgYSBjb21wbGV0ZWQgd2F0Y2gsIG5vdCBhXG4gKiBmYWlsdXJlLiBBIHBvaW50ZXIgdGhhdCBuZXZlciBhcHBlYXJlZCBrZWVwcyByZXRyeWluZy5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gY21kVGFpbChzZXNzaW9uOiBzdHJpbmcgfCB1bmRlZmluZWQsIHNpbmNlQXJnOiBudW1iZXIpOiBQcm9taXNlPG51bWJlcj4ge1xuICBsZXQgYm91bmRJZCA9IHNlc3Npb247XG4gIGxldCBncm91bmRlZCA9IGZhbHNlO1xuXG4gIHJldHVybiBhd2FpdCB0YWlsRXZlbnRzPHsgaWQ/OiBudW1iZXI7IHR5cGU/OiBzdHJpbmcgfT4oe1xuICAgIHJlc29sdmU6ICgpID0+IHtcbiAgICAgIC8vIHJlYWRTZXNzaW9uIGRpZXMgb24gYSBDT1JSVVBUIHBvaW50ZXIgYW5kIHJldHVybnMgbnVsbCBvbmx5IGZvciBhXG4gICAgICAvLyBnZW51aW5lbHkgYWJzZW50IG9uZSDigJQgdGhlIEVOT0VOVCBydWxlLiBBIGRpZSBoZXJlIG5vdyB0aHJvd3MsIGFuZCB0aGVcbiAgICAgIC8vIHRocm93IGxlYXZlcyB0aGUgdGFpbCB0aHJvdWdoIG1haW4ncyBmdW5uZWwgaW5zdGVhZCBvZiBleGl0aW5nIGZyb21cbiAgICAgIC8vIHRocmVlIGZyYW1lcyBkb3duIGluc2lkZSBhIHJlY29ubmVjdCBsb29wLlxuICAgICAgY29uc3QgcyA9IHJlYWRTZXNzaW9uKGJvdW5kSWQpO1xuICAgICAgaWYgKCFzKSByZXR1cm4gbnVsbDtcbiAgICAgIGlmICghYm91bmRJZCkgYm91bmRJZCA9IHMuc2Vzc2lvbl9pZDsgLy8gcGluIHRvIHRoZSBmaXJzdCBzZXNzaW9uIHdlIHJlc29sdmVkXG4gICAgICBpZiAoIWdyb3VuZGVkKSB7XG4gICAgICAgIGdyb3VuZGVkID0gdHJ1ZTtcbiAgICAgICAgLy8gZ3JvdW5kaW5nIGFuY2hvciDigJQgcGFyc2VhYmxlICsgdmlzaWJsZSBpbiBhIE1vbml0b3I7IG5hbWVzIHRoZSBiaW5kaW5nLlxuICAgICAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShcbiAgICAgICAgICBgJHtKU09OLnN0cmluZ2lmeSh7IHR5cGU6IFwiZ3JvdW5kaW5nXCIsIHNlc3Npb25faWQ6IHMuc2Vzc2lvbl9pZCwgcG9ydDogcy5wb3J0IH0pfVxcbmAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICByZXR1cm4gYGh0dHA6Ly8xMjcuMC4wLjE6JHtzLnBvcnR9YDtcbiAgICB9LFxuICAgIG9uVW5yZXNvbHZlZDogKHsgZXZlclJlc29sdmVkIH0pID0+IHtcbiAgICAgIGlmIChldmVyUmVzb2x2ZWQpIHJldHVybiBcInN0b3BcIjsgLy8gb3VyIHBpbm5lZCBzZXNzaW9uIHdlbnQgYXdheSDihpIgZG9uZVxuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXCIjIG5vIHNlc3Npb24geWV0LCByZXRyeWluZ+KAplxcblwiKTtcbiAgICAgIHJldHVybiBcInJldHJ5XCI7XG4gICAgfSxcbiAgICBwYXRoOiBcIi9ldmVudHNcIixcbiAgICBzaW5jZTogc2luY2VBcmcsXG4gICAgY3Vyc29yT2Y6IChldikgPT4gZXYuaWQsXG4gICAgdGVybWluYWw6IChldikgPT4gZXYudHlwZSA9PT0gXCJjbG9zZWRcIixcbiAgICBpZGxlTXM6IFRBSUxfSURMRV9NUyxcbiAgICBvbkNvbW1lbnQ6ICgpID0+IFwiOiBtYWdwaWUta2VlcGFsaXZlXCIsXG4gIH0pO1xufVxuXG5mdW5jdGlvbiBjbWRJbmZvKHNlc3Npb24/OiBzdHJpbmcpIHtcbiAgY29uc3QgcyA9IHJlYWRTZXNzaW9uKHNlc3Npb24pO1xuICBpZiAoIXMpIGRpZShcIm5vIHJ1bm5pbmcgbWFncGllIHNlc3Npb25cIiwgXCJub3RfZm91bmRcIik7XG4gIHByaW50SnNvbihzKTtcbn1cblxuZnVuY3Rpb24gY21kU2Vzc2lvbnMoKSB7XG4gIC8vIE1pcnJvciBwZXJzaXN0LnNlcnZlcidzIHNuYXBzaG90IGRpciByZXNvbHV0aW9uIChhdm9pZCBpbXBvcnRpbmcgbm9kZTpmcyBwYXRoXG4gIC8vIGxvZ2ljIHR3aWNlKTogJE1BR1BJRV9IT01FL3NuYXBzaG90cyBvciB+Ly5tYWdwaWUvc25hcHNob3RzLlxuICBjb25zdCBob21lID0gcHJvY2Vzcy5lbnYuTUFHUElFX0hPTUUgPz8gam9pbihwcm9jZXNzLmVudi5IT01FID8/IFwiXCIsIFwiLm1hZ3BpZVwiKTtcbiAgY29uc3QgZGlyID0gam9pbihob21lLCBcInNuYXBzaG90c1wiKTtcbiAgbGV0IGZpbGVzOiBzdHJpbmdbXTtcbiAgdHJ5IHtcbiAgICBmaWxlcyA9IHJlYWRkaXJTeW5jKGRpcikuZmlsdGVyKChmKSA9PiBmLmVuZHNXaXRoKFwiLmpzb25cIikpO1xuICB9IGNhdGNoIHtcbiAgICBwcmludEpzb24oeyBzZXNzaW9uczogW10gfSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHR5cGUgUm93ID0geyBpZDogc3RyaW5nOyB0aXRsZTogc3RyaW5nOyBlbGVtZW50czogbnVtYmVyOyBtdGltZTogbnVtYmVyIH07XG4gIGNvbnN0IHJvd3M6IFJvd1tdID0gW107XG4gIGZvciAoY29uc3QgZiBvZiBmaWxlcykge1xuICAgIGNvbnN0IHBhdGggPSBqb2luKGRpciwgZik7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHN0ID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMocGF0aCwgXCJ1dGY4XCIpKTtcbiAgICAgIHJvd3MucHVzaCh7XG4gICAgICAgIGlkOiBmLnJlcGxhY2UoL1xcLmpzb24kLywgXCJcIiksXG4gICAgICAgIHRpdGxlOiBzdC50aXRsZSxcbiAgICAgICAgZWxlbWVudHM6IEFycmF5LmlzQXJyYXkoc3QuZWxlbWVudHMpID8gc3QuZWxlbWVudHMubGVuZ3RoIDogMCxcbiAgICAgICAgbXRpbWU6IHN0YXRTeW5jKHBhdGgpLm10aW1lTXMsXG4gICAgICB9KTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8qIHNraXAgdW5yZWFkYWJsZSBzbmFwc2hvdCAqL1xuICAgIH1cbiAgfVxuICByb3dzLnNvcnQoKGEsIGIpID0+IGIubXRpbWUgLSBhLm10aW1lKTtcbiAgLy8gT05FIEpTT04gZG9jdW1lbnQsIGxpa2UgZXZlcnkgb3RoZXIgZGF0YSB2ZXJiLiBUaGlzIHByaW50ZWQgYSBwcm9zZSB0YWJsZVxuICAvLyB1bnRpbCB0aGUgbWFjaGluZS1tb2RlIGRlY2xhcmF0aW9uIHdlbnQgaW4sIGF0IHdoaWNoIHBvaW50IHRoZSB0b29sIHdhc1xuICAvLyBjbGFpbWluZyBgZGVmYXVsdE91dHB1dDogXCJqc29uXCJgIHdoaWxlIGFuc3dlcmluZyB0aGlzIHZlcmIgaW4gcHJvc2Ug4oCUIGFcbiAgLy8gZGVjbGFyYXRpb24gaXMgb25seSB3b3J0aCB3aGF0IGl0cyBsZWFzdCBob25lc3QgcGF0aCBtYWtlcyBpdC5cbiAgcHJpbnRKc29uKHsgc2Vzc2lvbnM6IHJvd3MgfSk7XG59XG5cbi8vIGBzb3VyY2UgPGltYWdlUGF0aD5gIOKAlCBjb21wdXRlIHNoYTI1Nls6MTZdICsgcGl4ZWwgc2l6ZSAoQnVuLkltYWdlKSBhbmQgcG9zdFxuLy8gc291cmNlLnNldC4gVGhlIGFnZW50IHJ1bnMgZGlzY292ZXIgc2VwYXJhdGVseTsgdGhpcyBqdXN0IHJlZ2lzdGVycyB0aGUgYm9hcmQuXG5hc3luYyBmdW5jdGlvbiBjbWRTb3VyY2Uoc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkLCBpbWFnZVBhdGg6IHN0cmluZykge1xuICBjb25zdCBmaWxlID0gQnVuLmZpbGUoaW1hZ2VQYXRoKTtcbiAgaWYgKCEoYXdhaXQgZmlsZS5leGlzdHMoKSkpIGRpZShgaW1hZ2Ugbm90IGZvdW5kOiAke2ltYWdlUGF0aH1gLCBcIm5vdF9mb3VuZFwiKTtcbiAgY29uc3QgYnl0ZXMgPSBuZXcgVWludDhBcnJheShhd2FpdCBmaWxlLmFycmF5QnVmZmVyKCkpO1xuICBjb25zdCBzaGEgPSBuZXcgQnVuLkNyeXB0b0hhc2hlcihcInNoYTI1NlwiKS51cGRhdGUoYnl0ZXMpLmRpZ2VzdChcImhleFwiKS5zbGljZSgwLCAxNik7XG4gIGNvbnN0IG1ldGEgPSBhd2FpdCBuZXcgQnVuLkltYWdlKGJ5dGVzKS5tZXRhZGF0YSgpO1xuICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHtcbiAgICB0eXBlOiBcInNvdXJjZS5zZXRcIixcbiAgICBwYXRoOiBpbWFnZVBhdGgsXG4gICAgc2l6ZTogW21ldGEud2lkdGggPz8gMCwgbWV0YS5oZWlnaHQgPz8gMF0sXG4gICAgc2hhLFxuICB9KTtcbn1cblxuLy8gYGVsZW1lbnQtYWRkIC0tYmJveCBcIngxLHkxLHgyLHkyXCIgWy0tbmFtZSAuLl0gWy0tdHlwZSAuLl1gIOKAlCBhZ2VudCBib3hlcyBhXG4vLyByZWdpb24gaW5jcmVtZW50YWxseSAoc291cmNlIHBpeGVscykuIE1pcnJvcnMgdGhlIHVzZXIncyBcIm1hcmsgYSBtaXNzZWQgcmVnaW9uXCIuXG5hc3luYyBmdW5jdGlvbiBjbWRFbGVtZW50QWRkKHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCwgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KSB7XG4gIGNvbnN0IHJhdyA9IHR5cGVvZiBmbGFncy5iYm94ID09PSBcInN0cmluZ1wiID8gZmxhZ3MuYmJveCA6IFwiXCI7XG4gIGNvbnN0IHBhcnRzID0gcmF3LnNwbGl0KFwiLFwiKS5tYXAoKG4pID0+IHBhcnNlSW50KG4udHJpbSgpLCAxMCkpO1xuICBpZiAocGFydHMubGVuZ3RoICE9PSA0IHx8IHBhcnRzLnNvbWUoKG4pID0+IE51bWJlci5pc05hTihuKSkpIHtcbiAgICBkaWUoJ3VzYWdlOiBlbGVtZW50LWFkZCAtLWJib3ggXCJ4MSx5MSx4Mix5MlwiIFstLW5hbWUgPG5hbWU+XSBbLS10eXBlIDx0eXBlPl0nKTtcbiAgfVxuICBjb25zdCBlbGVtZW50OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgYmJveDogcGFydHMgfTtcbiAgaWYgKHR5cGVvZiBmbGFncy5uYW1lID09PSBcInN0cmluZ1wiKSBlbGVtZW50Lm5hbWUgPSBmbGFncy5uYW1lO1xuICBpZiAodHlwZW9mIGZsYWdzLnR5cGUgPT09IFwic3RyaW5nXCIpIGVsZW1lbnQudHlwZSA9IGZsYWdzLnR5cGU7XG4gIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcImVsZW1lbnQuYWRkXCIsIGVsZW1lbnQgfSk7XG59XG5cbi8vIGBkaXNjb3ZlcmAg4oCUIHJlYWQgL3N0YXRlIGZvciBzb3VyY2UucGF0aCwgcnVuIGRpc2NvdmVyLnRzIG9uIGl0LCBidWlsZCB0aGVcbi8vIEVsZW1lbnRbXSAoc3RhdHVzIFwicHJvcG9zZWRcIiwgYmJveCBmcm9tIHRoZSBtYW5pZmVzdCdzIGJib3hfcGl4ZWwpLCBhbmQgUE9TVFxuLy8gZWxlbWVudHMuc2V0LiBUaGUgd2hvbGUgZGlzY292ZXLihpJicmVha2Rvd24gbG9vcCBpbiBvbmUgc2hvdCAoZm9yIHRoZSBhZ2VudCBvciBhXG4vLyB0ZXN0ZXIpLiBSZXF1aXJlcyBPUEVOUk9VVEVSX0FQSV9LRVkgaW4gdGhlIGVudmlyb25tZW50LlxuYXN5bmMgZnVuY3Rpb24gY21kRGlzY292ZXIoc2Vzc2lvbj86IHN0cmluZykge1xuICBjb25zdCBzID0gcmVxdWlyZVNlc3Npb24oc2Vzc2lvbik7XG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGkocy5wb3J0LCBcIkdFVFwiLCBcIi9zdGF0ZVwiKTtcbiAgaWYgKHN0YXR1cyAhPT0gMjAwKSBkaWUoYHN0YXRlIGZhaWxlZCAoSFRUUCAke3N0YXR1c30pYCwgXCJpbnRlcm5hbFwiKTtcbiAgY29uc3Qgc3JjID0gKGRhdGEgYXMgeyBzdGF0ZT86IHsgc291cmNlPzogeyBwYXRoPzogc3RyaW5nIH0gfSB9KS5zdGF0ZT8uc291cmNlO1xuICBjb25zdCBwYXRoID0gc3JjPy5wYXRoO1xuICBpZiAoIXBhdGgpIGRpZShcIm5vIHNvdXJjZSBzZXQg4oCUIGRyb3AgYSBjb21wb3NpdGUgKG9yIHJ1bjogc291cmNlIDxpbWFnZVBhdGg+KSBmaXJzdFwiLCBcImNvbmZsaWN0XCIpO1xuICBsZXQgbWFuaWZlc3Q6IEF3YWl0ZWQ8UmV0dXJuVHlwZTx0eXBlb2YgZGlzY292ZXI+PjtcbiAgdHJ5IHtcbiAgICBtYW5pZmVzdCA9IGF3YWl0IGRpc2NvdmVyKHBhdGgpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgaWYgKGUgaW5zdGFuY2VvZiBEaXNjb3ZlckVycm9yKSBkaWUoYGRpc2NvdmVyIGZhaWxlZDogJHtlLm1lc3NhZ2V9YCwgXCJpbnRlcm5hbFwiKTtcbiAgICB0aHJvdyBlO1xuICB9XG4gIGNvbnN0IGVsZW1lbnRzOiBFbGVtZW50W10gPSBtYW5pZmVzdC5lbGVtZW50cy5tYXAoKGUpID0+ICh7XG4gICAgaWQ6IG5ld0lkKFwiZVwiKSxcbiAgICBuYW1lOiBlLm5hbWUsXG4gICAgdHlwZTogZS50eXBlLFxuICAgIGJib3g6IGUuYmJveF9waXhlbCxcbiAgICBzdGF0dXM6IFwicHJvcG9zZWRcIixcbiAgfSkpO1xuICBjb25zdCBjb3N0ID0gbWFuaWZlc3QuY29zdF91c2QgPyBgIOKAlCAkJHttYW5pZmVzdC5jb3N0X3VzZC50b0ZpeGVkKDQpfWAgOiBcIlwiO1xuICBwcm9jZXNzLnN0ZGVyci53cml0ZShgbWFncGllOiBkaXNjb3ZlcmVkICR7ZWxlbWVudHMubGVuZ3RofSBlbGVtZW50KHMpIG9uICR7cGF0aH0ke2Nvc3R9XFxuYCk7XG4gIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcImVsZW1lbnRzLnNldFwiLCBlbGVtZW50cyB9KTtcbn1cblxuLy8gTWlycm9yIHJlbW92ZS5weSdzIHNhZmVfZmlsZW5hbWUgc28gdGhlIGN1dG91dCBmaWxlbmFtZSBpcyBzdGFibGUgKyB0cmF2ZXJzYWwtXG4vLyBzYWZlICh0aGUgc3VyZmFjZSBzZXJ2ZXMgaXQgdmlhIC9hc3NldHMvPGJhc2VuYW1lPikuXG5mdW5jdGlvbiBzYW5pdGl6ZShuYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBjbGVhbmVkID0gQXJyYXkuZnJvbShuYW1lIHx8IFwiXCIpXG4gICAgLm1hcCgoYykgPT4gKC9bQS1aYS16MC05XFwtXy5dLy50ZXN0KGMpID8gYyA6IFwiX1wiKSlcbiAgICAuam9pbihcIlwiKVxuICAgIC5yZXBsYWNlKC9eXFwuKy8sIFwiXCIpOyAvLyBubyBoaWRkZW4gZG90ZmlsZXNcbiAgcmV0dXJuIGNsZWFuZWQgfHwgXCJlbGVtZW50XCI7XG59XG5cbi8vIFRoZSBvbi1kaXNrIGZpbGVuYW1lIGZvciBhIHZlcnNpb246IGVhY2ggTU9ERUwgZ2V0cyBpdHMgb3duIGZpbGUgc28gdmVyc2lvbnNcbi8vIGRvbid0IG92ZXJ3cml0ZSBlYWNoIG90aGVyIGFuZCBkb24ndCBjb2xsaWRlIGluIHRoZSBicm93c2VyIGNhY2hlICh0d28gdmVyc2lvbnNcbi8vIGF0IHRoZSBzYW1lIFVSTCB3b3VsZCBzaG93IGEgc3RhbGUgaW1hZ2UpLiBUaGUgcmF3IGNyb3Aga2VlcHMgdGhlIGJhcmVcbi8vIGA8bmFtZT4ucG5nYDsgZXZlcnkgcmVtb3ZhbCBtb2RlbCBpcyBzdWZmaXhlZCBgPG5hbWU+Ljxtb2RlbD4ucG5nYC5cbmV4cG9ydCBmdW5jdGlvbiBjdXRvdXRGaWxlbmFtZShuYW1lOiBzdHJpbmcsIGJhY2tlbmQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtzYW5pdGl6ZShuYW1lKX0ke2JhY2tlbmQgPT09IFwiY3JvcFwiID8gXCJcIiA6IGAuJHtiYWNrZW5kfWB9LnBuZ2A7XG59XG5cbi8vIGBleHRyYWN0IFstLWlkcyBhLGJdIFstLXJlbW92ZV0gWy0tYWxwaGEgYXV0b3xhbGx8bm9uZV0gWy0tcGFkIE5dYCDigJQgY3V0IGFcbi8vIHNsaWNlIGZvciBldmVyeSBub24tZHJvcHBlZCBlbGVtZW50IChvciBqdXN0IGAtLWlkc2AsIG9uIHJlLWN1dCkuIERFRkFVTFQgaXNcbi8vIENST1AtT05MWSAoYSByYXcgUGlsbG93IHNsaWNlLCBubyBiYWNrZ3JvdW5kIHJlbW92YWwg4oaSIGJhY2tlbmQgbGFiZWwgXCJjcm9wXCIpLlxuLy8gYC0tcmVtb3ZlYCBzd2l0Y2hlcyBvbiByZW1iZyBiYWNrZ3JvdW5kIHJlbW92YWwgKC0tYWxwaGEgYXV0byDihpIgYmFja2VuZFxuLy8gXCJyZW1iZ1wiKSBmb3IgdGhlIG5leHQgcGhhc2U7IGFuIGV4cGxpY2l0IGAtLWFscGhhYCBvdmVycmlkZXMgdGhlIHBvbGljeS5cbi8vIFJlYWRzIC9zdGF0ZSBmb3Igc291cmNlLnBhdGggKyBlbGVtZW50cywgY3V0cyBlYWNoIHZpYSByZW1iZ0JhY2tlbmQgKOKGklxuLy8gcmVtb3ZlLnB5KSwgYW5kIHBvc3RzIHRoZSByZXN1bHQgYmFjayB3aXRoIGVsZW1lbnQuYWRkVmVyc2lvbi4gU2V0cyB0aGUgYnVzeVxuLy8gc3Bpbm5lciBhcm91bmQgdGhlIGxvb3A7IHBlci1lbGVtZW50IHByb2dyZXNzIOKGkiBzdGRlcnIsIHN1bW1hcnkg4oaSIHN0ZG91dC5cbmFzeW5jIGZ1bmN0aW9uIGNtZEV4dHJhY3Qoc2Vzc2lvbjogc3RyaW5nIHwgdW5kZWZpbmVkLCBmbGFnczogUmVjb3JkPHN0cmluZywgc3RyaW5nIHwgYm9vbGVhbj4pIHtcbiAgY29uc3QgcyA9IHJlcXVpcmVTZXNzaW9uKHNlc3Npb24pO1xuICBpZiAoIXMuZmlsZXNfZGlyKSBkaWUoXCJzZXNzaW9uIGhhcyBubyBmaWxlc19kaXIg4oCUIGNhbm5vdCBtYXRlcmlhbGl6ZSBjdXRvdXRzXCIsIFwiY29uZmxpY3RcIik7XG5cbiAgLy8gUG9saWN5OiBjcm9wLW9ubHkgYnkgZGVmYXVsdDsgLS1yZW1vdmUgZmxpcHMgdG8gcmVtYmcgKGF1dG8pOyAtLWFscGhhIHdpbnMuXG4gIGxldCBhbHBoYTogQWxwaGFQb2xpY3kgPSBmbGFncy5yZW1vdmUgPT09IHRydWUgPyBcImF1dG9cIiA6IFwibm9uZVwiO1xuICBpZiAodHlwZW9mIGZsYWdzLmFscGhhID09PSBcInN0cmluZ1wiKSB7XG4gICAgaWYgKCFbXCJhdXRvXCIsIFwiYWxsXCIsIFwibm9uZVwiXS5pbmNsdWRlcyhmbGFncy5hbHBoYSkpIHtcbiAgICAgIGRpZShgLS1hbHBoYSBtdXN0IGJlIGF1dG98YWxsfG5vbmUgKGdvdCAke2ZsYWdzLmFscGhhfSlgKTtcbiAgICB9XG4gICAgYWxwaGEgPSBmbGFncy5hbHBoYSBhcyBBbHBoYVBvbGljeTtcbiAgfVxuICAvLyBUaGUgdmVyc2lvbiBsYWJlbCA9IHRoZSByZW1vdmFsIE1PREVMOiBcImNyb3BcIiAobm8gcmVtb3ZhbCksIFwicmVtYmdcIiAocmVtYmcnc1xuICAvLyBkZWZhdWx0IHUybmV0KSwgb3IgYSBzcGVjaWZpYyByZW1iZyBtb2RlbCBuYW1lIG9uIGEgcmV0cnkgKC0tbW9kZWwsIGUuZy5cbiAgLy8gaXNuZXQtZ2VuZXJhbC11c2UpLiBFYWNoIGxhYmVsIOKGkiBpdHMgb3duIGZpbGUgKGN1dG91dEZpbGVuYW1lKSBzbyB2ZXJzaW9uc1xuICAvLyBjb2V4aXN0ICsgZG9uJ3QgY2FjaGUtY29sbGlkZTsgYWRkVmVyc2lvbiB1cHNlcnRzIGJ5IHRoaXMgbGFiZWwuXG4gIGNvbnN0IHJlcU1vZGVsID0gdHlwZW9mIGZsYWdzLm1vZGVsID09PSBcInN0cmluZ1wiID8gZmxhZ3MubW9kZWwgOiB1bmRlZmluZWQ7XG4gIC8vIFJvdXRlIGJ5IGlkIFNIQVBFLCBuZXZlciBhIGhhcmRjb2RlZCBtb2RlbCBsaXN0OiBhIG1lZGlhLWZvcmdlIGlkIGlzIGFcbiAgLy8gcHJvdmlkZXIgcGF0aCAoaGFzIFwiL1wiKTsgYSBiYXJlIG5hbWUgaXMgYSByZW1iZyBtb2RlbC4gVGhlIGFnZW50IGRpc2NvdmVyc1xuICAvLyBtZWRpYS1mb3JnZSBiZy1yZW1vdmUgaWRzIHZpYSBgbWVkaWEtZm9yZ2UgbW9kZWxzIGxpc3RgIGFuZCBwYXNzZXMgb25lIGhlcmUuXG4gIGNvbnN0IHVzZU1lZGlhRm9yZ2UgPSByZXFNb2RlbCA/IGlzTWVkaWFGb3JnZU1vZGVsKHJlcU1vZGVsKSA6IGZhbHNlO1xuICBjb25zdCByZW1iZ01vZGVsID0gcmVxTW9kZWwgJiYgIXVzZU1lZGlhRm9yZ2UgPyByZXFNb2RlbCA6IHVuZGVmaW5lZDtcbiAgLy8gVGhlIHZlcnNpb24gbGFiZWwgKGl0cyBzdHJpcCByb3cgKyBmaWxlbmFtZSkuIEZyaWVuZGx5OiBleHBsaWNpdCAtLWxhYmVsIHdpbnM7XG4gIC8vIGVsc2UgZm9yIGEgbWVkaWEtZm9yZ2UgcGF0aCBpZCB1c2UgdGhlIHNlZ21lbnQgYWZ0ZXIgdGhlIHZlbmRvcjsgZWxzZSB0aGVcbiAgLy8gbW9kZWwgbmFtZS4gY3JvcC1vbmx5IGhhcyBubyBtb2RlbC5cbiAgY29uc3QgZXhwbGljaXRMYWJlbCA9IHR5cGVvZiBmbGFncy5sYWJlbCA9PT0gXCJzdHJpbmdcIiA/IGZsYWdzLmxhYmVsIDogdW5kZWZpbmVkO1xuICBjb25zdCBsYWJlbCA9XG4gICAgYWxwaGEgPT09IFwibm9uZVwiXG4gICAgICA/IFwiY3JvcFwiXG4gICAgICA6IChleHBsaWNpdExhYmVsID8/XG4gICAgICAgICh1c2VNZWRpYUZvcmdlID8gKChyZXFNb2RlbCBhcyBzdHJpbmcpLnNwbGl0KFwiL1wiKVsxXSA/PyBcImNsb3VkXCIpIDogKHJlcU1vZGVsID8/IFwicmVtYmdcIikpKTtcbiAgLy8gRGVmYXVsdCBwYWQgPSAwOiB0aGUgc2xpY2UgbXVzdCBtYXRjaCB0aGUgYm94IHRoZSB1c2VyIGRyZXcgKFdZU0lXWUcpLiBUaGUgYm94XG4gIC8vIElTIHRoZSBwYWRkaW5nIGNvbnRyb2wg4oCUIGRyYWcgYSBoYW5kbGUgb3V0IGZvciBicmVhdGhpbmcgcm9vbS4gKHJlbW92ZS5weSdzIG93blxuICAvLyBkZWZhdWx0IGlzIDgsIHNvIHdlIE1VU1QgcGFzcyBhbiBleHBsaWNpdCAwLCBub3QgdW5kZWZpbmVkLikgLS1wYWQgb3ZlcnJpZGVzLlxuICBjb25zdCBwYWQgPSB0eXBlb2YgZmxhZ3MucGFkID09PSBcInN0cmluZ1wiID8gcGFyc2VJbnQoZmxhZ3MucGFkLCAxMCkgOiAwO1xuICBpZiAoTnVtYmVyLmlzTmFOKHBhZCkpIGRpZShcIi0tcGFkIG11c3QgYmUgYSBudW1iZXJcIik7XG4gIGNvbnN0IGlkRmlsdGVyID1cbiAgICB0eXBlb2YgZmxhZ3MuaWRzID09PSBcInN0cmluZ1wiXG4gICAgICA/IG5ldyBTZXQoXG4gICAgICAgICAgZmxhZ3MuaWRzXG4gICAgICAgICAgICAuc3BsaXQoXCIsXCIpXG4gICAgICAgICAgICAubWFwKCh4KSA9PiB4LnRyaW0oKSlcbiAgICAgICAgICAgIC5maWx0ZXIoQm9vbGVhbiksXG4gICAgICAgIClcbiAgICAgIDogdW5kZWZpbmVkO1xuXG4gIGNvbnN0IHsgc3RhdHVzLCBkYXRhIH0gPSBhd2FpdCBhcGkocy5wb3J0LCBcIkdFVFwiLCBcIi9zdGF0ZVwiKTtcbiAgaWYgKHN0YXR1cyAhPT0gMjAwKSBkaWUoYHN0YXRlIGZhaWxlZCAoSFRUUCAke3N0YXR1c30pYCwgXCJpbnRlcm5hbFwiKTtcbiAgY29uc3Qgc3QgPSAoZGF0YSBhcyB7IHN0YXRlPzogeyBzb3VyY2U/OiB7IHBhdGg/OiBzdHJpbmcgfTsgZWxlbWVudHM/OiBFbGVtZW50W10gfSB9KS5zdGF0ZTtcbiAgY29uc3Qgc291cmNlUGF0aCA9IHN0Py5zb3VyY2U/LnBhdGg7XG4gIGlmICghc291cmNlUGF0aClcbiAgICBkaWUoXCJubyBzb3VyY2Ugc2V0IOKAlCBkcm9wIGEgY29tcG9zaXRlIChvciBydW46IHNvdXJjZSA8aW1hZ2VQYXRoPikgZmlyc3RcIiwgXCJjb25mbGljdFwiKTtcbiAgbGV0IGVsZW1lbnRzID0gKHN0Py5lbGVtZW50cyA/PyBbXSkuZmlsdGVyKChlKSA9PiBlLnN0YXR1cyAhPT0gXCJkcm9wcGVkXCIpO1xuICBpZiAoaWRGaWx0ZXIpIGVsZW1lbnRzID0gZWxlbWVudHMuZmlsdGVyKChlKSA9PiBpZEZpbHRlci5oYXMoZS5pZCkpO1xuICAvLyBXaGVuIFJFTU9WSU5HLCBuZXZlciB0b3VjaCBhbHBoYS1mb3JiaWRkZW4gdHlwZXMgKHBhbGV0dGUgLyBzY3JlZW5zaG90IC9cbiAgLy8gdHlwb2dyYXBoeSkg4oCUIHRoZXkgc3RheSB3aG9sZSBieSBwb2xpY3kuIFNraXAgdGhlbSBzbyB3ZSBkb24ndCB3cml0ZSBhXG4gIC8vIG1pc2xhYmVsZWQsIHJlZHVuZGFudCBcInJlbW92YWxcIiB2ZXJzaW9uIHRoYXQncyByZWFsbHkganVzdCB0aGUgY3JvcC5cbiAgbGV0IGtlcHRXaG9sZSA9IDA7XG4gIGlmIChhbHBoYSAhPT0gXCJub25lXCIpIHtcbiAgICBjb25zdCBiZWZvcmUgPSBlbGVtZW50cy5sZW5ndGg7XG4gICAgZWxlbWVudHMgPSBlbGVtZW50cy5maWx0ZXIoKGUpID0+IHNob3VsZFJlbW92ZShlLnR5cGUsIGFscGhhKSk7XG4gICAga2VwdFdob2xlID0gYmVmb3JlIC0gZWxlbWVudHMubGVuZ3RoO1xuICB9XG4gIGlmICghZWxlbWVudHMubGVuZ3RoKSB7XG4gICAgZGllKFxuICAgICAga2VwdFdob2xlID4gMFxuICAgICAgICA/IGBub3RoaW5nIHRvIHJlbW92ZSDigJQgJHtrZXB0V2hvbGV9IHNlbGVjdGVkIGVsZW1lbnQke2tlcHRXaG9sZSA9PT0gMSA/IFwiIGlzIGFcIiA6IFwicyBhcmVcIn0ga2VwdC13aG9sZSB0eXBlJHtrZXB0V2hvbGUgPT09IDEgPyBcIlwiIDogXCJzXCJ9IChwYWxldHRlL3NjcmVlbnNob3QvdHlwb2dyYXBoeSlgXG4gICAgICAgIDogaWRGaWx0ZXJcbiAgICAgICAgICA/IFwibm8gbWF0Y2hpbmcgZXh0cmFjdGFibGUgZWxlbWVudHMgZm9yIC0taWRzXCJcbiAgICAgICAgICA6IFwibm8gZXh0cmFjdGFibGUgZWxlbWVudHMgKGFsbCBkcm9wcGVkIG9yIG5vbmUgZGlzY292ZXJlZClcIixcbiAgICApO1xuICB9XG5cbiAgYXdhaXQgYXBpKHMucG9ydCwgXCJQT1NUXCIsIFwiL2NtZFwiLCB7IHR5cGU6IFwic3RhdHVzXCIsIGJ1c3k6IHRydWUsIHRleHQ6IFwiZXh0cmFjdGluZ+KAplwiIH0pO1xuICBsZXQgZG9uZSA9IDA7XG4gIGxldCBmYWlsZWQgPSAwO1xuICB0cnkge1xuICAgIGZvciAoY29uc3QgZWwgb2YgZWxlbWVudHMpIHtcbiAgICAgIGNvbnN0IG91dFBhdGggPSBqb2luKHMuZmlsZXNfZGlyLCBjdXRvdXRGaWxlbmFtZShlbC5uYW1lLCBsYWJlbCkpO1xuICAgICAgdHJ5IHtcbiAgICAgICAgLy8gQ2xvdWQgKG1lZGlhLWZvcmdlKSBydW5zIG9uIHRoZSBlbGVtZW50J3MgZXhpc3RpbmcgY3JvcCBpbWFnZSAoc2luZ2xlLVxuICAgICAgICAvLyBpbWFnZSB0cmFuc2Zvcm0pOyByZW1iZyBjcm9wcyB0aGUgYmJveCBmcm9tIHRoZSBzb3VyY2UgaXRzZWxmLlxuICAgICAgICBjb25zdCBjdXRvdXQgPSB1c2VNZWRpYUZvcmdlXG4gICAgICAgICAgPyBhd2FpdCBtZWRpYUZvcmdlQmFja2VuZC5jdXQoXG4gICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBzb3VyY2VQYXRoOiBqb2luKHMuZmlsZXNfZGlyLCBjdXRvdXRGaWxlbmFtZShlbC5uYW1lLCBcImNyb3BcIikpLFxuICAgICAgICAgICAgICAgIGJib3g6IGVsLmJib3gsXG4gICAgICAgICAgICAgICAgdHlwZTogZWwudHlwZSxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgb3V0UGF0aCxcbiAgICAgICAgICAgICAgeyBtb2RlbDogcmVxTW9kZWwgfSxcbiAgICAgICAgICAgIClcbiAgICAgICAgICA6IGF3YWl0IHJlbWJnQmFja2VuZC5jdXQoeyBzb3VyY2VQYXRoLCBiYm94OiBlbC5iYm94LCB0eXBlOiBlbC50eXBlIH0sIG91dFBhdGgsIHtcbiAgICAgICAgICAgICAgYWxwaGEsXG4gICAgICAgICAgICAgIHBhZCxcbiAgICAgICAgICAgICAgbW9kZWw6IHJlbWJnTW9kZWwsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgYXdhaXQgYXBpKHMucG9ydCwgXCJQT1NUXCIsIFwiL2NtZFwiLCB7XG4gICAgICAgICAgdHlwZTogXCJlbGVtZW50LmFkZFZlcnNpb25cIixcbiAgICAgICAgICBpZDogZWwuaWQsXG4gICAgICAgICAgLy8gYWRkVmVyc2lvbiB1cHNlcnRzIGJ5IG1vZGVsIChidW1wcyByZXYg4oaSIGNhY2hlLWJ1c3QpIGFuZCBjbGVhcnMgdGhlXG4gICAgICAgICAgLy8gZmxhZzsgY3JvcCA9IHJhdywgcmVtYmcgbW9kZWwgPSBsb2NhbCwgbWVkaWEtZm9yZ2UgPSBjbG91ZC5cbiAgICAgICAgICB2ZXJzaW9uOiB7XG4gICAgICAgICAgICBpZDogbmV3SWQoXCJ2XCIpLFxuICAgICAgICAgICAgbW9kZWw6IGxhYmVsLCAvLyBcImNyb3BcIiB8IFwicmVtYmdcIiB8IDxyZW1iZyBtb2RlbD4gfCA8bWVkaWEtZm9yZ2UgbGFiZWw+XG4gICAgICAgICAgICBraW5kOiBsYWJlbCA9PT0gXCJjcm9wXCIgPyBcInJhd1wiIDogdXNlTWVkaWFGb3JnZSA/IFwiY2xvdWRcIiA6IFwibG9jYWxcIixcbiAgICAgICAgICAgIHBhdGg6IGN1dG91dC5wYXRoLFxuICAgICAgICAgICAgcmV2OiAwLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgY2hvb3NlOiB0cnVlLFxuICAgICAgICB9KTtcbiAgICAgICAgZG9uZSsrO1xuICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgbWFncGllOiBjdXQgJHtlbC5uYW1lfSAoJHtlbC50eXBlfSwgJHtsYWJlbH0pIOKGkiAke2N1dG91dC5wYXRofVxcbmApO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBmYWlsZWQrKztcbiAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICAgYG1hZ3BpZTogY3V0IEZBSUxFRCBmb3IgJHtlbC5uYW1lfTogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSl9XFxuYCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG4gIH0gZmluYWxseSB7XG4gICAgYXdhaXQgYXBpKHMucG9ydCwgXCJQT1NUXCIsIFwiL2NtZFwiLCB7IHR5cGU6IFwic3RhdHVzXCIsIGJ1c3k6IGZhbHNlIH0pO1xuICB9XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBjdXQ6IGRvbmUsIGZhaWxlZCwgdG90YWw6IGVsZW1lbnRzLmxlbmd0aCwga2VwdFdob2xlLCBtb2RlbDogbGFiZWwgfSk7XG59XG5cbmZ1bmN0aW9uIGVzY2FwZUh0bWwoczogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHMucmVwbGFjZShcbiAgICAvWyY8PlwiXS9nLFxuICAgIChjKSA9PiAoeyBcIiZcIjogXCImYW1wO1wiLCBcIjxcIjogXCImbHQ7XCIsIFwiPlwiOiBcIiZndDtcIiwgJ1wiJzogXCImcXVvdDtcIiB9KVtjXSBhcyBzdHJpbmcsXG4gICk7XG59XG5cbnR5cGUgTWFuaWZlc3RBc3NldCA9IHtcbiAgbmFtZTogc3RyaW5nO1xuICB0eXBlOiBzdHJpbmc7XG4gIG1vZGVsOiBzdHJpbmc7XG4gIGtpbmQ6IHN0cmluZyB8IG51bGw7XG4gIGJib3g6IG51bWJlcltdO1xuICBmaWxlOiBzdHJpbmc7XG4gIGNyb3A6IHN0cmluZyB8IG51bGw7XG59O1xuXG4vLyBBIHNlbGYtY29udGFpbmVkIGNvbnRhY3Qgc2hlZXQgKG1hZ3BpZSBjcmVhbSBpZGVudGl0eSkg4oCUIG9wZW4gaW4gYSBicm93c2VyLCBub1xuLy8gZGVwcy4gQmFja2Ryb3AgdG9nZ2xlIChjaGVja2VyL3doaXRlL2dyYXkvYmxhY2spIHRvIGp1ZGdlIHRyYW5zcGFyZW5jeSwgYW5kXG4vLyB0eXBlIGZpbHRlcnMgYnVpbHQgZnJvbSB0aGUgdGF4b25vbXkgd2UgdGFnZ2VkIGR1cmluZyB0aGUgcnVuLiBgYS5maWxlYCBpcyB0aGVcbi8vIGluLXppcCBwYXRoIChhc3NldHMvPG5hbWU+LnBuZykuXG5mdW5jdGlvbiBidWlsZEdhbGxlcnlIdG1sKHRpdGxlOiBzdHJpbmcsIGFzc2V0czogTWFuaWZlc3RBc3NldFtdKTogc3RyaW5nIHtcbiAgY29uc3QgdHlwZXMgPSBbLi4ubmV3IFNldChhc3NldHMubWFwKChhKSA9PiBhLnR5cGUpKV0uc29ydCgpO1xuICBjb25zdCB0eXBlQ2hpcHMgPSBbXCJhbGxcIiwgLi4udHlwZXNdXG4gICAgLm1hcCgodCkgPT4ge1xuICAgICAgY29uc3QgbiA9IHQgPT09IFwiYWxsXCIgPyBhc3NldHMubGVuZ3RoIDogYXNzZXRzLmZpbHRlcigoYSkgPT4gYS50eXBlID09PSB0KS5sZW5ndGg7XG4gICAgICByZXR1cm4gYDxidXR0b24gY2xhc3M9XCJjaGlwJHt0ID09PSBcImFsbFwiID8gXCIgYWN0aXZlXCIgOiBcIlwifVwiIGRhdGEtZmlsdGVyPVwiJHtlc2NhcGVIdG1sKHQpfVwiPiR7ZXNjYXBlSHRtbCh0KX0gPHNwYW4gY2xhc3M9XCJuXCI+JHtufTwvc3Bhbj48L2J1dHRvbj5gO1xuICAgIH0pXG4gICAgLmpvaW4oXCJcIik7XG4gIGNvbnN0IGNhcmRzID0gYXNzZXRzXG4gICAgLm1hcChcbiAgICAgIChhKSA9PiBgICAgICAgPGZpZ3VyZSBjbGFzcz1cImNhcmRcIiBkYXRhLXR5cGU9XCIke2VzY2FwZUh0bWwoYS50eXBlKX1cIj5cbiAgICAgICAgPGRpdiBjbGFzcz1cInRodW1iXCI+PGltZyBzcmM9XCIke2VzY2FwZUh0bWwoYS5maWxlKX1cIiBhbHQ9XCIke2VzY2FwZUh0bWwoYS5uYW1lKX1cIj48L2Rpdj5cbiAgICAgICAgPGZpZ2NhcHRpb24+XG4gICAgICAgICAgPHNwYW4gY2xhc3M9XCJuYW1lXCI+JHtlc2NhcGVIdG1sKGEubmFtZSl9PC9zcGFuPlxuICAgICAgICAgIDxzcGFuIGNsYXNzPVwibWV0YVwiPiR7ZXNjYXBlSHRtbChhLnR5cGUpfSDCtyAke2VzY2FwZUh0bWwoYS5tb2RlbCl9JHthLmtpbmQgPyBgICgke2VzY2FwZUh0bWwoYS5raW5kKX0pYCA6IFwiXCJ9PC9zcGFuPlxuICAgICAgICA8L2ZpZ2NhcHRpb24+XG4gICAgICA8L2ZpZ3VyZT5gLFxuICAgIClcbiAgICAuam9pbihcIlxcblwiKTtcbiAgcmV0dXJuIGA8IWRvY3R5cGUgaHRtbD5cbjxodG1sIGxhbmc9XCJlblwiPjxoZWFkPjxtZXRhIGNoYXJzZXQ9XCJ1dGYtOFwiPlxuPHRpdGxlPiR7ZXNjYXBlSHRtbCh0aXRsZSl9IOKAlCBtYWdwaWUgYXNzZXRzPC90aXRsZT5cbjxzdHlsZT5cbiAgOnJvb3QgeyAtLWNyZWFtOiNmNmYxZTc7IC0taW5rOiMxNDE4MWI7IC0tbGluZTojZTJkOWM2OyAtLWluZGlnbzojNWI1YmYwOyB9XG4gIGJvZHkgeyBmb250LWZhbWlseTotYXBwbGUtc3lzdGVtLHN5c3RlbS11aSxzYW5zLXNlcmlmOyBiYWNrZ3JvdW5kOnZhcigtLWNyZWFtKTsgY29sb3I6dmFyKC0taW5rKTsgbWFyZ2luOjA7IHBhZGRpbmc6MjhweDsgfVxuICBoMSB7IGZvbnQtc2l6ZToyMHB4OyBmb250LXdlaWdodDo3MDA7IG1hcmdpbjowOyB9IC5jb3VudCB7IGNvbG9yOiM5YThmNzg7IGZvbnQtd2VpZ2h0OjQwMDsgfVxuICAudG9vbGJhciB7IGRpc3BsYXk6ZmxleDsgZ2FwOjE4cHg7IGFsaWduLWl0ZW1zOmNlbnRlcjsgZmxleC13cmFwOndyYXA7IG1hcmdpbjoxNnB4IDAgNHB4OyB9XG4gIC5ncm91cCB7IGRpc3BsYXk6ZmxleDsgZ2FwOjZweDsgYWxpZ24taXRlbXM6Y2VudGVyOyB9XG4gIC5sYWJlbCB7IGZvbnQtc2l6ZToxMXB4OyBjb2xvcjojOWE4Zjc4OyB0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7IGxldHRlci1zcGFjaW5nOi4wNGVtOyB9XG4gIC8qIGJhY2tkcm9wID0gY29sb3Igc3dhdGNoZXMgKG5vdCB3b3Jkcyk7IHRyYW5zcGFyZW50ID0gYSBtaW5pIGNoZWNrZXIgc3F1YXJlICovXG4gIC5zdyB7IHdpZHRoOjIycHg7IGhlaWdodDoyMnB4OyBwYWRkaW5nOjA7IGJvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7IGJvcmRlci1yYWRpdXM6NXB4OyBjdXJzb3I6cG9pbnRlcjsgYm94LXNpemluZzpib3JkZXItYm94OyB9XG4gIC5zdy5hY3RpdmUgeyBvdXRsaW5lOjJweCBzb2xpZCB2YXIoLS1pbmRpZ28pOyBvdXRsaW5lLW9mZnNldDoxcHg7IH1cbiAgLnN3LmNoZWNrZXIgeyBiYWNrZ3JvdW5kLWNvbG9yOiNmZmY7XG4gICAgYmFja2dyb3VuZC1pbWFnZTpsaW5lYXItZ3JhZGllbnQoNDVkZWcsI2M5YzljOSAyNSUsdHJhbnNwYXJlbnQgMjUlKSxsaW5lYXItZ3JhZGllbnQoLTQ1ZGVnLCNjOWM5YzkgMjUlLHRyYW5zcGFyZW50IDI1JSksbGluZWFyLWdyYWRpZW50KDQ1ZGVnLHRyYW5zcGFyZW50IDc1JSwjYzljOWM5IDc1JSksbGluZWFyLWdyYWRpZW50KC00NWRlZyx0cmFuc3BhcmVudCA3NSUsI2M5YzljOSA3NSUpO1xuICAgIGJhY2tncm91bmQtc2l6ZTo4cHggOHB4OyBiYWNrZ3JvdW5kLXBvc2l0aW9uOjAgMCwwIDRweCw0cHggLTRweCwtNHB4IDA7IH1cbiAgLyogc2l6ZSA9IGEgc21hbGwgUy9NL0wgc2VnbWVudGVkIGNvbnRyb2wgKi9cbiAgLnNlZyB7IGZvbnQ6aW5oZXJpdDsgZm9udC1zaXplOjEycHg7IHBhZGRpbmc6NHB4IDlweDsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTsgYmFja2dyb3VuZDojZmZmZGY4OyBjb2xvcjp2YXIoLS1pbmspOyBjdXJzb3I6cG9pbnRlcjsgfVxuICAuc2VnOmZpcnN0LWNoaWxkIHsgYm9yZGVyLXJhZGl1czo2cHggMCAwIDZweDsgfSAuc2VnOmxhc3QtY2hpbGQgeyBib3JkZXItcmFkaXVzOjAgNnB4IDZweCAwOyB9IC5zZWcrLnNlZyB7IGJvcmRlci1sZWZ0Om5vbmU7IH1cbiAgLnNlZy5hY3RpdmUgeyBiYWNrZ3JvdW5kOnZhcigtLWluZGlnbyk7IGNvbG9yOiNmZmY7IGJvcmRlci1jb2xvcjp2YXIoLS1pbmRpZ28pOyB9XG4gIC5jaGlwIHsgZm9udDppbmhlcml0OyBmb250LXNpemU6MTJweDsgcGFkZGluZzo0cHggMTBweDsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTsgYm9yZGVyLXJhZGl1czo5OTlweDsgYmFja2dyb3VuZDojZmZmZGY4OyBjb2xvcjp2YXIoLS1pbmspOyBjdXJzb3I6cG9pbnRlcjsgfVxuICAuY2hpcC5hY3RpdmUgeyBiYWNrZ3JvdW5kOnZhcigtLWluZGlnbyk7IGNvbG9yOiNmZmY7IGJvcmRlci1jb2xvcjp2YXIoLS1pbmRpZ28pOyB9XG4gIC5jaGlwIC5uIHsgb3BhY2l0eTouNjsgbWFyZ2luLWxlZnQ6MnB4OyB9XG4gIC5ncmlkIHsgZGlzcGxheTpncmlkOyBncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KGF1dG8tZmlsbCxtaW5tYXgoMTcwcHgsMWZyKSk7IGdhcDoxMHB4OyBtYXJnaW4tdG9wOjE2cHg7IH1cbiAgYm9keVtkYXRhLXNpemU9XCJzbVwiXSAuZ3JpZCB7IGdyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoYXV0by1maWxsLG1pbm1heCgxMzJweCwxZnIpKTsgfVxuICBib2R5W2RhdGEtc2l6ZT1cImxnXCJdIC5ncmlkIHsgZ3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdChhdXRvLWZpbGwsbWlubWF4KDI2NHB4LDFmcikpOyBnYXA6MTRweDsgfVxuICAuY2FyZCB7IGJhY2tncm91bmQ6I2ZmZmRmODsgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTsgYm9yZGVyLXJhZGl1czoxMHB4OyBvdmVyZmxvdzpoaWRkZW47IG1pbi13aWR0aDowOyB9XG4gIC50aHVtYiB7IGhlaWdodDoxNjBweDsgZGlzcGxheTpmbGV4OyBhbGlnbi1pdGVtczpjZW50ZXI7IGp1c3RpZnktY29udGVudDpjZW50ZXI7IGJhY2tncm91bmQtY29sb3I6I2ZmZjtcbiAgICBiYWNrZ3JvdW5kLWltYWdlOmxpbmVhci1ncmFkaWVudCg0NWRlZywjZTdlMGQyIDI1JSx0cmFuc3BhcmVudCAyNSUpLGxpbmVhci1ncmFkaWVudCgtNDVkZWcsI2U3ZTBkMiAyNSUsdHJhbnNwYXJlbnQgMjUlKSxsaW5lYXItZ3JhZGllbnQoNDVkZWcsdHJhbnNwYXJlbnQgNzUlLCNlN2UwZDIgNzUlKSxsaW5lYXItZ3JhZGllbnQoLTQ1ZGVnLHRyYW5zcGFyZW50IDc1JSwjZTdlMGQyIDc1JSk7XG4gICAgYmFja2dyb3VuZC1zaXplOjE2cHggMTZweDsgYmFja2dyb3VuZC1wb3NpdGlvbjowIDAsMCA4cHgsOHB4IC04cHgsLThweCAwOyB9XG4gIGJvZHlbZGF0YS1zaXplPVwic21cIl0gLnRodW1iIHsgaGVpZ2h0OjExMnB4OyB9IGJvZHlbZGF0YS1zaXplPVwibGdcIl0gLnRodW1iIHsgaGVpZ2h0OjI0MHB4OyB9XG4gIGJvZHlbZGF0YS1iZz1cIndoaXRlXCJdIC50aHVtYiB7IGJhY2tncm91bmQ6I2ZmZiFpbXBvcnRhbnQ7IGJhY2tncm91bmQtaW1hZ2U6bm9uZSFpbXBvcnRhbnQ7IH1cbiAgYm9keVtkYXRhLWJnPVwiZ3JheVwiXSAudGh1bWIgeyBiYWNrZ3JvdW5kOiM4YThhOGEhaW1wb3J0YW50OyBiYWNrZ3JvdW5kLWltYWdlOm5vbmUhaW1wb3J0YW50OyB9XG4gIGJvZHlbZGF0YS1iZz1cImJsYWNrXCJdIC50aHVtYiB7IGJhY2tncm91bmQ6IzExMSFpbXBvcnRhbnQ7IGJhY2tncm91bmQtaW1hZ2U6bm9uZSFpbXBvcnRhbnQ7IH1cbiAgLnRodW1iIGltZyB7IG1heC13aWR0aDo4OCU7IG1heC1oZWlnaHQ6ODglOyBvYmplY3QtZml0OmNvbnRhaW47IH1cbiAgZmlnY2FwdGlvbiB7IHBhZGRpbmc6N3B4IDlweDsgZGlzcGxheTpmbGV4OyBmbGV4LWRpcmVjdGlvbjpjb2x1bW47IGdhcDoxcHg7IG1pbi13aWR0aDowOyB9XG4gIC5uYW1lLCAubWV0YSB7IHdoaXRlLXNwYWNlOm5vd3JhcDsgb3ZlcmZsb3c6aGlkZGVuOyB0ZXh0LW92ZXJmbG93OmVsbGlwc2lzOyB9XG4gIC5uYW1lIHsgZm9udC1zaXplOjEyLjVweDsgZm9udC13ZWlnaHQ6NjAwOyB9IC5tZXRhIHsgZm9udC1zaXplOjExcHg7IGNvbG9yOiM2ZjZjNjY7IH1cbjwvc3R5bGU+PC9oZWFkPjxib2R5IGRhdGEtYmc9XCJjaGVja2VyXCIgZGF0YS1zaXplPVwibWRcIj5cbiAgPGgxPvCfkKYgJHtlc2NhcGVIdG1sKHRpdGxlKX0gPHNwYW4gY2xhc3M9XCJjb3VudFwiPuKAlCAke2Fzc2V0cy5sZW5ndGh9IGFzc2V0JHthc3NldHMubGVuZ3RoID09PSAxID8gXCJcIiA6IFwic1wifTwvc3Bhbj48L2gxPlxuICA8ZGl2IGNsYXNzPVwidG9vbGJhclwiPlxuICAgIDxkaXYgY2xhc3M9XCJncm91cFwiPjxzcGFuIGNsYXNzPVwibGFiZWxcIj5CYWNrZHJvcDwvc3Bhbj5cbiAgICAgIDxidXR0b24gY2xhc3M9XCJzdyBjaGVja2VyIGFjdGl2ZVwiIGRhdGEtYmctYnRuPVwiY2hlY2tlclwiIHRpdGxlPVwiVHJhbnNwYXJlbnRcIj48L2J1dHRvbj5cbiAgICAgIDxidXR0b24gY2xhc3M9XCJzd1wiIGRhdGEtYmctYnRuPVwid2hpdGVcIiBzdHlsZT1cImJhY2tncm91bmQ6I2ZmZmZmZlwiIHRpdGxlPVwiV2hpdGVcIj48L2J1dHRvbj5cbiAgICAgIDxidXR0b24gY2xhc3M9XCJzd1wiIGRhdGEtYmctYnRuPVwiZ3JheVwiIHN0eWxlPVwiYmFja2dyb3VuZDojOGE4YThhXCIgdGl0bGU9XCJHcmF5XCI+PC9idXR0b24+XG4gICAgICA8YnV0dG9uIGNsYXNzPVwic3dcIiBkYXRhLWJnLWJ0bj1cImJsYWNrXCIgc3R5bGU9XCJiYWNrZ3JvdW5kOiMxMTExMTFcIiB0aXRsZT1cIkJsYWNrXCI+PC9idXR0b24+XG4gICAgPC9kaXY+XG4gICAgPGRpdiBjbGFzcz1cImdyb3VwXCI+PHNwYW4gY2xhc3M9XCJsYWJlbFwiPlNpemU8L3NwYW4+XG4gICAgICA8YnV0dG9uIGNsYXNzPVwic2VnXCIgZGF0YS1zaXplLWJ0bj1cInNtXCIgdGl0bGU9XCJTbWFsbFwiPlM8L2J1dHRvbj5cbiAgICAgIDxidXR0b24gY2xhc3M9XCJzZWcgYWN0aXZlXCIgZGF0YS1zaXplLWJ0bj1cIm1kXCIgdGl0bGU9XCJNZWRpdW1cIj5NPC9idXR0b24+XG4gICAgICA8YnV0dG9uIGNsYXNzPVwic2VnXCIgZGF0YS1zaXplLWJ0bj1cImxnXCIgdGl0bGU9XCJMYXJnZVwiPkw8L2J1dHRvbj5cbiAgICA8L2Rpdj5cbiAgICA8ZGl2IGNsYXNzPVwiZ3JvdXBcIj48c3BhbiBjbGFzcz1cImxhYmVsXCI+VHlwZTwvc3Bhbj4ke3R5cGVDaGlwc308L2Rpdj5cbiAgPC9kaXY+XG4gIDxkaXYgY2xhc3M9XCJncmlkXCI+XG4ke2NhcmRzfVxuICA8L2Rpdj5cbiAgPHNjcmlwdD5cbiAgICB2YXIgYm9keT1kb2N1bWVudC5ib2R5O1xuICAgIGZ1bmN0aW9uIHdpcmUoc2VsLCBhcHBseSl7IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoc2VsKS5mb3JFYWNoKGZ1bmN0aW9uKGIpeyBiLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJywgZnVuY3Rpb24oKXtcbiAgICAgIGFwcGx5KGIpO1xuICAgICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbChzZWwpLmZvckVhY2goZnVuY3Rpb24oeCl7IHguY2xhc3NMaXN0LnRvZ2dsZSgnYWN0aXZlJywgeD09PWIpOyB9KTtcbiAgICB9KTsgfSk7IH1cbiAgICB3aXJlKCdbZGF0YS1iZy1idG5dJywgZnVuY3Rpb24oYil7IGJvZHkuZGF0YXNldC5iZz1iLmRhdGFzZXQuYmdCdG47IH0pO1xuICAgIHdpcmUoJ1tkYXRhLXNpemUtYnRuXScsIGZ1bmN0aW9uKGIpeyBib2R5LmRhdGFzZXQuc2l6ZT1iLmRhdGFzZXQuc2l6ZUJ0bjsgfSk7XG4gICAgdmFyIGNhcmRzPVtdLnNsaWNlLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNhcmQnKSk7XG4gICAgd2lyZSgnW2RhdGEtZmlsdGVyXScsIGZ1bmN0aW9uKGIpeyB2YXIgdD1iLmRhdGFzZXQuZmlsdGVyO1xuICAgICAgY2FyZHMuZm9yRWFjaChmdW5jdGlvbihjKXsgYy5zdHlsZS5kaXNwbGF5PSh0PT09J2FsbCd8fGMuZGF0YXNldC50eXBlPT09dCk/Jyc6J25vbmUnOyB9KTsgfSk7XG4gIDwvc2NyaXB0PlxuPC9ib2R5PjwvaHRtbD5cbmA7XG59XG5cbi8vIGBleHBvcnQgWy0taWRzIGEsYl1gIOKAlCBidWlsZCB0aGUgZG93bmxvYWRhYmxlIGFzc2V0IGJ1bmRsZSBmcm9tIGVhY2ggZWxlbWVudCdzXG4vLyBDSE9TRU4gdmVyc2lvbjogc3RhZ2UgY2xlYW4tbmFtZWQgUE5HcyAoKyB0aGUgcmF3IGNyb3Agd2hlbiB0aGUgY2hvc2VuIGlzIGFcbi8vIHJlbW92YWwpICsgbWFuaWZlc3QuanNvbiArIGdhbGxlcnkuaHRtbCwgemlwIGludG8gdGhlIHNlc3Npb24gZmlsZXMgZGlyLCBhbmRcbi8vIHBvc3QgYnVuZGxlLnNldCBzbyB0aGUgc3VyZmFjZSBvZmZlcnMgaXQgdmlhIC9hc3NldHMvPG5hbWU+LiBSZXNvbHZlcyB2ZXJzaW9uXG4vLyBmaWxlcyBieSBCQVNFTkFNRSBpbiBmaWxlc19kaXIgKHJvYnVzdCB0byBzdGFsZSBhYnNvbHV0ZSBwYXRocyBhZnRlciBhIHJlc3RvcmUpLlxuYXN5bmMgZnVuY3Rpb24gY21kRXhwb3J0KHNlc3Npb246IHN0cmluZyB8IHVuZGVmaW5lZCwgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+KSB7XG4gIGNvbnN0IHMgPSByZXF1aXJlU2Vzc2lvbihzZXNzaW9uKTtcbiAgaWYgKCFzLmZpbGVzX2RpcikgZGllKFwic2Vzc2lvbiBoYXMgbm8gZmlsZXNfZGlyIOKAlCBjYW5ub3QgYnVpbGQgYSBidW5kbGVcIiwgXCJjb25mbGljdFwiKTtcbiAgY29uc3QgaWRGaWx0ZXIgPVxuICAgIHR5cGVvZiBmbGFncy5pZHMgPT09IFwic3RyaW5nXCJcbiAgICAgID8gbmV3IFNldChcbiAgICAgICAgICBmbGFncy5pZHNcbiAgICAgICAgICAgIC5zcGxpdChcIixcIilcbiAgICAgICAgICAgIC5tYXAoKHgpID0+IHgudHJpbSgpKVxuICAgICAgICAgICAgLmZpbHRlcihCb29sZWFuKSxcbiAgICAgICAgKVxuICAgICAgOiB1bmRlZmluZWQ7XG5cbiAgY29uc3QgeyBzdGF0dXMsIGRhdGEgfSA9IGF3YWl0IGFwaShzLnBvcnQsIFwiR0VUXCIsIFwiL3N0YXRlXCIpO1xuICBpZiAoc3RhdHVzICE9PSAyMDApIGRpZShgc3RhdGUgZmFpbGVkIChIVFRQICR7c3RhdHVzfSlgLCBcImludGVybmFsXCIpO1xuICBjb25zdCBzdCA9IChkYXRhIGFzIHsgc3RhdGU/OiB7IHRpdGxlPzogc3RyaW5nOyBlbGVtZW50cz86IEVsZW1lbnRbXSB9IH0pLnN0YXRlO1xuICBsZXQgZWxlbWVudHMgPSAoc3Q/LmVsZW1lbnRzID8/IFtdKS5maWx0ZXIoKGUpID0+IGUuc3RhdHVzICE9PSBcImRyb3BwZWRcIik7XG4gIGlmIChpZEZpbHRlcikgZWxlbWVudHMgPSBlbGVtZW50cy5maWx0ZXIoKGUpID0+IGlkRmlsdGVyLmhhcyhlLmlkKSk7XG4gIGlmICghZWxlbWVudHMubGVuZ3RoKVxuICAgIGRpZShpZEZpbHRlciA/IFwibm8gbWF0Y2hpbmcgZWxlbWVudHMgZm9yIC0taWRzXCIgOiBcIm5vIGFzc2V0cyB0byBleHBvcnRcIiwgXCJjb25mbGljdFwiKTtcbiAgY29uc3QgdGl0bGUgPSBzdD8udGl0bGUgPz8gXCJtYWdwaWVcIjtcblxuICBjb25zdCBzdGFnZURpciA9IGpvaW4ocy5maWxlc19kaXIsIFwiYnVuZGxlLXN0YWdlXCIpO1xuICBjb25zdCB6aXBOYW1lID0gXCJtYWdwaWUtYnVuZGxlLnppcFwiO1xuICBsZXQgcmVzdWx0OiB7IGNvdW50OiBudW1iZXIgfSB8IG51bGwgPSBudWxsO1xuICBsZXQgZmFpbHVyZTogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG4gIC8vIFRoZSBgZXhwb3J0YCBpbXBlcmF0aXZlIHNldCBzdGF0dXMuYnVzeSBvbiByZWNlaXB0OyBjbGVhciBpdCAoYW5kIGNsZWFuIHRoZVxuICAvLyBzdGFnZSBkaXIpIG9uIEVWRVJZIGV4aXQgcGF0aCDigJQgb3RoZXJ3aXNlIHRoZSBFeHBvcnQgb3ZlcmxheSBzdGlja3MuXG4gIHRyeSB7XG4gICAgcm1TeW5jKHN0YWdlRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgZm9yY2U6IHRydWUgfSk7XG4gICAgLy8gRm9sZGVyaXplOiBmaW5hbCBjaG9zZW4gYXNzZXRzIHVuZGVyIGFzc2V0cy8sIHJhdyBjcm9wcyB1bmRlciBjcm9wcy8g4oCUIHNvIGFcbiAgICAvLyB3aG9sZSBmb2xkZXIgY2FuIGJlIGdyYWJiZWQgd2l0aG91dCBwYXJzaW5nIG1peGVkIGZpbGVzLiBjcm9wcy8gaXMgY3JlYXRlZFxuICAgIC8vIGxhemlseSAob25seSBpZiBzb21lIGl0ZW0gaGFzIGEgc2VwYXJhdGUgcmF3IGNyb3ApLlxuICAgIGNvbnN0IGFzc2V0c0RpciA9IGpvaW4oc3RhZ2VEaXIsIFwiYXNzZXRzXCIpO1xuICAgIGNvbnN0IGNyb3BzRGlyID0gam9pbihzdGFnZURpciwgXCJjcm9wc1wiKTtcbiAgICBta2RpclN5bmMoYXNzZXRzRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcblxuICAgIGNvbnN0IG1hbmlmZXN0OiBNYW5pZmVzdEFzc2V0W10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGVsIG9mIGVsZW1lbnRzKSB7XG4gICAgICBjb25zdCBjaG9zZW4gPSBjaG9zZW5WZXJzaW9uKGVsKTtcbiAgICAgIGlmICghY2hvc2VuKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IGNob3NlbkZpbGUgPSBqb2luKHMuZmlsZXNfZGlyLCBiYXNlbmFtZShjaG9zZW4ucGF0aCkpO1xuICAgICAgaWYgKCFleGlzdHNTeW5jKGNob3NlbkZpbGUpKSB7XG4gICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBtYWdwaWUgZXhwb3J0OiBtaXNzaW5nIGZpbGUgZm9yICR7ZWwubmFtZX0gKCR7Y2hvc2VuLm1vZGVsfSlcXG5gKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBjb25zdCBmaWxlQmFzZSA9IGAke3Nhbml0aXplKGVsLm5hbWUpfS5wbmdgO1xuICAgICAgY29weUZpbGVTeW5jKGNob3NlbkZpbGUsIGpvaW4oYXNzZXRzRGlyLCBmaWxlQmFzZSkpO1xuICAgICAgLy8gdGhlIHJhdyBjcm9wIHRvbywgYnV0IG9ubHkgd2hlbiB0aGUgY2hvc2VuIGlzIGEgcmVtb3ZhbCAoZWxzZSBpdCdzIHRoZVxuICAgICAgLy8gc2FtZSBpbWFnZSBhcyB0aGUgYXNzZXQpLiBTYW1lIGJhc2UgbmFtZSwgaW4gY3JvcHMvLlxuICAgICAgbGV0IGNyb3BQYXRoOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgICAgIGlmIChjaG9zZW4ubW9kZWwgIT09IFwiY3JvcFwiKSB7XG4gICAgICAgIGNvbnN0IGNyb3BGaWxlID0gam9pbihzLmZpbGVzX2RpciwgY3V0b3V0RmlsZW5hbWUoZWwubmFtZSwgXCJjcm9wXCIpKTtcbiAgICAgICAgaWYgKGV4aXN0c1N5bmMoY3JvcEZpbGUpKSB7XG4gICAgICAgICAgbWtkaXJTeW5jKGNyb3BzRGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgICAgICBjb3B5RmlsZVN5bmMoY3JvcEZpbGUsIGpvaW4oY3JvcHNEaXIsIGZpbGVCYXNlKSk7XG4gICAgICAgICAgY3JvcFBhdGggPSBgY3JvcHMvJHtmaWxlQmFzZX1gO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBtYW5pZmVzdC5wdXNoKHtcbiAgICAgICAgbmFtZTogZWwubmFtZSxcbiAgICAgICAgdHlwZTogZWwudHlwZSxcbiAgICAgICAgbW9kZWw6IGNob3Nlbi5tb2RlbCxcbiAgICAgICAga2luZDogY2hvc2VuLmtpbmQgPz8gbnVsbCxcbiAgICAgICAgYmJveDogZWwuYmJveCxcbiAgICAgICAgZmlsZTogYGFzc2V0cy8ke2ZpbGVCYXNlfWAsXG4gICAgICAgIGNyb3A6IGNyb3BQYXRoLFxuICAgICAgfSk7XG4gICAgfVxuICAgIGlmICghbWFuaWZlc3QubGVuZ3RoKSB0aHJvdyBuZXcgRXJyb3IoXCJubyBjaG9zZW4gYXNzZXRzIGZvdW5kIHRvIGV4cG9ydCAoZmlsZXMgbWlzc2luZz8pXCIpO1xuXG4gICAgd3JpdGVGaWxlU3luYyhcbiAgICAgIGpvaW4oc3RhZ2VEaXIsIFwibWFuaWZlc3QuanNvblwiKSxcbiAgICAgIEpTT04uc3RyaW5naWZ5KHsgdGl0bGUsIGNvdW50OiBtYW5pZmVzdC5sZW5ndGgsIGFzc2V0czogbWFuaWZlc3QgfSwgbnVsbCwgMiksXG4gICAgKTtcbiAgICB3cml0ZUZpbGVTeW5jKGpvaW4oc3RhZ2VEaXIsIFwiZ2FsbGVyeS5odG1sXCIpLCBidWlsZEdhbGxlcnlIdG1sKHRpdGxlLCBtYW5pZmVzdCkpO1xuXG4gICAgLy8gemlwIGludG8gZmlsZXNfZGlyIChvdXRzaWRlIHRoZSBzdGFnZSBzbyB0aGUgYXJjaGl2ZSBpc24ndCBzZWxmLWluY2x1ZGVkKS5cbiAgICBjb25zdCB6aXBQYXRoID0gam9pbihzLmZpbGVzX2RpciwgemlwTmFtZSk7XG4gICAgcm1TeW5jKHppcFBhdGgsIHsgZm9yY2U6IHRydWUgfSk7XG4gICAgY29uc3QgcHJvYyA9IEJ1bi5zcGF3bihbXCJ6aXBcIiwgXCItclwiLCBcIi1xXCIsIHppcFBhdGgsIFwiLlwiXSwge1xuICAgICAgY3dkOiBzdGFnZURpcixcbiAgICAgIHN0ZG91dDogXCJwaXBlXCIsXG4gICAgICBzdGRlcnI6IFwicGlwZVwiLFxuICAgIH0pO1xuICAgIGNvbnN0IFt6ZXJyLCB6Y29kZV0gPSBhd2FpdCBQcm9taXNlLmFsbChbbmV3IFJlc3BvbnNlKHByb2Muc3RkZXJyKS50ZXh0KCksIHByb2MuZXhpdGVkXSk7XG4gICAgaWYgKHpjb2RlICE9PSAwKSB0aHJvdyBuZXcgRXJyb3IoYHppcCBmYWlsZWQgKGV4aXQgJHt6Y29kZX0pOiAke3plcnIudHJpbSgpfWApO1xuXG4gICAgYXdhaXQgYXBpKHMucG9ydCwgXCJQT1NUXCIsIFwiL2NtZFwiLCB7XG4gICAgICB0eXBlOiBcImJ1bmRsZS5zZXRcIixcbiAgICAgIG5hbWU6IHppcE5hbWUsXG4gICAgICBjb3VudDogbWFuaWZlc3QubGVuZ3RoLFxuICAgIH0pO1xuICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBtYWdwaWU6IGJ1bmRsZWQgJHttYW5pZmVzdC5sZW5ndGh9IGFzc2V0KHMpIOKGkiAke3ppcFBhdGh9XFxuYCk7XG4gICAgcmVzdWx0ID0geyBjb3VudDogbWFuaWZlc3QubGVuZ3RoIH07XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBmYWlsdXJlID0gZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpO1xuICB9IGZpbmFsbHkge1xuICAgIHJtU3luYyhzdGFnZURpciwgeyByZWN1cnNpdmU6IHRydWUsIGZvcmNlOiB0cnVlIH0pO1xuICAgIGF3YWl0IGFwaShzLnBvcnQsIFwiUE9TVFwiLCBcIi9jbWRcIiwgeyB0eXBlOiBcInN0YXR1c1wiLCBidXN5OiBmYWxzZSB9KTtcbiAgfVxuXG4gIGlmIChmYWlsdXJlIHx8ICFyZXN1bHQpIGRpZShgZXhwb3J0IGZhaWxlZDogJHtmYWlsdXJlID8/IFwidW5rbm93blwifWAsIFwiaW50ZXJuYWxcIik7XG4gIHByaW50SnNvbih7IG9rOiB0cnVlLCBidW5kbGU6IHppcE5hbWUsIGNvdW50OiByZXN1bHQuY291bnQgfSk7XG59XG5cbmNvbnN0IEhFTFAgPSBgbWFncGllIOKAlCBhIHN0YW5kaW5nIHJldmlldyBzdXJmYWNlIGZvciBleHRyYWN0aW5nIGFzc2V0cyBmcm9tIGEgY29tcG9zaXRlIGltYWdlLlxuXG4gIG9wZW4gICBbLS10aXRsZSAuLl0gWy0taW50ZW50IC4uXSBbLS1uby1vcGVuXSBbLS10aW1lb3V0IFNdIFstLXJlc3RvcmUgPGlkfHBhdGg+XVxuICBzZXNzaW9ucyAgICAgICAgICAgICAgICAgICAgICAgICAgICBsaXN0IHNhdmVkIChyZXN1bWFibGUpIHNlc3Npb25zXG4gIHRhaWwgICBbLS1zaW5jZSBOXSAgICAgICAgICAgICAgICAgIFNTRSB1c2VyIGV2ZW50cyDihpIgSlNPTkwgKHdyYXAgd2l0aCBNb25pdG9yKVxuICBzdGF0ZSAgWy0tZnVsbF0gICAgICAgICAgICAgICAgICAgICBsZWFuIHN0YXRlIHNuYXBzaG90IChhZGQgLS1mdWxsIGZvciByYXcpXG4gIHNheSAgICBbdGV4dC4uLl0gWy0tc3RkaW5dICAgICAgICAgIHBvc3QgYWdlbnQgZGlhbG9ndWUgKHRleHQgYXJncyBPUiBwaXBlZCBzdGRpbilcbiAgYXNrICAgIDx0ZXh0Li4uPiBbLS1vcHRpb25zIFwiYXxifGNcIl0gICBhc2sgdGhlIHVzZXIgYSBxdWVzdGlvbiAoaW4tdGhyZWFkKVxuICBzdGF0dXMgb24gW3RleHQuLi5dIHwgc3RhdHVzIG9mZiAgICBzaG93L2hpZGUgdGhlIFwibWFncGllIHdvcmtpbmdcIiBzcGlubmVyXG4gIHNvdXJjZSA8aW1hZ2VQYXRoPiAgICAgICAgICAgICAgICAgIHJlZ2lzdGVyIHRoZSBjb21wb3NpdGUgdW5kZXIgcmV2aWV3IChjb21wdXRlcyBzaGEgKyBzaXplKVxuICBkaXNjb3ZlciAgICAgICAgICAgICAgICAgICAgICAgICAgICBydW4gZGlzY292ZXIgb24gdGhlIGN1cnJlbnQgc291cmNlIOKGkiBwb3N0IHRoZSBicmVha2Rvd24gKG5lZWRzIE9QRU5ST1VURVJfQVBJX0tFWSlcbiAgZXh0cmFjdCBbLS1pZHMgYSxiXSBbLS1yZW1vdmVdIFstLWFscGhhIGF1dG98YWxsfG5vbmVdIFstLXBhZCBOXSBbLS1tb2RlbCA8bT5dIFstLWxhYmVsIDxuYW1lPl1cbiAgICAgICAgICBjdXQgc2xpY2VzIChjcm9wLW9ubHk7IC0tcmVtb3ZlIGFkZHMgcmVtYmcpLiAtLW1vZGVsID0gYSByZW1iZyBtb2RlbCBuYW1lIChpc25ldC1nZW5lcmFsLXVzZSxcbiAgICAgICAgICBiaXJlZm5ldC1nZW5lcmFsLCDigKYpIE9SIGEgbWVkaWEtZm9yZ2UgYmctcmVtb3ZlIG1vZGVsIGlkIChhIHByb3ZpZGVyIHBhdGggbGlrZVxuICAgICAgICAgIGZhbC1haS9icmlhL2JhY2tncm91bmQvcmVtb3ZlIOKAlCBESVNDT1ZFUiB2aWEgXFxgbWVkaWEtZm9yZ2UgbW9kZWxzIGxpc3RcXGAsIG5ldmVyIGhhcmRjb2RlKTtcbiAgICAgICAgICAtLWxhYmVsIHNldHMgdGhlIHZlcnNpb24ncyBmcmllbmRseSBzdHJpcCBsYWJlbCAoZGVmYXVsdHMgc2Vuc2libHkpXG4gIGV4cG9ydCBbLS1pZHMgYSxiXSAgICAgICAgICAgICAgICAgIGJ1aWxkIG1hZ3BpZS1idW5kbGUuemlwIOKAlCBhc3NldHMvIChjaG9zZW4gZmluYWxzKSArIGNyb3BzLyAocmF3IGNyb3BzKSArIG1hbmlmZXN0Lmpzb24gKyBnYWxsZXJ5Lmh0bWwgKGJhY2tkcm9wIHRvZ2dsZSArIHR5cGUgZmlsdGVycylcbiAgZWxlbWVudC1hZGQgLS1iYm94IFwieDEseTEseDIseTJcIiBbLS1uYW1lIC4uXSBbLS10eXBlIC4uXSAgIGJveCBhIHJlZ2lvbiAoc291cmNlIHB4KVxuICBlbGVtZW50LXJlbW92ZSA8aWQ+ICAgICAgICAgICAgICAgICByZXRyYWN0IGEgYm94ZWQgcmVnaW9uXG4gIGNtZCAgICBbLS1zdGRpbl0gICAgICAgICAgICAgICAgICAgIFBPU1QgYSByYXcgQWdlbnRDb21tYW5kIEpTT04gYm9keSBmcm9tIHN0ZGluXG4gIGNsb3NlIHwgaW5mbyB8IGhlbHBcbiAgLS12ZXJzaW9uICAgICAgICAgICAgICAgICAgICAgICAgICAgcHJpbnQgbWFncGllJ3MgdmVyc2lvbiBhcyBKU09OXG5cbiAgQWRkIC0tc2Vzc2lvbiA8aWQ+IHRvIHRhcmdldCBhIHNwZWNpZmljIHNlc3Npb24gKGRlZmF1bHQ6IG1vc3QgcmVjZW50KS4gSXQgaXNcbiAgYWNjZXB0ZWQgYnkgZXZlcnkgdmVyYiB0aGF0IGFjdHMgb24gYSBzZXNzaW9uIOKAlCBub3QgYnkgb3Blbiwgc2Vzc2lvbnMgb3IgaGVscCxcbiAgd2hpY2ggZG8gbm90IGhhdmUgb25lIHRvIHRhcmdldC5cblxuICBGbGFncyBhcmUgc2NvcGVkIHRvIHRoZWlyIHZlcmI6IGV4dHJhY3QncyAtLXBhZCBpcyBub3QgYWNjZXB0ZWQgYnkgc2F5LiBBXG4gIHJlamVjdGlvbiBsaXN0cyB3aGF0IHRoZSB2ZXJiIGl0IG5hbWVzIGRvZXMgYWNjZXB0LlxuXG4gIE91dHB1dDogbWFncGllIHByaW50cyBKU09OIGJ5IGRlZmF1bHQgb24gc3Rkb3V0LiBFdmVyeSB2ZXJiIHdyaXRlcyBPTkUgSlNPTlxuICBkb2N1bWVudCB0aGVyZSDigJQgZXhjZXB0IFxcYHRhaWxcXGAsIHdoaWNoIGlzIGEgc3RyZWFtIGFuZCB3cml0ZXMgb25lIHBlciBsaW5lXG4gIChKU09OTCkuIFByb3NlLCBsaXZlbmVzcyBhbmQgZGlhZ25vc3RpY3MgZ28gdG8gc3RkZXJyLiBcXGAtLWZ1bGxcXGBcbiAgd2lkZW5zIHRoZSBzdGF0ZSBwYXlsb2FkOyBpdCBkb2VzIG5vdCBzd2l0Y2ggZm9ybWF0cy5gO1xuXG4vKipcbiAqIFRoZSBmYWlsdXJlIGZ1bm5lbC4gYGRpZWAgVEhST1dTIGEgQ2xpRXJyb3Igbm93ICh0aGUgaG91c2UncyBvbmUgZXJyb3JcbiAqIGNvbnRyYWN0LCBgc3JjL2tpdC93aXJlL2Vycm9ycy50c2ApIGluc3RlYWQgb2YgZXhpdGluZyBmcm9tIHdoZXJldmVyIGl0IHdhc1xuICogY2FsbGVkLCBzbyB0aGlzIGlzIHRoZSBPTkUgcGxhY2UgYSBmYWlsdXJlIGJlY29tZXMgYW4gZXhpdCBjb2RlIOKAlCBhbmQgdGhlXG4gKiBwcm9jZXNzIHN0aWxsIGVuZHMgdGhlIG9uZSB3YXkgdGhlIGhvdXNlIHNhbmN0aW9ucywgYHByb2Nlc3MuZXhpdENvZGVgIHBsdXMgYVxuICogbmF0dXJhbCByZXR1cm4sIHdoaWNoIGlzIHdoYXQgZHJhaW5zIHN0ZG91dCBvbiBhIHBpcGUuXG4gKlxuICog4puUIEEgTk9OLUNsaUVycm9yIElTIFJFVEhST1dOLCBORVZFUiBFTlZFTE9QRUQuIFJlcG9ydGluZyBhbiB1bmtub3duIHRocm93IGFzXG4gKiBhIHRpZHkgdGF4b25vbXkgZmFpbHVyZSB3b3VsZCBsb3NlIHRoZSBzdGFjayB0aGF0IHNheXMgd2hhdCBhY3R1YWxseSBicm9rZS5cbiAqIChgVXNhZ2VFcnJvcmAgaXMgYW5zd2VyZWQgaW5zaWRlIGBkaXNwYXRjaGAsIHdoZXJlIGl0cyBjaG9pY2VzIGxpc3QgaXMuKVxuICovXG5hc3luYyBmdW5jdGlvbiBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgdHJ5IHtcbiAgICByZXR1cm4gYXdhaXQgZGlzcGF0Y2goYXJndik7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zdCBjb2RlID0gcmVwb3J0Q2xpRXJyb3IoZSk7XG4gICAgaWYgKGNvZGUgPT09IG51bGwpIHRocm93IGU7XG4gICAgcmV0dXJuIGNvZGU7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gZGlzcGF0Y2goYXJndjogc3RyaW5nW10pOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBbdmVyYiwgLi4ucmVzdF0gPSBhcmd2O1xuICBzZXRDdXJyZW50Q29tbWFuZCh2ZXJiID8/IG51bGwpO1xuXG4gIC8vIFJPT1QgVE9LRU5TIEZJUlNULCBiZWZvcmUgYW55IGZsYWcgcGFyc2luZy4gVGhlc2UgYXJlIG5vdCB2ZXJicyBhbmQgdGhleVxuICAvLyBjYXJyeSBubyBmbGFncywgc28gcmVzb2x2aW5nIHRoZW0gaGVyZSBrZWVwcyB0aGVtIG91dCBvZiBldmVyeSB2ZXJiJ3Mgc2V0LlxuICBpZiAodmVyYiA9PT0gXCItLWhlbHBcIiB8fCB2ZXJiID09PSBcIi1oXCIpIHtcbiAgICBwcm9jZXNzLnN0ZG91dC53cml0ZShgJHtIRUxQfVxcbmApO1xuICAgIHJldHVybiAwO1xuICB9XG4gIGlmICh2ZXJiID09PSBcIi0tdmVyc2lvblwiIHx8IHZlcmIgPT09IFwiLVZcIikge1xuICAgIHByaW50SnNvbih7IG5hbWU6IFwibWFncGllXCIsIHZlcnNpb246IFBMVUdJTl9WRVJTSU9OIH0pO1xuICAgIHJldHVybiAwO1xuICB9XG4gIGlmICh2ZXJiID09PSB1bmRlZmluZWQpIHtcbiAgICAvLyBBIGJhcmUgaW52b2NhdGlvbiBpcyBhIHVzYWdlIGVycm9yLCBub3QgYSBoZWxwIHBhdGgg4oCUIG1hZ3BpZSBpcyBkcml2ZW4gYnlcbiAgICAvLyBhbiBhZ2VudCwgYW5kIGFuIGVtcHR5IGFyZ3YgaXMgYW4gYWdlbnQgdGhhdCBmYWlsZWQgdG8gbmFtZSB3aGF0IGl0XG4gICAgLy8gd2FudGVkLiBzdGRvdXQgc3RheXMgZW1wdHk7IGl0IGNhcnJpZXMgZGF0YSBhbmQgdGhpcyBoYXMgbm9uZS5cbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgIGVycm9yRW52ZWxvcGUoXCJ1c2FnZVwiLCBcIm5vIHZlcmIgZ2l2ZW5cIiwgeyBoaW50OiBcInJ1bjogY2xpLnRzIGhlbHBcIiwgY2hvaWNlczogVkVSQlMgfSksXG4gICAgKTtcbiAgICByZXR1cm4gMjtcbiAgfVxuICAvLyBUSEUgVkVSQiBJUyBSRUpFQ1RFRCBCRUZPUkUgSVRTIEZMQUdTIEFSRSBSRUFELiBJdCBoYXMgdG8gYmU6IHdoaWNoIGZsYWdzXG4gIC8vIGFyZSBsZWdhbCBpcyBhIHF1ZXN0aW9uIGFib3V0IHRoZSB2ZXJiLCBzbyB0aGVyZSBpcyBubyBzZXQgdG8gY2hlY2sgYWdhaW5zdFxuICAvLyB1bnRpbCB3ZSBrbm93IGl0IGlzIGEgcmVhbCBvbmUuXG4gIGlmICghaXNWZXJiKHZlcmIpKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBlcnJvckVudmVsb3BlKFwidXNhZ2VcIiwgYHVua25vd24gdmVyYiBcIiR7dmVyYn1cImAsIHtcbiAgICAgICAgaGludDogXCJydW46IGNsaS50cyBoZWxwXCIsXG4gICAgICAgIGNob2ljZXM6IFZFUkJTLFxuICAgICAgfSksXG4gICAgKTtcbiAgICByZXR1cm4gMjtcbiAgfVxuXG4gIGxldCBwb3M6IHN0cmluZ1tdO1xuICBsZXQgZmxhZ3M6IFJlY29yZDxzdHJpbmcsIHN0cmluZyB8IGJvb2xlYW4+O1xuICB0cnkge1xuICAgICh7IHBvcywgZmxhZ3MgfSA9IHBhcnNlQXJncyhyZXN0LCB2ZXJiKSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBpZiAoIShlIGluc3RhbmNlb2YgVXNhZ2VFcnJvcikpIHRocm93IGU7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBlcnJvckVudmVsb3BlKFwidXNhZ2VcIiwgZS5tZXNzYWdlLCB7XG4gICAgICAgIGhpbnQ6IGBmbGFncyBhcmUgc2NvcGVkIHRvIHRoZSB2ZXJiIOKAlCBjaG9pY2VzIGxpc3RzIHdoYXQgXFxgJHt2ZXJifVxcYCBhY2NlcHRzOyBmb3IgZnJlZSB0ZXh0IGNvbnRhaW5pbmcgZGFzaGVzIHVzZSAtLXN0ZGluLCBvciBwdXQgaXQgYWZ0ZXIgYSBiYXJlIC0tYCxcbiAgICAgICAgY2hvaWNlczogZmxhZ3NGb3IodmVyYiksXG4gICAgICB9KSxcbiAgICApO1xuICAgIHJldHVybiAyO1xuICB9XG4gIGNvbnN0IHNlc3Npb24gPSB0eXBlb2YgZmxhZ3Muc2Vzc2lvbiA9PT0gXCJzdHJpbmdcIiA/IGZsYWdzLnNlc3Npb24gOiB1bmRlZmluZWQ7XG5cbiAgc3dpdGNoICh2ZXJiKSB7XG4gICAgY2FzZSBcIm9wZW5cIjpcbiAgICAgIGF3YWl0IGNtZE9wZW4oZmxhZ3MpO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcInRhaWxcIjpcbiAgICAgIC8vIFRoZSB0YWlsIFJFVFVSTlMgaXRzIGV4aXQgY29kZSAoMCBvbiBgY2xvc2VkYCwgb24gYSBzaWduYWwsIG9yIHdoZW4gdGhlXG4gICAgICAvLyBwaW5uZWQgc2Vzc2lvbiBnb2VzIGF3YXkpIGluc3RlYWQgb2YgZXhpdGluZyBmcm9tIGluc2lkZSBpdHMgb3duIGxvb3AuXG4gICAgICByZXR1cm4gYXdhaXQgY21kVGFpbChcbiAgICAgICAgc2Vzc2lvbixcbiAgICAgICAgdHlwZW9mIGZsYWdzLnNpbmNlID09PSBcInN0cmluZ1wiID8gcGFyc2VJbnQoZmxhZ3Muc2luY2UsIDEwKSA6IC0xLFxuICAgICAgKTtcbiAgICBjYXNlIFwic3RhdGVcIjpcbiAgICAgIGF3YWl0IGNtZFN0YXRlKHNlc3Npb24sIGZsYWdzLmZ1bGwgPT09IHRydWUpO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcInNheVwiOiB7XG4gICAgICBjb25zdCB0ZXh0ID0gZmxhZ3Muc3RkaW4gPT09IHRydWUgPyBhd2FpdCByZWFkU3RkaW4oKSA6IHBvcy5qb2luKFwiIFwiKTtcbiAgICAgIGlmICghdGV4dCkgZGllKFwidXNhZ2U6IHNheSA8dGV4dC4uLj4gfCBzYXkgLS1zdGRpblwiKTtcbiAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgeyB0eXBlOiBcInNheVwiLCB0ZXh0IH0pO1xuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGNhc2UgXCJhc2tcIjoge1xuICAgICAgaWYgKCFwb3MubGVuZ3RoKSBkaWUoJ3VzYWdlOiBhc2sgPHRleHQuLi4+IFstLW9wdGlvbnMgXCJhfGJ8Y1wiXScpO1xuICAgICAgY29uc3QgbXNnOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgdHlwZTogXCJhc2tcIiwgdGV4dDogcG9zLmpvaW4oXCIgXCIpIH07XG4gICAgICBpZiAodHlwZW9mIGZsYWdzLm9wdGlvbnMgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgbXNnLm9wdGlvbnMgPSBmbGFncy5vcHRpb25zXG4gICAgICAgICAgLnNwbGl0KFwifFwiKVxuICAgICAgICAgIC5tYXAoKHMpID0+IHMudHJpbSgpKVxuICAgICAgICAgIC5maWx0ZXIoQm9vbGVhbik7XG4gICAgICB9XG4gICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIG1zZyk7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgY2FzZSBcInN0YXR1c1wiOlxuICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7XG4gICAgICAgIHR5cGU6IFwic3RhdHVzXCIsXG4gICAgICAgIGJ1c3k6IHBvc1swXSA9PT0gXCJvblwiLFxuICAgICAgICB0ZXh0OiBwb3Muc2xpY2UoMSkuam9pbihcIiBcIiksXG4gICAgICB9KTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJzb3VyY2VcIjpcbiAgICAgIGlmICghcG9zLmxlbmd0aCkgZGllKFwidXNhZ2U6IHNvdXJjZSA8aW1hZ2VQYXRoPlwiKTtcbiAgICAgIGF3YWl0IGNtZFNvdXJjZShzZXNzaW9uLCBwb3NbMF0pO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcImRpc2NvdmVyXCI6XG4gICAgICBhd2FpdCBjbWREaXNjb3ZlcihzZXNzaW9uKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJleHRyYWN0XCI6XG4gICAgICBhd2FpdCBjbWRFeHRyYWN0KHNlc3Npb24sIGZsYWdzKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJleHBvcnRcIjpcbiAgICAgIGF3YWl0IGNtZEV4cG9ydChzZXNzaW9uLCBmbGFncyk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiZWxlbWVudC1hZGRcIjpcbiAgICAgIGF3YWl0IGNtZEVsZW1lbnRBZGQoc2Vzc2lvbiwgZmxhZ3MpO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcImVsZW1lbnQtcmVtb3ZlXCI6XG4gICAgICBpZiAoIXBvcy5sZW5ndGgpIGRpZShcInVzYWdlOiBlbGVtZW50LXJlbW92ZSA8aWQ+XCIpO1xuICAgICAgYXdhaXQgcG9zdENtZChzZXNzaW9uLCB7IHR5cGU6IFwiZWxlbWVudC5yZW1vdmVcIiwgaWQ6IHBvc1swXSB9KTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJjbWRcIjoge1xuICAgICAgLy8gUE9TVCBhIHJhdyBBZ2VudENvbW1hbmQgSlNPTiBib2R5IChmcm9tIHN0ZGluKSDigJQgdGhlIGVzY2FwZSBoYXRjaCBmb3JcbiAgICAgIC8vIGNvbW1hbmRzIGNhcnJ5aW5nIE5MIHRleHQgb3IgcmljaCBwYXlsb2FkcyAoZS5nLiBlbGVtZW50cy5zZXQpLlxuICAgICAgY29uc3QgcmF3ID0gZmxhZ3Muc3RkaW4gPT09IHRydWUgPyBhd2FpdCByZWFkU3RkaW4oKSA6IHBvcy5qb2luKFwiIFwiKTtcbiAgICAgIGlmICghcmF3KSBkaWUoXCJ1c2FnZTogY21kIC0tc3RkaW4gIChwaXBlIGEgSlNPTiBBZ2VudENvbW1hbmQgYm9keSlcIik7XG4gICAgICBsZXQgYm9keTogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gICAgICB0cnkge1xuICAgICAgICBib2R5ID0gSlNPTi5wYXJzZShyYXcpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIGRpZShcImNtZDogYm9keSBpcyBub3QgdmFsaWQgSlNPTlwiKTtcbiAgICAgIH1cbiAgICAgIGF3YWl0IHBvc3RDbWQoc2Vzc2lvbiwgYm9keSk7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgY2FzZSBcImNsb3NlXCI6XG4gICAgICBhd2FpdCBwb3N0Q21kKHNlc3Npb24sIHsgdHlwZTogXCJjbG9zZVwiIH0pO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcImluZm9cIjpcbiAgICAgIGNtZEluZm8oc2Vzc2lvbik7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwic2Vzc2lvbnNcIjpcbiAgICAgIGNtZFNlc3Npb25zKCk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiaGVscFwiOlxuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCR7SEVMUH1cXG5gKTtcbiAgICAgIGJyZWFrO1xuICAgIGRlZmF1bHQ6XG4gICAgICAvLyBVTlJFQUNIQUJMRSBCWSBDT05TVFJVQ1RJT04g4oCUIGB2ZXJiYCBpcyBuYXJyb3dlZCB0byBWZXJiIGFib3ZlLCBhbmQgYVxuICAgICAgLy8gdGVzdCBiaW5kcyBWRVJCX1NQRUMncyBrZXlzIHRvIHRoaXMgc3dpdGNoJ3MgY2FzZSBsYWJlbHMuIEtlcHQgYW55d2F5OlxuICAgICAgLy8gaWYgdGhhdCBiaW5kaW5nIGV2ZXIgYnJlYWtzLCB0aGUgYWx0ZXJuYXRpdmUgaXMgZmFsbGluZyB0aHJvdWdoIHRvXG4gICAgICAvLyBgcmV0dXJuIDBgIHdpdGggZW1wdHkgc3Rkb3V0LCB3aGljaCByZXBvcnRzIHN1Y2Nlc3MgZm9yIHdvcmsgbmV2ZXIgZG9uZS5cbiAgICAgIC8vIFRoYXQgaXMgdGhlIGZhaWx1cmUgdGhpcyBicmFuY2ggZXhpc3RzIHRvIHJlbW92ZSwgYW5kIGl0IHdvdWxkIGJlIHNpbGVudC5cbiAgICAgIGRpZShgbm8gaGFuZGxlciBmb3IgdmVyYiBcIiR7dmVyYn1cImAsIFwiaW50ZXJuYWxcIik7XG4gIH1cblxuICByZXR1cm4gMDtcbn1cblxuaWYgKGltcG9ydC5tZXRhLm1haW4pIHtcbiAgLy8gYHByb2Nlc3MuZXhpdENvZGVgICsgYSBuYXR1cmFsIHJldHVybiwgTkVWRVIgYHByb2Nlc3MuZXhpdChjb2RlKWA6IEJ1bidzXG4gIC8vIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBmaWxlKSwgc28gYW5cbiAgLy8gZXhwbGljaXQgZXhpdCBkaXNjYXJkcyB3aGF0ZXZlciBoYXMgbm90IGRyYWluZWQg4oCUIG1lYXN1cmVkIGF0IGV4YWN0bHlcbiAgLy8gNjUsNTM2IGJ5dGVzLiBUaGUgcGF5bG9hZCBpcyBjb21wbGV0ZSBhbmQgb25seSB0aGUgd3JpdGUgaXMgbG9zdCwgc28gdGhlXG4gIC8vIGNhbGxlciBnZXRzIHdlbGwtZm9ybWVkLWxvb2tpbmcgSlNPTiB0aGF0IHN0b3BzIG1pZC1zdHJpbmcuIFJlcHJvZHVjZWQsXG4gIC8vIGZpeGVkIGFuZCBnYXRlZCBpbiBib3VudHkgZmlyc3QgKFAwLCAjNzcvIzc4KTsgc2FtZSBzaGFwZSwgc2FtZSByZWFzb24uXG4gIC8vIERvIG5vdCB0aWR5IHRoaXMgYmFjayBpbnRvIGFuIGV4cGxpY2l0IGV4aXQuXG4gIHByb2Nlc3MuZXhpdENvZGUgPSBhd2FpdCBtYWluKHByb2Nlc3MuYXJndi5zbGljZSgyKSk7XG59XG5cbmV4cG9ydCB7IG1haW4gfTtcblxuLyoqXG4gKiBUaGUgU0hJUFBFRCBFTlRSWSBQT0lOVCwgY2FsbGVkIGJ5IGBwbHVnaW5zL3NwZWxsYm9vay9za2lsbHMvbWFncGllL3NjcmlwdHMvY2xpLnRzYFxuICogYWZ0ZXIgdGhlIGJ1bmRsZSBpcyBpbXBvcnRlZC5cbiAqXG4gKiDim5QgSVQgVEFLRVMgTk8gQVJHVU1FTlRTLCBBTkQgVEhBVCBJUyBUSEUgUE9JTlQuIGFyZ3YgYmVsb25ncyB0byB3aGljaGV2ZXIgZmlsZVxuICogUEFSU0VTIGl0LCBhbmQgdGhhdCBpcyB0aGlzIG9uZS4gQW4gZWFybGllciBsYXVuY2hlciByZWFkXG4gKiBgcHJvY2Vzcy5hcmd2LnNsaWNlKDIpYCBpdHNlbGYgYW5kIHBhc3NlZCBpdCBpbiDigJQgd2hpY2ggbWFkZSB0aGUgbGF1bmNoZXIgbWF0Y2hcbiAqIGBncmltb2lyZS9saWIvZW50cnktcG9pbnRzLnRzYCdzIFBBUlNFU19BUkdTIHByZWRpY2F0ZSAoYHByb2Nlc3MuYXJndmApLCBzbyB0aGVcbiAqIHJvc3RlciBjb3VudGVkIGEgMy1saW5lIGZvcndhcmRlciBhcyBhbiBhcmctcGFyc2luZyBlbnRyeSBwb2ludCBhbmQgdGhlblxuICogcmVwb3J0ZWQgdGhlIHNwZWxsJ3MgZG9jdW1lbnRlZCBmbGFncyBhcyBVTlJFU09MVkVEIGFnYWluc3QgYSBmaWxlIHRoYXRcbiAqIHJlY29nbmlzZXMgbm9uZS4gS2VlcGluZyBhcmd2IG9uIHRoaXMgc2lkZSBtYWtlcyB0aGUgZW51bWVyYXRvcidzIGFuc3dlciB0cnVlXG4gKiBpbnN0ZWFkIG9mIG1ha2luZyBpdHMgcmVnZXggbG9vc2VyLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuKCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHJldHVybiBhd2FpdCBtYWluKHByb2Nlc3MuYXJndi5zbGljZSgyKSk7XG59XG4iLAogICAgIi8vIHNjcmlwdHMvYmFja2VuZC50c1xuLy8gUmVtb3ZhbC1iYWNrZW5kIHJlZ2lzdHJ5LiBUaGUgcmVidWlsdCBtYWdwaWUgY29tcGFyZXMgYmFja2dyb3VuZC1yZW1vdmFsXG4vLyByZXN1bHRzIGZyb20gbXVsdGlwbGUgYmFja2VuZHMgcGVyIGVsZW1lbnQ7IHRoZSB1c2VyIHBpY2tzIHRoZSB3aW5uZXIuIFRoaXNcbi8vIGZpbGUgZGVmaW5lcyB0aGUgY29udHJhY3QsIHRoZSAobGl2ZSkgcmVtYmcgaW1wbCwgYSBtZWRpYS1mb3JnZSBzdHViIGZvciB0aGVcbi8vIG5leHQgc3ViLXBoYXNlLCBhbmQgYSByZWdpc3RyeS5cbi8vXG4vLyBJTUFHRSBPUFMgTk9URTogY3JvcHBpbmcgdGhlIGVsZW1lbnQncyBiYm94IG91dCBvZiB0aGUgc291cmNlIGlzIE5PVCBkb25lIHdpdGhcbi8vIEJ1bi5JbWFnZSAoaXQgaGFzIHJlc2l6ZS9lbmNvZGUvbWV0YWRhdGEgYnV0IE5PIGNyb3AvZXh0cmFjdCkuIHJlbWJnQmFja2VuZFxuLy8gc2hlbGxzIG91dCB0byBzY3JpcHRzL3JlbW92ZS5weSAoUGlsbG93IGNyb3AgKyByZW1iZykg4oCUIHRoZSBjYWxsZXIgb3ducyB0aGVcbi8vIG91dHB1dCBwYXRoICh0aGUgc2Vzc2lvbiBmaWxlcyBkaXIpLlxuXG5pbXBvcnQgeyBqb2luIH0gZnJvbSBcIm5vZGU6cGF0aFwiO1xuLy8g4pSA4pSAIGFscGhhIHBvbGljeSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vIFRoZSB0eXBlLWRyaXZlbiBhbHBoYSBwb2xpY3kgbGl2ZXMgaW4gc2hhcmVkL2FscGhhLnRzIChicm93c2VyLXNhZmUsIHNvXG4vLyB0aGUgc3VyZmFjZSBzaGFyZXMgb25lIHNvdXJjZSBvZiB0cnV0aCDigJQgUmVtb3ZlR2FsbGVyeS50c3ggcmVhZHMgaXQgdG9vLFxuLy8gd2hpY2ggaXMgd2hhdCBtYWtlcyBpdCB0d28tc2lkZWQgcmF0aGVyIHRoYW4gZGFlbW9uLW9ubHkpLiBSZS1leHBvcnRlZCBoZXJlXG4vLyBmb3IgdGhlIGFnZW50LXNpZGUgY29uc3VtZXJzIChjbGkudHMsIGJhY2tlbmQgdGVzdHMpIHRoYXQgaW1wb3J0IGl0IGZyb21cbi8vIHRoaXMgbW9kdWxlLlxuaW1wb3J0IHR5cGUgeyBBbHBoYVBvbGljeSB9IGZyb20gXCIuLi9zaGFyZWQvYWxwaGFcIjtcbmltcG9ydCB0eXBlIHsgQmJveCB9IGZyb20gXCIuLi9zaGFyZWQvdHlwZXNcIjtcblxuZXhwb3J0IHtcbiAgQUxQSEFfQVVUT19UWVBFUyxcbiAgQUxQSEFfRk9SQklEREVOX1RZUEVTLFxuICB0eXBlIEFscGhhUG9saWN5LFxuICBzaG91bGRSZW1vdmUsXG59IGZyb20gXCIuLi9zaGFyZWQvYWxwaGFcIjtcblxuLy8gQSByZWdpb24gb2YgdGhlIHNvdXJjZSB0byBjdXQgYSB0cmFuc3BhcmVudCBhc3NldCBmcm9tLlxuZXhwb3J0IHR5cGUgQ3JvcCA9IHtcbiAgLy8gb24tZGlzayBwYXRoIHRvIHRoZSBzb3VyY2UgY29tcG9zaXRlIChvciBhIHByZS1jcm9wcGVkIHJlZ2lvbiDigJQgc2VlIGNyb3Agbm90ZSlcbiAgc291cmNlUGF0aDogc3RyaW5nO1xuICAvLyB0aGUgZWxlbWVudCdzIHBpeGVsIGJib3ggW3gxLCB5MSwgeDIsIHkyXSB3aXRoaW4gdGhlIHNvdXJjZVxuICBiYm94OiBCYm94O1xuICAvLyBlbGVtZW50IHR5cGUgZHJpdmVzIHdoZXRoZXIgcmVtb3ZhbCBldmVuIG1ha2VzIHNlbnNlIChwYWxldHRlcy9zY3JlZW5zaG90c1xuICAvLyBnZXQgZGVzdHJveWVkIGJ5IHJlbWJnIOKAlCBzZWUgbWFncGllJ3MgQWxwaGEgUG9saWN5KVxuICB0eXBlOiBzdHJpbmc7XG59O1xuXG4vLyBUaGUgcmVzdWx0IG9mIGEgcmVtb3ZhbCBwYXNzIOKAlCBhIGN1dG91dCBQTkcgKHdpdGggYWxwaGEpIHRoZSBzdXJmYWNlIGRpc3BsYXlzLlxuZXhwb3J0IHR5cGUgQ3V0b3V0ID0ge1xuICBpZDogc3RyaW5nO1xuICBiYWNrZW5kOiBzdHJpbmc7IC8vIHdoaWNoIFJlbW92YWxCYWNrZW5kIHByb2R1Y2VkIGl0XG4gIHBhdGg6IHN0cmluZzsgLy8gb24tZGlzayBQTkcgdGhlIGFnZW50IHJlYWRzIC8gdGhlIHN1cmZhY2Ugc2VydmVzXG4gIC8vIFRPRE8obW9jayk6IHdpZHRoL2hlaWdodCwgYSBwcmV2aWV3IHNyYywgdGltaW5nL2Nvc3QsIGEgcXVhbGl0eSBzaWduYWxcbn07XG5cbi8vIE9wdGlvbmFsIGtub2JzIHRocmVhZGVkIHRocm91Z2ggdG8gcmVtb3ZlLnB5ICh0aGUgZXh0cmFjdCBsb29wIGhvbm9ycyAtLWFscGhhXG4vLyAvIC0tcGFkIC8gLS1tb2RlbCBmcm9tIHRoZSBDTEkgdmVyYikuIEFsbCBoYXZlIHNlbnNpYmxlIGRlZmF1bHRzIGluc2lkZVxuLy8gcmVtb3ZlLnB5LiBgbW9kZWxgIG5hbWVzIGEgc3BlY2lmaWMgcmVtYmcgbW9kZWwgZm9yIHRoZSBtb2RlbC1hZ25vc3RpYyByZXRyeVxuLy8gKG9taXQg4oaSIHJlbWJnJ3MgZGVmYXVsdCB1Mm5ldCkuXG5leHBvcnQgdHlwZSBDdXRPcHRpb25zID0geyBhbHBoYT86IEFscGhhUG9saWN5OyBwYWQ/OiBudW1iZXI7IG1vZGVsPzogc3RyaW5nIH07XG5cbmV4cG9ydCBpbnRlcmZhY2UgUmVtb3ZhbEJhY2tlbmQge1xuICBuYW1lOiBzdHJpbmc7XG4gIC8vIEN1dCB0aGUgYmJveCByZWdpb24gb3V0IG9mIHRoZSBzb3VyY2UgaW50byBgb3V0UGF0aGAgYW5kIHJldHVybiB0aGUgY3V0b3V0LlxuICAvLyBUaGUgY2FsbGVyIG93bnMgYG91dFBhdGhgICh0aGUgc2Vzc2lvbiBmaWxlcyBkaXIpLiBgb3B0c2AgY2FycmllcyB0aGVcbiAgLy8gYWxwaGEtcG9saWN5IC8gcGFkZGluZyB0aGUgQ0xJIGV4dHJhY3QgdmVyYiBwYXNzZXMgdGhyb3VnaC5cbiAgY3V0KGNyb3A6IENyb3AsIG91dFBhdGg6IHN0cmluZywgb3B0cz86IEN1dE9wdGlvbnMpOiBQcm9taXNlPEN1dG91dD47XG59XG5cbi8vIFJlc29sdmUgc2NyaXB0cy9yZW1vdmUucHkgcmVsYXRpdmUgdG8gdGhpcyBtb2R1bGUgKG5vdCBjd2QpLlxuY29uc3QgUkVNT1ZFX1BZID0gam9pbihpbXBvcnQubWV0YS5kaXIsIFwicmVtb3ZlLnB5XCIpO1xuXG5mdW5jdGlvbiBzaG9ydElkKHByZWZpeDogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgYnVmID0gbmV3IFVpbnQ4QXJyYXkoNCk7XG4gIGNyeXB0by5nZXRSYW5kb21WYWx1ZXMoYnVmKTtcbiAgY29uc3QgaGV4ID0gQXJyYXkuZnJvbShidWYsIChiKSA9PiBiLnRvU3RyaW5nKDE2KS5wYWRTdGFydCgyLCBcIjBcIikpLmpvaW4oXCJcIik7XG4gIHJldHVybiBgJHtwcmVmaXh9LSR7aGV4fWA7XG59XG5cbi8vIHJlbWJnIGJhY2tlbmQg4oCUIHNoZWxscyBvdXQgdG8gc2NyaXB0cy9yZW1vdmUucHkgKFBpbGxvdyBjcm9wICsgcmVtYmcpLiBUaGVcbi8vIGNhbGxlciBwYXNzZXMgdGhlIG91dHB1dCBsb2NhdGlvbjsgd2UgcGFyc2UgcmVtb3ZlLnB5J3Mgb25lIEpTT04gbGluZSBhbmRcbi8vIHJldHVybiB0aGUgY3V0b3V0LlxuZXhwb3J0IGNvbnN0IHJlbWJnQmFja2VuZDogUmVtb3ZhbEJhY2tlbmQgPSB7XG4gIG5hbWU6IFwicmVtYmdcIixcbiAgYXN5bmMgY3V0KGNyb3A6IENyb3AsIG91dFBhdGg6IHN0cmluZywgb3B0czogQ3V0T3B0aW9ucyA9IHt9KTogUHJvbWlzZTxDdXRvdXQ+IHtcbiAgICBjb25zdCBbeDEsIHkxLCB4MiwgeTJdID0gY3JvcC5iYm94O1xuICAgIGNvbnN0IGFyZ3MgPSBbXG4gICAgICBcInB5dGhvbjNcIixcbiAgICAgIFJFTU9WRV9QWSxcbiAgICAgIFwiLS1zb3VyY2VcIixcbiAgICAgIGNyb3Auc291cmNlUGF0aCxcbiAgICAgIFwiLS1iYm94XCIsXG4gICAgICBgJHt4MX0sJHt5MX0sJHt4Mn0sJHt5Mn1gLFxuICAgICAgXCItLXR5cGVcIixcbiAgICAgIGNyb3AudHlwZSxcbiAgICAgIFwiLS1vdXRcIixcbiAgICAgIG91dFBhdGgsXG4gICAgXTtcbiAgICBpZiAob3B0cy5hbHBoYSkgYXJncy5wdXNoKFwiLS1hbHBoYVwiLCBvcHRzLmFscGhhKTtcbiAgICBpZiAodHlwZW9mIG9wdHMucGFkID09PSBcIm51bWJlclwiKSBhcmdzLnB1c2goXCItLXBhZFwiLCBTdHJpbmcob3B0cy5wYWQpKTtcbiAgICBpZiAob3B0cy5tb2RlbCkgYXJncy5wdXNoKFwiLS1tb2RlbFwiLCBvcHRzLm1vZGVsKTtcblxuICAgIGNvbnN0IHByb2MgPSBCdW4uc3Bhd24oYXJncywgeyBzdGRvdXQ6IFwicGlwZVwiLCBzdGRlcnI6IFwicGlwZVwiIH0pO1xuICAgIGNvbnN0IFtzdGRvdXQsIHN0ZGVyciwgZXhpdENvZGVdID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgICAgbmV3IFJlc3BvbnNlKHByb2Muc3Rkb3V0KS50ZXh0KCksXG4gICAgICBuZXcgUmVzcG9uc2UocHJvYy5zdGRlcnIpLnRleHQoKSxcbiAgICAgIHByb2MuZXhpdGVkLFxuICAgIF0pO1xuICAgIGlmIChleGl0Q29kZSAhPT0gMCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgcmVtYmcgcmVtb3ZlLnB5IGZhaWxlZCAoZXhpdCAke2V4aXRDb2RlfSk6ICR7c3RkZXJyLnRyaW0oKSB8fCBzdGRvdXQudHJpbSgpfWAsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBsaW5lID0gc3Rkb3V0LnRyaW0oKS5zcGxpdChcIlxcblwiKS5maWx0ZXIoQm9vbGVhbikucG9wKCkgPz8gXCJcIjtcbiAgICBsZXQgcGFyc2VkOiB7IG91dD86IHN0cmluZzsgcmVtb3ZlZD86IGJvb2xlYW4gfTtcbiAgICB0cnkge1xuICAgICAgcGFyc2VkID0gSlNPTi5wYXJzZShsaW5lKSBhcyB7IG91dD86IHN0cmluZzsgcmVtb3ZlZD86IGJvb2xlYW4gfTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgcmVtYmcgcmVtb3ZlLnB5IHByb2R1Y2VkIG5vIHBhcnNlYWJsZSBKU09OIGxpbmU6ICR7c3Rkb3V0LnRyaW0oKX1gKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgaWQ6IHNob3J0SWQoXCJjdXRcIiksIGJhY2tlbmQ6IFwicmVtYmdcIiwgcGF0aDogcGFyc2VkLm91dCA/PyBvdXRQYXRoIH07XG4gIH0sXG59O1xuXG4vLyBtZWRpYS1mb3JnZSBiYWNrZW5kIOKAlCBjbG91ZCBiYWNrZ3JvdW5kIHJlbW92YWwgdmlhIHRoZSBtZWRpYS1mb3JnZSBDTEkgKHRoZVxuLy8gc2FtZSBvdXQtb2YtYmFuZCB0b29sIGltYWdvIHVzZXMpLiBgbWVkaWEtZm9yZ2UgZ2VuZXJhdGUgYmctcmVtb3ZlYCBpcyBhXG4vLyBzaW5nbGUtaW1hZ2UgdHJhbnNmb3JtIChwcm9tcHQtbGVzcyk6IGl0IHRha2VzIE9ORSBpbWFnZSBhbmQgcmV0dXJucyBhXG4vLyB0cmFuc3BhcmVudCBQTkcuIFNvIGBjcm9wLnNvdXJjZVBhdGhgIGhlcmUgaXMgdGhlIGVsZW1lbnQncyBBTFJFQURZLUNST1BQRURcbi8vIGltYWdlICh0aGUgc3VyZmFjZSdzIGNyb3AgdmVyc2lvbiksIE5PVCB0aGUgZnVsbCBib2FyZCDigJQgdGhlIGNhbGxlciBwYXNzZXMgaXQuXG4vLyBgb3B0cy5tb2RlbGAgaXMgdGhlIG1lZGlhLWZvcmdlIG1vZGVsIGlkIChlLmcuIGZhbC1haS9icmlhL2JhY2tncm91bmQvcmVtb3ZlKS5cbi8vIFdlIHBhcnNlIHRoZSBqb2IncyBwcmVzaWduZWQgb3V0cHV0IFVSTCBhbmQgc3RyZWFtIGl0IHRvIG91dFBhdGguXG5leHBvcnQgY29uc3QgbWVkaWFGb3JnZUJhY2tlbmQ6IFJlbW92YWxCYWNrZW5kID0ge1xuICBuYW1lOiBcIm1lZGlhLWZvcmdlXCIsXG4gIGFzeW5jIGN1dChjcm9wOiBDcm9wLCBvdXRQYXRoOiBzdHJpbmcsIG9wdHM6IEN1dE9wdGlvbnMgPSB7fSk6IFByb21pc2U8Q3V0b3V0PiB7XG4gICAgY29uc3QgbW9kZWwgPSBvcHRzLm1vZGVsO1xuICAgIGlmICghbW9kZWwpIHRocm93IG5ldyBFcnJvcihcIm1lZGlhRm9yZ2VCYWNrZW5kLmN1dCByZXF1aXJlcyBvcHRzLm1vZGVsIChhIGJnLXJlbW92ZSBtb2RlbCBpZClcIik7XG4gICAgY29uc3QgYXJncyA9IFtcbiAgICAgIFwibWVkaWEtZm9yZ2VcIixcbiAgICAgIFwiZ2VuZXJhdGVcIixcbiAgICAgIFwiYmctcmVtb3ZlXCIsXG4gICAgICBgLS1tb2RlbD0ke21vZGVsfWAsXG4gICAgICBgLS1yZWY9JHtjcm9wLnNvdXJjZVBhdGh9YCxcbiAgICAgIFwiLS1mb3JtYXRcIixcbiAgICAgIFwianNvblwiLFxuICAgIF07XG4gICAgY29uc3QgcHJvYyA9IEJ1bi5zcGF3bihhcmdzLCB7IHN0ZG91dDogXCJwaXBlXCIsIHN0ZGVycjogXCJwaXBlXCIgfSk7XG4gICAgY29uc3QgW3N0ZG91dCwgc3RkZXJyLCBleGl0Q29kZV0gPSBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgICBuZXcgUmVzcG9uc2UocHJvYy5zdGRvdXQpLnRleHQoKSxcbiAgICAgIG5ldyBSZXNwb25zZShwcm9jLnN0ZGVycikudGV4dCgpLFxuICAgICAgcHJvYy5leGl0ZWQsXG4gICAgXSk7XG4gICAgaWYgKGV4aXRDb2RlICE9PSAwKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBtZWRpYS1mb3JnZSBiZy1yZW1vdmUgZmFpbGVkIChleGl0ICR7ZXhpdENvZGV9KTogJHtzdGRlcnIudHJpbSgpIHx8IHN0ZG91dC50cmltKCl9YCxcbiAgICAgICk7XG4gICAgfVxuICAgIGxldCBwYXJzZWQ6IHsgb2s/OiBib29sZWFuOyBkYXRhPzogeyBvdXRwdXRzPzogQXJyYXk8eyBwcmVzaWduZWRVcmw/OiBzdHJpbmcgfT4gfSB9O1xuICAgIHRyeSB7XG4gICAgICBwYXJzZWQgPSBKU09OLnBhcnNlKHN0ZG91dC50cmltKCkuc3BsaXQoXCJcXG5cIikuZmlsdGVyKEJvb2xlYW4pLnBvcCgpID8/IFwiXCIpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBtZWRpYS1mb3JnZSBwcm9kdWNlZCBubyBwYXJzZWFibGUgSlNPTiBsaW5lOiAke3N0ZG91dC50cmltKCl9YCk7XG4gICAgfVxuICAgIGNvbnN0IHVybCA9IHBhcnNlZD8uZGF0YT8ub3V0cHV0cz8uWzBdPy5wcmVzaWduZWRVcmw7XG4gICAgaWYgKCF1cmwpIHRocm93IG5ldyBFcnJvcihgbWVkaWEtZm9yZ2UgcmV0dXJuZWQgbm8gb3V0cHV0IHVybDogJHtzdGRvdXQudHJpbSgpfWApO1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKHVybCk7XG4gICAgaWYgKCFyZXMub2spIHRocm93IG5ldyBFcnJvcihgbWVkaWEtZm9yZ2Ugb3V0cHV0IGRvd25sb2FkIGZhaWxlZCAoSFRUUCAke3Jlcy5zdGF0dXN9KWApO1xuICAgIGF3YWl0IEJ1bi53cml0ZShvdXRQYXRoLCByZXMpO1xuICAgIHJldHVybiB7IGlkOiBzaG9ydElkKFwiY3V0XCIpLCBiYWNrZW5kOiBcIm1lZGlhLWZvcmdlXCIsIHBhdGg6IG91dFBhdGggfTtcbiAgfSxcbn07XG5cbi8vIElzIHRoaXMgYSBtZWRpYS1mb3JnZSBtb2RlbCBpZCAoYSBwcm92aWRlciBwYXRoIGxpa2UgXCJmYWwtYWkvYnJpYS9iYWNrZ3JvdW5kL1xuLy8gcmVtb3ZlXCIpIHZzIGEgYmFyZSByZW1iZyBtb2RlbCBuYW1lIChlLmcuIFwiaXNuZXQtZ2VuZXJhbC11c2VcIik/IFdlIHJvdXRlIGJ5XG4vLyBTSEFQRSwgbmV2ZXIgYSBoYXJkY29kZWQgbW9kZWwgbGlzdCDigJQgbWVkaWEtZm9yZ2UncyBjYXRhbG9nIGRyaWZ0cywgc28gdGhlIGFnZW50XG4vLyBESVNDT1ZFUlMgYmctcmVtb3ZlIG1vZGVsIGlkcyB2aWEgYG1lZGlhLWZvcmdlIG1vZGVscyBsaXN0YCAob3BlcmF0aW9uc1xuLy8gW1wiYmctcmVtb3ZlXCJdKSBhbmQgcGFzc2VzIHRoZSBpZCB0aHJvdWdoLiBUaGUgbWFncGllIENMSSBhYnN0cmFjdHMgdGhlXG4vLyBvcmNoZXN0cmF0aW9uLCBub3QgdGhlIG1vZGVsIGlkZW50aXR5LlxuZXhwb3J0IGZ1bmN0aW9uIGlzTWVkaWFGb3JnZU1vZGVsKG1vZGVsOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIG1vZGVsLmluY2x1ZGVzKFwiL1wiKTtcbn1cblxuLy8gVGhlIHJlZ2lzdHJ5IHRoZSBkYWVtb24vc3VyZmFjZSBwaWNrcyBiYWNrZW5kcyBmcm9tLlxuZXhwb3J0IGNvbnN0IFJFTU9WQUxfQkFDS0VORFM6IFJlY29yZDxzdHJpbmcsIFJlbW92YWxCYWNrZW5kPiA9IHtcbiAgW3JlbWJnQmFja2VuZC5uYW1lXTogcmVtYmdCYWNrZW5kLFxuICBbbWVkaWFGb3JnZUJhY2tlbmQubmFtZV06IG1lZGlhRm9yZ2VCYWNrZW5kLFxufTtcblxuZXhwb3J0IGZ1bmN0aW9uIGdldEJhY2tlbmQobmFtZTogc3RyaW5nKTogUmVtb3ZhbEJhY2tlbmQgfCB1bmRlZmluZWQge1xuICByZXR1cm4gUkVNT1ZBTF9CQUNLRU5EU1tuYW1lXTtcbn1cbiIsCiAgICAiLy8gc2hhcmVkL2FscGhhLnRzXG4vLyBUaGUgdHlwZS1kcml2ZW4gYWxwaGEgcG9saWN5IOKAlCB3aGljaCBFTEVNRU5UIFRZUEVTIGdldCBiYWNrZ3JvdW5kIHJlbW92YWwuXG4vLyBCcm93c2VyLXNhZmUgKG5vIG5vZGU6Kiwgbm8gQnVuKTogdGhlIHN1cmZhY2UgcmVhZHMgaXQgdG8gc2hvdyBcIlJlbW92ZSBiZ1wiIHZzIGFcbi8vIFwia2VwdCB3aG9sZVwiIG5vdGU7IHNjcmlwdHMvYmFja2VuZC50cyArIHJlbW92ZS5weSBtaXJyb3IgdGhlIHNhbWUgcnVsZS4gVGhpcyBpc1xuLy8gYWJvdXQgZWxlbWVudCBUWVBFUyAod2hpY2ggbGl2ZSBpbiB0aGUgVUkpLCBOT1QgbW9kZWxzICh3aGljaCBuZXZlciBkbykuXG5pbXBvcnQgdHlwZSB7IEVsZW1lbnRUeXBlIH0gZnJvbSBcIi4vdHlwZXNcIjtcblxuZXhwb3J0IHR5cGUgQWxwaGFQb2xpY3kgPSBcImF1dG9cIiB8IFwiYWxsXCIgfCBcIm5vbmVcIjtcblxuLy8gcmVtYmcgcmVsaWFibHkgcHJvZHVjZXMgdXNhYmxlIGFscGhhIGZvciB0aGVzZSAodW5kZXIgYGF1dG9gKS5cbmV4cG9ydCBjb25zdCBBTFBIQV9BVVRPX1RZUEVTOiBSZWFkb25seVNldDxFbGVtZW50VHlwZT4gPSBuZXcgU2V0KFtcbiAgXCJpbGx1c3RyYXRpb25cIixcbiAgXCJzdGlja2VyXCIsXG4gIFwiaWNvblwiLFxuICBcIndvcmRtYXJrXCIsXG5dKTtcblxuLy8gcmVtYmcgZGVzdHJveXMgdGhlc2UgKGZsYXQtY29sb3IgY29udGVudCkg4oCUIG5ldmVyIGFscGhhIHRoZW0sIGV2ZW4gdW5kZXIgYGFsbGAuXG5leHBvcnQgY29uc3QgQUxQSEFfRk9SQklEREVOX1RZUEVTOiBSZWFkb25seVNldDxFbGVtZW50VHlwZT4gPSBuZXcgU2V0KFtcbiAgXCJwYWxldHRlXCIsXG4gIFwic2NyZWVuc2hvdFwiLFxuICBcInR5cG9ncmFwaHlcIixcbl0pO1xuXG4vLyBTaG91bGQgYW4gZWxlbWVudCBvZiBgdHlwZWAgZ2V0IGJhY2tncm91bmQgcmVtb3ZhbCB1bmRlciBgcG9saWN5YD8gTWlycm9yc1xuLy8gcmVtb3ZlLnB5J3Mgc2hvdWxkX3JlbW92ZSBleGFjdGx5LlxuZXhwb3J0IGZ1bmN0aW9uIHNob3VsZFJlbW92ZSh0eXBlOiBzdHJpbmcsIHBvbGljeTogQWxwaGFQb2xpY3kpOiBib29sZWFuIHtcbiAgaWYgKHBvbGljeSA9PT0gXCJub25lXCIpIHJldHVybiBmYWxzZTtcbiAgaWYgKHBvbGljeSA9PT0gXCJhbGxcIikgcmV0dXJuICFBTFBIQV9GT1JCSURERU5fVFlQRVMuaGFzKHR5cGUgYXMgRWxlbWVudFR5cGUpO1xuICByZXR1cm4gQUxQSEFfQVVUT19UWVBFUy5oYXModHlwZSBhcyBFbGVtZW50VHlwZSk7IC8vIGF1dG8gKGRlZmF1bHQpXG59XG5cbi8vIFN1cmZhY2UgaGVscGVyOiBpcyB0aGlzIGVsZW1lbnQgdHlwZSBhIGNhbmRpZGF0ZSBmb3IgcmVtb3ZhbCB1bmRlciB0aGUgZGVmYXVsdFxuLy8gYGF1dG9gIHBvbGljeT8gRHJpdmVzIHRoZSBcIlJlbW92ZSBiZ1wiIGFjdGlvbiB2cyB0aGUgXCJrZXB0IHdob2xlXCIgZXhwbGFpbmVyLlxuZXhwb3J0IGZ1bmN0aW9uIGlzQWxwaGFFbGlnaWJsZSh0eXBlOiBFbGVtZW50VHlwZSk6IGJvb2xlYW4ge1xuICByZXR1cm4gQUxQSEFfQVVUT19UWVBFUy5oYXModHlwZSk7XG59XG5cbi8vIElzIHRoaXMgdHlwZSBleHBsaWNpdGx5IGtlcHQgd2hvbGUgKGZsYXQgY29sb3IgcmVtYmcgd291bGQgZGVzdHJveSk/XG5leHBvcnQgZnVuY3Rpb24gaXNLZXB0V2hvbGUodHlwZTogRWxlbWVudFR5cGUpOiBib29sZWFuIHtcbiAgcmV0dXJuIEFMUEhBX0ZPUkJJRERFTl9UWVBFUy5oYXModHlwZSk7XG59XG4iLAogICAgIiMhL3Vzci9iaW4vZW52IGJ1blxuLy8gbWFncGllIOKAlCBkaXNjb3ZlciBwaGFzZS4gVGhlIGNhbm9uaWNhbCBlbGVtZW50LWRpc2NvdmVyeSBpbXBsZW1lbnRhdGlvbi5cbi8vXG4vLyBDYWxscyBHZW1pbmkgMy41IEZsYXNoIHZpYSBPcGVuUm91dGVyIG9uIGEgbW9vZGJvYXJkIC8gYnJhbmRpbmcgYm9hcmQgaW1hZ2UsXG4vLyBhc2tzIHRoZSBtb2RlbCB0byBpZGVudGlmeSBldmVyeSBkaXN0aW5jdCBleHRyYWN0YWJsZSB2aXN1YWwgZWxlbWVudCwgYW5kXG4vLyByZXR1cm5zIGEgbWFuaWZlc3QgKG5hbWUgKyB0eXBlICsgc291cmNlLXBpeGVsIGJib3ggcGVyIGVsZW1lbnQsICsgY29zdC90b2tlbnMpLlxuLy8gQSBwbGFpbiBmdW5jdGlvbiBtb2R1bGUgdGhlIGRhZW1vbi9jbGkgY2FsbDsgYSBzbWFsbCBDTEkgZW50cnkgbGl2ZXMgYXQgdGhlXG4vLyBib3R0b20uIChQb3J0ZWQgZnJvbSBhbiBlYXJsaWVyIFB5dGhvbiBvcmlnaW5hbCwgc2luY2UgcmVtb3ZlZC4pXG5cbmltcG9ydCB7IGRpcm5hbWUsIGV4dG5hbWUsIGpvaW4sIHJlc29sdmUgfSBmcm9tIFwibm9kZTpwYXRoXCI7XG5pbXBvcnQgdHlwZSB7IEJib3gsIEVsZW1lbnRUeXBlIH0gZnJvbSBcIi4uL3NoYXJlZC90eXBlc1wiO1xuXG5leHBvcnQgY29uc3QgT1BFTlJPVVRFUl9VUkwgPSBcImh0dHBzOi8vb3BlbnJvdXRlci5haS9hcGkvdjEvY2hhdC9jb21wbGV0aW9uc1wiO1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfTU9ERUwgPSBcImdvb2dsZS9nZW1pbmktMy41LWZsYXNoXCI7XG5cbi8vIENvcGllZCB2ZXJiYXRpbSBmcm9tIHRoZSBQeXRob24gb3JpZ2luYWwncyBQUk9NUFQgKHRoZSBkaXNjb3ZlcnkgaW5zdHJ1Y3Rpb24pLlxuZXhwb3J0IGNvbnN0IFBST01QVCA9IGBJZGVudGlmeSBldmVyeSBkaXN0aW5jdCBleHRyYWN0YWJsZSB2aXN1YWwgZWxlbWVudCBpbiB0aGlzIGltYWdlLiBcIkRpc3RpbmN0IGV4dHJhY3RhYmxlXCIgbWVhbnM6IGEgc2luZ2xlIHZpc3VhbGx5LWNvaGVyZW50IGFzc2V0IGEgZGVzaWduZXIgd291bGQgd2FudCB0byBwdWxsIG91dCBhcyBpdHMgb3duIGZpbGUg4oCUIGEgbG9nbywgYW4gaWNvbiwgYSBzdGlja2VyLCBhIGNvbG9yIHN3YXRjaCByb3csIGEgcGllY2Ugb2YgY292ZXIgYXJ0LCBhIFVJIHNjcmVlbnNob3QuIERvIE5PVCBpbmNsdWRlIGJhY2tncm91bmQsIHRleHR1cmUsIG9yIHN1cnJvdW5kaW5nIGNhbnZhcy5cblxuRm9yIGVhY2ggZWxlbWVudCwgcmV0dXJuIGEgYm91bmRpbmcgYm94IHVzaW5nIEdvb2dsZSdzIG5vcm1hbGl6ZWQgY29vcmRpbmF0ZSBzeXN0ZW0gKGltYWdlIGlzIFswLCAxMDAwXSBvbiBib3RoIGF4ZXMsIDAsMCB0b3AtbGVmdCkgaW4gdGhlIGRvY3VtZW50ZWQgb3JkZXI6IFt5X21pbiwgeF9taW4sIHlfbWF4LCB4X21heF0uXG5cblJldHVybiBPTkxZIGEgSlNPTiBhcnJheSwgbm8gcHJvc2UsIGluIHRoaXMgZXhhY3Qgc2hhcGU6XG5bXG4gIHtcIm5hbWVcIjogXCI8c2hvcnRfc25ha2VfY2FzZV9uYW1lPlwiLCBcInR5cGVcIjogXCI8b25lIG9mOiB3b3JkbWFyaywgdGFnbGluZSwgaWNvbiwgaWxsdXN0cmF0aW9uLCBzdGlja2VyLCBwYWxldHRlLCB0eXBvZ3JhcGh5LCBzY3JlZW5zaG90LCBvdGhlcj5cIiwgXCJib3hfMmRcIjogW3lfbWluLCB4X21pbiwgeV9tYXgsIHhfbWF4XX1cbl1cblxuTmFtaW5nIHJ1bGVzOlxuLSBVc2UgZGlzdGluY3RpdmUgc25ha2VfY2FzZSBuYW1lczsgaWYgdGhlcmUgYXJlIG11bHRpcGxlIG9mIHRoZSBzYW1lIGtpbmQsIGRpZmZlcmVudGlhdGUgZGVzY3JpcHRpdmVseSAoaWNvbl9tYW1tb3RoLCBpY29uX2dlYXIsIHN0aWNrZXJfY29mZmVlLCBzdGlja2VyX3NrYXRlYm9hcmQpLlxuLSBUaGUgXFxgdHlwZVxcYCBmaWVsZCBpcyBjcml0aWNhbCDigJQgdGhlIGV4dHJhY3Qgc3RlcCB1c2VzIGl0IHRvIGRlY2lkZSB3aGV0aGVyIHRvIHJ1biBiYWNrZ3JvdW5kIHJlbW92YWwuXG5gO1xuXG4vLyBPcGVuUm91dGVyIHZpc2lvbiBlbmRwb2ludHMgcmVqZWN0IHZlcnkgbGFyZ2UgcGF5bG9hZHMgd2l0aCBhIG5vbi1hY3Rpb25hYmxlXG4vLyA0eHg7IGJhaWwgd2l0aCBhIGNsZWFyZXIgZXJyb3IgZmlyc3QgKG1hdGNoZXMgdGhlIFB5dGhvbiBvcmlnaW5hbCkuXG5leHBvcnQgY29uc3QgTUFYX0lNQUdFX0JZVEVTID0gMzAgKiAxMDI0ICogMTAyNDtcbmV4cG9ydCBjb25zdCBXQVJOX0lNQUdFX0JZVEVTID0gMTUgKiAxMDI0ICogMTAyNDtcblxuY29uc3QgTUlNRV9CWV9FWFQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gIFwiLmpwZ1wiOiBcImltYWdlL2pwZWdcIixcbiAgXCIuanBlZ1wiOiBcImltYWdlL2pwZWdcIixcbiAgXCIucG5nXCI6IFwiaW1hZ2UvcG5nXCIsXG4gIFwiLndlYnBcIjogXCJpbWFnZS93ZWJwXCIsXG4gIFwiLmdpZlwiOiBcImltYWdlL2dpZlwiLFxufTtcblxuLy8g4pSA4pSAIG1hbmlmZXN0IHNjaGVtYSAobWlycm9ycyB0aGUgUHl0aG9uIG1hbmlmZXN0KSDilIDilIBcbmV4cG9ydCB0eXBlIE1hbmlmZXN0RWxlbWVudCA9IHtcbiAgbmFtZTogc3RyaW5nO1xuICB0eXBlOiBFbGVtZW50VHlwZTtcbiAgYm94XzJkOiBudW1iZXJbXTsgLy8gR2VtaW5pJ3Mgbm9ybWFsaXplZCBbeV9taW4sIHhfbWluLCB5X21heCwgeF9tYXhdLCAwLi4xMDAwXG4gIGJib3hfcGl4ZWw6IEJib3g7IC8vIFt4MSwgeTEsIHgyLCB5Ml0gaW4gc291cmNlIHBpeGVscyAodXNlZCBieSBleHRyYWN0KVxufTtcbmV4cG9ydCB0eXBlIE1hbmlmZXN0ID0ge1xuICBzb3VyY2U6IHN0cmluZztcbiAgc291cmNlX3NpemU6IFtudW1iZXIsIG51bWJlcl07XG4gIHNvdXJjZV9zaGEyNTZfMTY6IHN0cmluZztcbiAgbW9kZWw6IHN0cmluZztcbiAgY29zdF91c2Q6IG51bWJlcjtcbiAgdG9rZW5zOiB7IHByb21wdDogbnVtYmVyOyBjb21wbGV0aW9uOiBudW1iZXI7IHJlYXNvbmluZzogbnVtYmVyIH07XG4gIGVsZW1lbnRzOiBNYW5pZmVzdEVsZW1lbnRbXTtcbn07XG5cbi8vIFJhaXNlZCBmb3IgYWN0aW9uYWJsZSB1c2VyLWZhY2luZyBmYWlsdXJlcyAoYmFkIGltYWdlIHNpemUsIG1pc3Npbmcga2V5LCBIVFRQXG4vLyBlcnJvcikuIFRoZSBDTEkgZW50cnkgbWFwcyBpdCB0byBhIGNsZWFuIHN0ZGVyciBsaW5lICsgZXhpdCBjb2RlLlxuZXhwb3J0IGNsYXNzIERpc2NvdmVyRXJyb3IgZXh0ZW5kcyBFcnJvciB7fVxuXG4vLyDilIDilIAgcHVyZSBoZWxwZXJzICh1bml0LXRlc3RlZDsgbm8gbmV0d29yay9kaXNrKSDilIDilIBcblxuLy8gU3RyaXAgb3B0aW9uYWwgYGBganNvbiBmZW5jZXMgYW5kIHBhcnNlIHRoZSBKU09OIGFycmF5LiBNaXJyb3JzXG4vLyB0aGUgUHl0aG9uIG9yaWdpbmFsJ3MgcGFyc2VfYmJveGVzLlxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQmJveGVzKGNvbnRlbnQ6IHN0cmluZyk6IHVua25vd25bXSB7XG4gIGxldCBzID0gY29udGVudC50cmltKCk7XG4gIGNvbnN0IGZlbmNlID0gL2BgYCg/Ompzb24pP1xccyooW1xcc1xcU10qPylcXHMqYGBgLy5leGVjKHMpO1xuICBpZiAoZmVuY2UpIHMgPSBmZW5jZVsxXTtcbiAgcmV0dXJuIEpTT04ucGFyc2Uocyk7XG59XG5cbi8vIENvbnZlcnQgR2VtaW5pJ3MgW3lfbWluLCB4X21pbiwgeV9tYXgsIHhfbWF4XSAoMC4uMTAwMCkgdG8gc291cmNlIHBpeGVsc1xuLy8gW3gxLCB5MSwgeDIsIHkyXSwgY2xhbXBlZCB0byBpbWFnZSBib3VuZHMuIFJlcGxpY2F0ZXMgdGhlIFB5dGhvbiBvcmlnaW5hbCdzXG4vLyBub3JtYWxpemVkX3RvX3BpeGVsIGZvcm11bGEgZXhhY3RseS5cbmV4cG9ydCBmdW5jdGlvbiBub3JtYWxpemVkVG9QaXhlbChib3g6IG51bWJlcltdLCB3aWR0aDogbnVtYmVyLCBoZWlnaHQ6IG51bWJlcik6IEJib3gge1xuICBjb25zdCBbeTEsIHgxLCB5MiwgeDJdID0gYm94O1xuICBjb25zdCBweDEgPSBNYXRoLm1heCgwLCBNYXRoLnJvdW5kKCh4MSAvIDEwMDApICogd2lkdGgpKTtcbiAgY29uc3QgcHkxID0gTWF0aC5tYXgoMCwgTWF0aC5yb3VuZCgoeTEgLyAxMDAwKSAqIGhlaWdodCkpO1xuICBjb25zdCBweDIgPSBNYXRoLm1pbih3aWR0aCwgTWF0aC5yb3VuZCgoeDIgLyAxMDAwKSAqIHdpZHRoKSk7XG4gIGNvbnN0IHB5MiA9IE1hdGgubWluKGhlaWdodCwgTWF0aC5yb3VuZCgoeTIgLyAxMDAwKSAqIGhlaWdodCkpO1xuICByZXR1cm4gW3B4MSwgcHkxLCBweDIsIHB5Ml07XG59XG5cbi8vIEJ1aWxkIHRoZSBtYW5pZmVzdCBgZWxlbWVudHNbXWAgZnJvbSB0aGUgbW9kZWwncyBwYXJzZWQgYXJyYXkgKyBpbWFnZSBzaXplLlxuLy8gU2tpcHMgZW50cmllcyBtaXNzaW5nIGEgbmFtZSBvciBib3ggKG1hdGNoZXMgdGhlIFB5dGhvbiBvcmlnaW5hbCdzIGZpbHRlcikuXG5leHBvcnQgZnVuY3Rpb24gZWxlbWVudHNGcm9tUmF3KHJhdzogdW5rbm93bltdLCB3aWR0aDogbnVtYmVyLCBoZWlnaHQ6IG51bWJlcik6IE1hbmlmZXN0RWxlbWVudFtdIHtcbiAgY29uc3QgZWxlbWVudHM6IE1hbmlmZXN0RWxlbWVudFtdID0gW107XG4gIGZvciAoY29uc3QgZW50cnkgb2YgcmF3KSB7XG4gICAgaWYgKCFlbnRyeSB8fCB0eXBlb2YgZW50cnkgIT09IFwib2JqZWN0XCIpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGUgPSBlbnRyeSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICBjb25zdCBuYW1lID0gZS5uYW1lO1xuICAgIGNvbnN0IGtpbmQgPSAodHlwZW9mIGUudHlwZSA9PT0gXCJzdHJpbmdcIiA/IGUudHlwZSA6IFwib3RoZXJcIikgYXMgRWxlbWVudFR5cGU7XG4gICAgY29uc3QgYm94ID0gZS5ib3hfMmQ7XG4gICAgaWYgKCFuYW1lIHx8IHR5cGVvZiBuYW1lICE9PSBcInN0cmluZ1wiIHx8ICFBcnJheS5pc0FycmF5KGJveCkpIGNvbnRpbnVlO1xuICAgIGVsZW1lbnRzLnB1c2goe1xuICAgICAgbmFtZSxcbiAgICAgIHR5cGU6IGtpbmQsXG4gICAgICBib3hfMmQ6IGJveCBhcyBudW1iZXJbXSxcbiAgICAgIGJib3hfcGl4ZWw6IG5vcm1hbGl6ZWRUb1BpeGVsKGJveCBhcyBudW1iZXJbXSwgd2lkdGgsIGhlaWdodCksXG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIGVsZW1lbnRzO1xufVxuXG4vLyDilIDilIAgaW1hZ2UgcmVhZCArIGVuY29kZSDilIDilIBcblxuZXhwb3J0IGZ1bmN0aW9uIG1pbWVGb3JQYXRoKHBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBNSU1FX0JZX0VYVFtleHRuYW1lKHBhdGgpLnRvTG93ZXJDYXNlKCldID8/IFwiaW1hZ2UvcG5nXCI7XG59XG5cbi8vIFJlYWQgYW4gaW1hZ2UgZmlsZSDihpIgYSBiYXNlNjQgZGF0YSBVUkwsIGVuZm9yY2luZyB0aGUgc2l6ZSBndWFyZC4gVGhyb3dzXG4vLyBEaXNjb3ZlckVycm9yIGFib3ZlIE1BWF9JTUFHRV9CWVRFUzsgd2FybnMgKHN0ZGVycikgYWJvdmUgV0FSTl9JTUFHRV9CWVRFUy5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBlbmNvZGVJbWFnZURhdGFVcmwocGF0aDogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgY29uc3QgZmlsZSA9IEJ1bi5maWxlKHBhdGgpO1xuICBjb25zdCBzaXplID0gZmlsZS5zaXplO1xuICBpZiAoc2l6ZSA+IE1BWF9JTUFHRV9CWVRFUykge1xuICAgIGNvbnN0IG1iID0gKHNpemUgLyAxXzA0OF81NzYpLnRvRml4ZWQoMSk7XG4gICAgY29uc3QgbGltaXQgPSBNYXRoLmZsb29yKE1BWF9JTUFHRV9CWVRFUyAvIDFfMDQ4XzU3Nik7XG4gICAgdGhyb3cgbmV3IERpc2NvdmVyRXJyb3IoXG4gICAgICBgJHtwYXRofSBpcyAke21ifSBNQiwgYWJvdmUgdGhlICR7bGltaXR9IE1CIGxpbWl0LiBSZXNpemUgYmVmb3JlIHJldHJ5aW5nIGAgK1xuICAgICAgICBgKGUuZy4gSW1hZ2VNYWdpY2s6IFxcYG1hZ2ljayBpbi5wbmcgLXJlc2l6ZSAyMDAweDIwMDBcXFxcPiBvdXQucG5nXFxgKS5gLFxuICAgICk7XG4gIH1cbiAgaWYgKHNpemUgPiBXQVJOX0lNQUdFX0JZVEVTKSB7XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBgV0FSTjogJHtwYXRofSBpcyAkeyhzaXplIC8gMV8wNDhfNTc2KS50b0ZpeGVkKDEpfSBNQjsgbGFyZ2UgcmVxdWVzdHMgc29tZXRpbWVzIGhpdCBPcGVuUm91dGVyJ3MgcGF5bG9hZCBsaW1pdHMuXFxuYCxcbiAgICApO1xuICB9XG4gIGNvbnN0IGJ5dGVzID0gbmV3IFVpbnQ4QXJyYXkoYXdhaXQgZmlsZS5hcnJheUJ1ZmZlcigpKTtcbiAgY29uc3QgYjY0ID0gQnVmZmVyLmZyb20oYnl0ZXMpLnRvU3RyaW5nKFwiYmFzZTY0XCIpO1xuICByZXR1cm4gYGRhdGE6JHttaW1lRm9yUGF0aChwYXRoKX07YmFzZTY0LCR7YjY0fWA7XG59XG5cbi8vIEltYWdlIHBpeGVsIHNpemUgdmlhIEJ1bi5JbWFnZSBtZXRhZGF0YSAocmVwbGFjZXMgdGhlIFB5dGhvbiBvcmlnaW5hbCdzIFBpbGxvdyByZWFkKS5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBpbWFnZVNpemUocGF0aDogc3RyaW5nKTogUHJvbWlzZTxbbnVtYmVyLCBudW1iZXJdPiB7XG4gIGNvbnN0IGJ5dGVzID0gbmV3IFVpbnQ4QXJyYXkoYXdhaXQgQnVuLmZpbGUocGF0aCkuYXJyYXlCdWZmZXIoKSk7XG4gIGNvbnN0IG1ldGEgPSBhd2FpdCBuZXcgQnVuLkltYWdlKGJ5dGVzKS5tZXRhZGF0YSgpO1xuICByZXR1cm4gW21ldGEud2lkdGggPz8gMCwgbWV0YS5oZWlnaHQgPz8gMF07XG59XG5cbi8vIEZpcnN0IDE2IGNoYXJzIG9mIHRoZSBmaWxlJ3Mgc2hhMjU2IChtYXRjaGVzIHRoZSBQeXRob24gb3JpZ2luYWwpLlxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNvdXJjZVNoYTI1Nl8xNihwYXRoOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCBieXRlcyA9IG5ldyBVaW50OEFycmF5KGF3YWl0IEJ1bi5maWxlKHBhdGgpLmFycmF5QnVmZmVyKCkpO1xuICByZXR1cm4gbmV3IEJ1bi5DcnlwdG9IYXNoZXIoXCJzaGEyNTZcIikudXBkYXRlKGJ5dGVzKS5kaWdlc3QoXCJoZXhcIikuc2xpY2UoMCwgMTYpO1xufVxuXG4vLyDilIDilIAgT3BlblJvdXRlciBjYWxsIOKUgOKUgFxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY2FsbE9wZW5Sb3V0ZXIoXG4gIGFwaUtleTogc3RyaW5nLFxuICBtb2RlbDogc3RyaW5nLFxuICBpbWFnZURhdGFVcmw6IHN0cmluZyxcbiAgcHJvbXB0OiBzdHJpbmcsXG4pOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB7XG4gIGNvbnN0IGJvZHkgPSB7XG4gICAgbW9kZWwsXG4gICAgbWVzc2FnZXM6IFtcbiAgICAgIHtcbiAgICAgICAgcm9sZTogXCJ1c2VyXCIsXG4gICAgICAgIGNvbnRlbnQ6IFtcbiAgICAgICAgICB7IHR5cGU6IFwidGV4dFwiLCB0ZXh0OiBwcm9tcHQgfSxcbiAgICAgICAgICB7IHR5cGU6IFwiaW1hZ2VfdXJsXCIsIGltYWdlX3VybDogeyB1cmw6IGltYWdlRGF0YVVybCB9IH0sXG4gICAgICAgIF0sXG4gICAgICB9LFxuICAgIF0sXG4gICAgdGVtcGVyYXR1cmU6IDAsXG4gIH07XG4gIGNvbnN0IGN0cmwgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiBjdHJsLmFib3J0KCksIDE4MF8wMDApO1xuICB0cnkge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKE9QRU5ST1VURVJfVVJMLCB7XG4gICAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgICAgaGVhZGVyczoge1xuICAgICAgICBBdXRob3JpemF0aW9uOiBgQmVhcmVyICR7YXBpS2V5fWAsXG4gICAgICAgIFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiLFxuICAgICAgICBcIkhUVFAtUmVmZXJlclwiOiBcImh0dHBzOi8vZ2l0aHViLmNvbS9pY2hhYm9kY29sZS9zcGVsbGJvb2tcIixcbiAgICAgICAgXCJYLVRpdGxlXCI6IFwibWFncGllXCIsXG4gICAgICB9LFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoYm9keSksXG4gICAgICBzaWduYWw6IGN0cmwuc2lnbmFsLFxuICAgIH0pO1xuICAgIGlmICghcmVzLm9rKSB7XG4gICAgICBjb25zdCB0ZXh0ID0gYXdhaXQgcmVzLnRleHQoKS5jYXRjaCgoKSA9PiBcIlwiKTtcbiAgICAgIHRocm93IG5ldyBEaXNjb3ZlckVycm9yKGBPcGVuUm91dGVyIEhUVFAgJHtyZXMuc3RhdHVzfTogJHt0ZXh0fWApO1xuICAgIH1cbiAgICByZXR1cm4gKGF3YWl0IHJlcy5qc29uKCkpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gIH1cbn1cblxuLy8g4pSA4pSAIG9yY2hlc3RyYXRpb24g4pSA4pSAXG5cbmV4cG9ydCB0eXBlIERpc2NvdmVyT3B0aW9ucyA9IHsgbW9kZWw/OiBzdHJpbmc7IGFwaUtleT86IHN0cmluZyB9O1xuXG4vLyBGdWxsIGRpc2NvdmVyOiByZWFkIGltYWdlLCBjYWxsIHRoZSBtb2RlbCwgcGFyc2UsIGJ1aWxkIHRoZSBtYW5pZmVzdC4gVGhyb3dzXG4vLyBEaXNjb3ZlckVycm9yIG9uIGFjdGlvbmFibGUgZmFpbHVyZXMgKG1pc3Npbmcga2V5LCBvdmVyc2l6ZWQgaW1hZ2UsIEhUVFAgL1xuLy8gcGFyc2UgZXJyb3JzKS4gVGhlIE9QRU5ST1VURVJfQVBJX0tFWSBtdXN0IGJlIGluIHRoZSBlbnZpcm9ubWVudCDigJQgd2UgbmV2ZXJcbi8vIGluc3RhbGwgYSBrZXkuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZGlzY292ZXIoaW1hZ2VQYXRoOiBzdHJpbmcsIG9wdHM6IERpc2NvdmVyT3B0aW9ucyA9IHt9KTogUHJvbWlzZTxNYW5pZmVzdD4ge1xuICBjb25zdCBtb2RlbCA9IG9wdHMubW9kZWwgPz8gREVGQVVMVF9NT0RFTDtcbiAgY29uc3QgYXBpS2V5ID0gb3B0cy5hcGlLZXkgPz8gcHJvY2Vzcy5lbnYuT1BFTlJPVVRFUl9BUElfS0VZO1xuICBpZiAoIWFwaUtleSkge1xuICAgIHRocm93IG5ldyBEaXNjb3ZlckVycm9yKFwiT1BFTlJPVVRFUl9BUElfS0VZIGVudiB2YXIgbm90IHNldFwiKTtcbiAgfVxuICBpZiAoIShhd2FpdCBCdW4uZmlsZShpbWFnZVBhdGgpLmV4aXN0cygpKSkge1xuICAgIHRocm93IG5ldyBEaXNjb3ZlckVycm9yKGBpbWFnZSBub3QgZm91bmQ6ICR7aW1hZ2VQYXRofWApO1xuICB9XG5cbiAgY29uc3QgW3NpemUsIGRhdGFVcmwsIHNoYV0gPSBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgaW1hZ2VTaXplKGltYWdlUGF0aCksXG4gICAgZW5jb2RlSW1hZ2VEYXRhVXJsKGltYWdlUGF0aCksXG4gICAgc291cmNlU2hhMjU2XzE2KGltYWdlUGF0aCksXG4gIF0pO1xuICBjb25zdCBbd2lkdGgsIGhlaWdodF0gPSBzaXplO1xuXG4gIGNvbnN0IHJlc3AgPSBhd2FpdCBjYWxsT3BlblJvdXRlcihhcGlLZXksIG1vZGVsLCBkYXRhVXJsLCBQUk9NUFQpO1xuXG4gIGNvbnN0IGNob2ljZXMgPSByZXNwLmNob2ljZXMgYXMgQXJyYXk8eyBtZXNzYWdlPzogeyBjb250ZW50PzogdW5rbm93biB9IH0+IHwgdW5kZWZpbmVkO1xuICBjb25zdCBjb250ZW50ID0gY2hvaWNlcz8uWzBdPy5tZXNzYWdlPy5jb250ZW50O1xuICBpZiAodHlwZW9mIGNvbnRlbnQgIT09IFwic3RyaW5nXCIpIHtcbiAgICB0aHJvdyBuZXcgRGlzY292ZXJFcnJvcihcbiAgICAgIGB1bmV4cGVjdGVkIHJlc3BvbnNlIHNoYXBlIGZyb20gT3BlblJvdXRlciAobm8gY2hvaWNlc1swXS5tZXNzYWdlLmNvbnRlbnQpOlxcbiR7SlNPTi5zdHJpbmdpZnkocmVzcCkuc2xpY2UoMCwgMjAwMCl9YCxcbiAgICApO1xuICB9XG5cbiAgY29uc3QgdXNhZ2UgPSAocmVzcC51c2FnZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPz8ge307XG4gIGNvbnN0IGNvc3QgPSB0eXBlb2YgdXNhZ2UuY29zdCA9PT0gXCJudW1iZXJcIiA/IHVzYWdlLmNvc3QgOiAwO1xuICBjb25zdCBwcm9tcHRUb2tlbnMgPSB0eXBlb2YgdXNhZ2UucHJvbXB0X3Rva2VucyA9PT0gXCJudW1iZXJcIiA/IHVzYWdlLnByb21wdF90b2tlbnMgOiAwO1xuICBjb25zdCBjb21wbGV0aW9uVG9rZW5zID1cbiAgICB0eXBlb2YgdXNhZ2UuY29tcGxldGlvbl90b2tlbnMgPT09IFwibnVtYmVyXCIgPyB1c2FnZS5jb21wbGV0aW9uX3Rva2VucyA6IDA7XG4gIGNvbnN0IGRldGFpbHMgPSAodXNhZ2UuY29tcGxldGlvbl90b2tlbnNfZGV0YWlscyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPz8ge307XG4gIGNvbnN0IHJlYXNvbmluZ1Rva2VucyA9XG4gICAgdHlwZW9mIGRldGFpbHMucmVhc29uaW5nX3Rva2VucyA9PT0gXCJudW1iZXJcIiA/IGRldGFpbHMucmVhc29uaW5nX3Rva2VucyA6IDA7XG5cbiAgbGV0IHJhdzogdW5rbm93bltdO1xuICB0cnkge1xuICAgIHJhdyA9IHBhcnNlQmJveGVzKGNvbnRlbnQpO1xuICB9IGNhdGNoIChleCkge1xuICAgIHRocm93IG5ldyBEaXNjb3ZlckVycm9yKFxuICAgICAgYG1vZGVsIHJldHVybmVkIG5vbi1KU09OIG91dHB1dDpcXG4ke2NvbnRlbnR9XFxuXFxuUGFyc2UgZXJyb3I6ICR7ZXggaW5zdGFuY2VvZiBFcnJvciA/IGV4Lm1lc3NhZ2UgOiBTdHJpbmcoZXgpfWAsXG4gICAgKTtcbiAgfVxuXG4gIHJldHVybiB7XG4gICAgc291cmNlOiByZXNvbHZlKGltYWdlUGF0aCksXG4gICAgc291cmNlX3NpemU6IFt3aWR0aCwgaGVpZ2h0XSxcbiAgICBzb3VyY2Vfc2hhMjU2XzE2OiBzaGEsXG4gICAgbW9kZWwsXG4gICAgY29zdF91c2Q6IGNvc3QsXG4gICAgdG9rZW5zOiB7IHByb21wdDogcHJvbXB0VG9rZW5zLCBjb21wbGV0aW9uOiBjb21wbGV0aW9uVG9rZW5zLCByZWFzb25pbmc6IHJlYXNvbmluZ1Rva2VucyB9LFxuICAgIGVsZW1lbnRzOiBlbGVtZW50c0Zyb21SYXcocmF3LCB3aWR0aCwgaGVpZ2h0KSxcbiAgfTtcbn1cblxuLy8g4pSA4pSAIENMSSBlbnRyeSAocGFyaXR5IHdpdGggdGhlIFB5dGhvbiBvcmlnaW5hbCkg4pSA4pSAXG5hc3luYyBmdW5jdGlvbiBtYWluKGFyZ3Y6IHN0cmluZ1tdKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgY29uc3QgeyBwYXJzZUFyZ3MgfSA9IGF3YWl0IGltcG9ydChcIm5vZGU6dXRpbFwiKTtcbiAgbGV0IHBhcnNlZDogUmV0dXJuVHlwZTx0eXBlb2YgcGFyc2VBcmdzPjtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBwYXJzZUFyZ3Moe1xuICAgICAgYXJnczogYXJndixcbiAgICAgIG9wdGlvbnM6IHtcbiAgICAgICAgb3V0OiB7IHR5cGU6IFwic3RyaW5nXCIgfSxcbiAgICAgICAgbW9kZWw6IHsgdHlwZTogXCJzdHJpbmdcIiwgZGVmYXVsdDogREVGQVVMVF9NT0RFTCB9LFxuICAgICAgfSxcbiAgICAgIGFsbG93UG9zaXRpb25hbHM6IHRydWUsXG4gICAgICBzdHJpY3Q6IHRydWUsXG4gICAgfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShgZXJyb3I6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfVxcbmApO1xuICAgIHJldHVybiAyO1xuICB9XG4gIGNvbnN0IGltYWdlUGF0aCA9IHBhcnNlZC5wb3NpdGlvbmFsc1swXTtcbiAgaWYgKCFpbWFnZVBhdGgpIHtcbiAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcInVzYWdlOiBkaXNjb3Zlci50cyA8aW1hZ2U+IFstLW91dCA8bWFuaWZlc3QuanNvbj5dIFstLW1vZGVsIDxtb2RlbD5dXFxuXCIpO1xuICAgIHJldHVybiAyO1xuICB9XG4gIHRyeSB7XG4gICAgY29uc3QgbWFuaWZlc3QgPSBhd2FpdCBkaXNjb3ZlcihpbWFnZVBhdGgsIHsgbW9kZWw6IHBhcnNlZC52YWx1ZXMubW9kZWwgYXMgc3RyaW5nIH0pO1xuICAgIGNvbnN0IG91dCA9XG4gICAgICAocGFyc2VkLnZhbHVlcy5vdXQgYXMgc3RyaW5nIHwgdW5kZWZpbmVkKSA/P1xuICAgICAgam9pbihkaXJuYW1lKHJlc29sdmUoaW1hZ2VQYXRoKSksIGAke2Jhc2VTdGVtKGltYWdlUGF0aCl9LW1hbmlmZXN0Lmpzb25gKTtcbiAgICBhd2FpdCBCdW4ud3JpdGUob3V0LCBKU09OLnN0cmluZ2lmeShtYW5pZmVzdCwgbnVsbCwgMikpO1xuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKFxuICAgICAgYERpc2NvdmVyZWQgJHttYW5pZmVzdC5lbGVtZW50cy5sZW5ndGh9IGVsZW1lbnQocykg4oCUIGNvc3QgJCR7bWFuaWZlc3QuY29zdF91c2QudG9GaXhlZCg0KX1cXG5gLFxuICAgICk7XG4gICAgZm9yIChjb25zdCBlIG9mIG1hbmlmZXN0LmVsZW1lbnRzKSB7XG4gICAgICBjb25zdCBbeDEsIHkxLCB4MiwgeTJdID0gZS5iYm94X3BpeGVsO1xuICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoYCAgJHtlLnR5cGV9ICAke2UubmFtZX0gIHNyYz0oJHt4MX0sJHt5MX0sJHt4Mn0sJHt5Mn0pXFxuYCk7XG4gICAgfVxuICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGBNYW5pZmVzdCB3cml0dGVuOiAke291dH1cXG5gKTtcbiAgICByZXR1cm4gMDtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGlmIChlIGluc3RhbmNlb2YgRGlzY292ZXJFcnJvcikge1xuICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYEVSUk9SOiAke2UubWVzc2FnZX1cXG5gKTtcbiAgICAgIHJldHVybiAxO1xuICAgIH1cbiAgICB0aHJvdyBlO1xuICB9XG59XG5cbmZ1bmN0aW9uIGJhc2VTdGVtKHBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IGJhc2UgPSBwYXRoLnNwbGl0KFwiL1wiKS5wb3AoKSA/PyBwYXRoO1xuICBjb25zdCBkb3QgPSBiYXNlLmxhc3RJbmRleE9mKFwiLlwiKTtcbiAgcmV0dXJuIGRvdCA+IDAgPyBiYXNlLnNsaWNlKDAsIGRvdCkgOiBiYXNlO1xufVxuXG5pZiAoaW1wb3J0Lm1ldGEubWFpbikge1xuICAvLyBgcHJvY2Vzcy5leGl0Q29kZWAgKyBhIG5hdHVyYWwgcmV0dXJuLCBORVZFUiBgcHJvY2Vzcy5leGl0KGNvZGUpYDogQnVuJ3NcbiAgLy8gc3Rkb3V0IGlzIEFTWU5DSFJPTk9VUyBvbiBhIHBpcGUgKHN5bmNocm9ub3VzIG9uIGEgVFRZIG9yIGZpbGUpLCBzbyBhblxuICAvLyBleHBsaWNpdCBleGl0IGRpc2NhcmRzIHdoYXRldmVyIGhhcyBub3QgZHJhaW5lZCDigJQgbWVhc3VyZWQgYXQgZXhhY3RseVxuICAvLyA2NSw1MzYgYnl0ZXMuIFRoZSBwYXlsb2FkIGlzIGNvbXBsZXRlIGFuZCBvbmx5IHRoZSB3cml0ZSBpcyBsb3N0LCBzbyB0aGVcbiAgLy8gY2FsbGVyIGdldHMgd2VsbC1mb3JtZWQtbG9va2luZyBKU09OIHRoYXQgc3RvcHMgbWlkLXN0cmluZy4gUmVwcm9kdWNlZCxcbiAgLy8gZml4ZWQgYW5kIGdhdGVkIGluIGJvdW50eSBmaXJzdCAoUDAsICM3Ny8jNzgpOyBzYW1lIHNoYXBlLCBzYW1lIHJlYXNvbi5cbiAgLy8gRG8gbm90IHRpZHkgdGhpcyBiYWNrIGludG8gYW4gZXhwbGljaXQgZXhpdC5cbiAgcHJvY2Vzcy5leGl0Q29kZSA9IGF3YWl0IG1haW4ocHJvY2Vzcy5hcmd2LnNsaWNlKDIpKTtcbn1cbiIsCiAgICAiLy8gc2hhcmVkL3R5cGVzLnRzXG4vLyBUaGUgc2luZ2xlIHNoYXJlZCBjb250cmFjdCBmb3IgbWFncGllJ3MgY29uanVyYXRpb24uIEltcG9ydGVkIGJ5IHNlcnZlci50cyxcbi8vIHJlZHVjZS50cywgY2xpLnRzLCBBTkQgdGhlIFJlYWN0IGNsaWVudC5cbi8vXG4vLyBtYWdwaWUgKHJlYnVpbHQpIGlzIGEgU1RBTkRJTkcgUkVWSUVXIFNVUkZBQ0Ugb3ZlciBhIGNvbXBvc2l0ZSBpbWFnZTogdGhlXG4vLyBkYWVtb24gaG9sZHMgdGhlIGV4dHJhY3Rpb24gc3RhdGUsIHRoZSBSZWFjdCBzdXJmYWNlIHNob3dzIHRoZSBlbGVtZW50XG4vLyBicmVha2Rvd24sIGFuZCB0aGUgdXNlciBqdWRnZXMgZWFjaCBjdXRvdXQsIGNvbXBhcmVzIHJlbW92YWwtbW9kZWwgcmVzdWx0cyxcbi8vIGFuZCBzZWxlY3RpdmVseSByZXRyaWVzLiBUaGUgYWdlbnQgZHJpdmVzIGRpc2NvdmVyeSArIGV4dHJhY3Rpb247IHRoZSBzdXJmYWNlXG4vLyBpcyB3aGVyZSB0aGUgdXNlciBzdGVlcnMuXG4vL1xuLy8gUFJPVklTSU9OQUwg4oCUIHRoaXMgc3RhdGUgc2hhcGUgaXMgYSBkZXNpZ24taW5kZXBlbmRlbnQgc2tlbGV0b24uIFRoZVxuLy8gbWFncGllLXNwZWNpZmljIHN1cmZhY2UgKyB0aGUgZmluYWwgc2V0dGxlZCBzaGFwZSBhcmUgYmVpbmcgZGVzaWduZWQgaW5cbi8vIHBhcmFsbGVsLiBFdmVyeXRoaW5nIG1hcmtlZCBgLy8gVE9ETyhtb2NrKTog4oCmYCBpcyBhIGRlbGliZXJhdGUgcGxhY2Vob2xkZXIgdGhlXG4vLyBtb2NrIHRyYWNrIHdpbGwgcmVwbGFjZTsga2VlcCBtdXRhdG9ycyAocmVkdWNlLnRzKSB0aGluIGFyb3VuZCBpdC5cblxuLy8gVGhlIGVsZW1lbnQgdHlwZSB0YXhvbm9teSBwb3J0ZWQgZnJvbSB0aGUgUHl0aG9uIG9yaWdpbmFsIOKAlCBkcml2ZXMgdGhlIChmdXR1cmUpXG4vLyBiYWNrZ3JvdW5kLXJlbW92YWwgZGVjaXNpb24gaW4gZXh0cmFjdC5cbmV4cG9ydCB0eXBlIEVsZW1lbnRUeXBlID1cbiAgfCBcIndvcmRtYXJrXCJcbiAgfCBcInRhZ2xpbmVcIlxuICB8IFwiaWNvblwiXG4gIHwgXCJpbGx1c3RyYXRpb25cIlxuICB8IFwic3RpY2tlclwiXG4gIHwgXCJwYWxldHRlXCJcbiAgfCBcInR5cG9ncmFwaHlcIlxuICB8IFwic2NyZWVuc2hvdFwiXG4gIHwgXCJvdGhlclwiO1xuXG5leHBvcnQgY29uc3QgRUxFTUVOVF9UWVBFUzogcmVhZG9ubHkgRWxlbWVudFR5cGVbXSA9IFtcbiAgXCJ3b3JkbWFya1wiLFxuICBcInRhZ2xpbmVcIixcbiAgXCJpY29uXCIsXG4gIFwiaWxsdXN0cmF0aW9uXCIsXG4gIFwic3RpY2tlclwiLFxuICBcInBhbGV0dGVcIixcbiAgXCJ0eXBvZ3JhcGh5XCIsXG4gIFwic2NyZWVuc2hvdFwiLFxuICBcIm90aGVyXCIsXG5dIGFzIGNvbnN0O1xuXG4vLyBUaGUgbGluZWFyIHByb2Nlc3Mgc3BpbmUgKHRoZSB0b3AtYmFyIHN0ZXBwZXIpLiBPbmUgYWN0aXZlIHBoYXNlIGF0IGEgdGltZTtcbi8vIHRoZSBjdXJzb3IgYWR2YW5jZXMgd2hlbiB0aGUgdXNlciBzZWFscyBhIHBoYXNlLiBTdGF0dXMgaXMgREVSSVZFRCBmcm9tIHRoZVxuLy8gY3Vyc29yIOKAlCBwaGFzZXMgYmVmb3JlIGl0IGFyZSBzZWFsZWQsIHRoZSBjdXJzb3IgaXMgYWN0aXZlLCBhZnRlciBpcyB1cGNvbWluZy5cbmV4cG9ydCB0eXBlIFBoYXNlS2V5ID0gXCJpbnRha2VcIiB8IFwic2xpY2VcIiB8IFwicmVtb3ZlXCIgfCBcImV4cG9ydFwiO1xuZXhwb3J0IGNvbnN0IFBIQVNFUzogcmVhZG9ubHkgUGhhc2VLZXlbXSA9IFtcImludGFrZVwiLCBcInNsaWNlXCIsIFwicmVtb3ZlXCIsIFwiZXhwb3J0XCJdIGFzIGNvbnN0O1xuXG4vLyBBIHBpeGVsIGJvdW5kaW5nIGJveCBbeDEsIHkxLCB4MiwgeTJdIGluIHNvdXJjZS1pbWFnZSBjb29yZGluYXRlcyAobWF0Y2hlc1xuLy8gdGhlIFB5dGhvbiBvcmlnaW5hbCdzIGBiYm94X3BpeGVsYCkuXG5leHBvcnQgdHlwZSBCYm94ID0gW251bWJlciwgbnVtYmVyLCBudW1iZXIsIG51bWJlcl07XG5cbi8vIFRoZSBiYWNrZHJvcCB0aGUgc3VyZmFjZSBwcmV2aWV3cyBjdXRvdXRzIGFnYWluc3QgKGEgY2hlY2tlciBmb3IgdHJhbnNwYXJlbnQpLlxuZXhwb3J0IHR5cGUgQmFja2Ryb3AgPSBcIndoaXRlXCIgfCBcImdyYXlcIiB8IFwiYmxhY2tcIiB8IFwidHJhbnNwYXJlbnRcIjtcblxuLy8gT25lIGV4dHJhY3RhYmxlIGVsZW1lbnQuIE1JTklNQUwgcHJvdmlzaW9uYWwgc2hhcGUg4oCUIHRoZSByZXZpZXcvanVkZ21lbnRcbi8vIG1hY2hpbmVyeSBpcyBtb2NrZWQgb3V0IGZvciBub3cuIGBiYm94YCBpcyBjYW5vbmljYWwgaW4gU09VUkNFIFBJWEVMUyAod2hhdFxuLy8gZGlzY292ZXIgcHJvZHVjZXMgYW5kIGNyb3AgY29uc3VtZXMpOyB0aGUgY2FudmFzIGNvbnZlcnRzIHB44oaUZnJhY3Rpb24gdmlhXG4vLyBgc291cmNlLnNpemVgIGZvciByZW5kZXJpbmcvZWRpdGluZy5cbmV4cG9ydCB0eXBlIEVsZW1lbnRTdGF0dXMgPSBcInByb3Bvc2VkXCIgfCBcImNvbmZpcm1lZFwiIHwgXCJkcm9wcGVkXCI7XG5cbi8vIEEgcHJvZHVjZWQgYXNzZXQgZm9yIG9uZSBlbGVtZW50OiB0aGUgcmF3IGNyb3AgKG1vZGVsOlwiY3JvcFwiKSBvciBhIHJlbW92YWxcbi8vIHJlc3VsdC4gYHBhdGhgIGlzIHRoZSBvbi1kaXNrIFBORyBzZXJ2ZWQgdmlhIC9hc3NldHM7IGByZXZgIGJ1bXBzIG9uIGV2ZXJ5XG4vLyAocmUtKXJ1biBvZiB0aGUgU0FNRSBtb2RlbCDigJQgdGhlIGZpbGUgaXMgb3ZlcndyaXR0ZW4gaW4gcGxhY2UsIHNvIHRoZSBzdXJmYWNlXG4vLyBhcHBlbmRzID92PTxyZXY+IHRvIGJ1c3QgdGhlIGJyb3dzZXIgY2FjaGUuIGBraW5kYCBpcyBhIGxhYmVsLWNoaXAgaGludCB0aGVcbi8vIGFnZW50IHN1cHBsaWVzOyBuZXZlciBpbmZlcnJlZCBpbiB0aGUgVUkuXG5leHBvcnQgdHlwZSBFbGVtZW50VmVyc2lvbiA9IHtcbiAgaWQ6IHN0cmluZztcbiAgbW9kZWw6IHN0cmluZzsgLy8gXCJjcm9wXCIgfCBcInJlbWJnXCIgfCBcImJyaWFcIiB8IFwiaWRlb2dyYW1cIiB8IOKApiAoYWdlbnQtZGVmaW5lZClcbiAga2luZD86IFwicmF3XCIgfCBcImxvY2FsXCIgfCBcImNsb3VkXCI7XG4gIHBhdGg6IHN0cmluZztcbiAgcmV2OiBudW1iZXI7XG4gIG5vdGU/OiBzdHJpbmc7XG59O1xuXG5leHBvcnQgdHlwZSBFbGVtZW50ID0ge1xuICBpZDogc3RyaW5nO1xuICBuYW1lOiBzdHJpbmc7XG4gIHR5cGU6IEVsZW1lbnRUeXBlO1xuICBiYm94OiBCYm94O1xuICBzdGF0dXM6IEVsZW1lbnRTdGF0dXM7XG4gIC8vIOKUgOKUgCBleHRyYWN0aW9uIOKUgOKUgFxuICAvLyBQcm9kdWNlZCBhc3NldHMsIG9uZSByb3cgcGVyIG1vZGVsLiBjcm9wID0gdmVyc2lvbnNbMF0gKG1vZGVsOlwiY3JvcFwiKS5cbiAgLy8gQWJzZW50IHVudGlsIHRoZSBmaXJzdCBjdXQ7IHRyZWF0IHVuZGVmaW5lZCBhcyBbXS4gVGhlIGNob3NlbiB2ZXJzaW9uIGlzXG4gIC8vIHdoYXQgdGhlIHJhaWwvZ2FsbGVyeSByZW5kZXIgKGNob3NlblZlcnNpb24oKSBmYWxscyBiYWNrIHRvIHZlcnNpb25zWzBdKS5cbiAgdmVyc2lvbnM/OiBFbGVtZW50VmVyc2lvbltdO1xuICBjaG9zZW5WZXJzaW9uSWQ/OiBzdHJpbmc7XG4gIC8vIFRoZSBzb2xlIHJldmlldyBzaWduYWw6IHRoZSB1c2VyIGZsYWdnZWQgdGhpcyBlbGVtZW50IHRvIGJlIHJlLXJ1biAocmUtc2xpY2VcbiAgLy8gaW4gdGhlIHNsaWNlcyBwaGFzZSwgcmUtcmVtb3ZlIGluIHRoZSBiZyBwaGFzZSkuIEFwcHJvdmFsIGlzIHRoZSBBQlNFTkNFIG9mIGFcbiAgLy8gZmxhZzsgZGlzY2FyZGluZyBpcyBzdGF0dXM6XCJkcm9wcGVkXCIuIENsZWFyZWQgd2hlbiBhIGZyZXNoIHZlcnNpb24gbGFuZHMuXG4gIGZsYWdnZWQ/OiBib29sZWFuO1xufTtcblxuLy8g4pSA4pSAIHRoZSBjb252ZXJzYXRpb24gKHRoZSBzcGluZSwgcG9ydGVkIHNldHRsZWQgZnJvbSBpbWFnbykg4pSA4pSAXG5leHBvcnQgdHlwZSBNZXNzYWdlS2luZCA9XG4gIHwgXCJ0ZXh0XCIgLy8gcGxhaW4gZGlhbG9ndWUgKGVpdGhlciByb2xlKVxuICB8IFwiZ2VzdHVyZVwiIC8vIGEgc3VyZmFjZSBhY3Rpb24gc3VyZmFjZWQgYXMgYSBtZXNzYWdlICh1c2VyIGp1ZGdlZC9yZXRyaWVkL+KApilcbiAgfCBcInF1ZXN0aW9uXCI7IC8vIGFnZW50IG5lZWRzIHRoZSB1c2VyIChhbiB1bmFuc3dlcmVkIG9uZSDihpIgXCJhc2tpbmdcIiBwcmVzZW5jZSlcblxuZXhwb3J0IHR5cGUgTWVzc2FnZSA9IHtcbiAgaWQ6IHN0cmluZztcbiAgcm9sZTogXCJ1c2VyXCIgfCBcImFnZW50XCI7XG4gIGtpbmQ6IE1lc3NhZ2VLaW5kO1xuICB0ZXh0OiBzdHJpbmc7XG4gIHRzOiBudW1iZXI7XG4gIC8vIGtpbmQ6IFwicXVlc3Rpb25cIiDigJQgb3B0aW9uYWwgcXVpY2sgcmVwbGllcyAodGhlIGZ1bGwgYW5zd2VyIGNhbiBiZSBmcmVlIHRleHQpXG4gIG9wdGlvbnM/OiBzdHJpbmdbXTtcbiAgLy8ga2luZDogXCJnZXN0dXJlXCIg4oCUIHdoYXQgdGhlIHVzZXIgZGlkLCBhbmQgdG8gd2hhdFxuICBnZXN0dXJlPzogeyBraW5kOiBzdHJpbmc7IHRhcmdldElkPzogc3RyaW5nIH07XG4gIC8vIEFuIG9wdGlvbmFsIG9uZS1jbGljayBDVEEgdGhlIGFnZW50IGF0dGFjaGVzIHRvIGEgbWVzc2FnZSDigJQgYSBTSE9SVENVVCBmb3IgYVxuICAvLyBjb252ZXJzYXRpb25hbCBhY3QgKHRoZSB1c2VyIGNvdWxkIGhhdmUganVzdCBzYWlkIGl0KS4gQ2xpY2tpbmcgZGlzcGF0Y2hlc1xuICAvLyBgY29tbWFuZGAgKGUuZy4geyB0eXBlOiBcInBoYXNlLmFkdmFuY2VcIiB9KS4gQ29udmVyc2F0aW9uIHN0YXlzIHRoZSBwcmltYXJ5XG4gIC8vIGNhcGFiaWxpdHk7IHRoaXMgaXMgc3VnYXIgb24gdG9wLCBzdXJmYWNlZCBieSB0aGUgYWdlbnQgYXQgaXRzIGRpc2NyZXRpb24uXG4gIGFjdGlvbj86IHsgbGFiZWw6IHN0cmluZzsgY29tbWFuZDogQ2xpZW50VG9TZXJ2ZXIgfTtcbn07XG5cbi8vIEEgYm94IGJlZm9yZSB0aGUgZGFlbW9uIGFzc2lnbnMgaXQgYW4gaWQg4oCUIGRyYXduIGJ5IHRoZSB1c2VyIChcIm1hcmsgYSBtaXNzZWRcbi8vIHJlZ2lvblwiKSBvciBieSB0aGUgYWdlbnQgYm94aW5nIGluY3JlbWVudGFsbHkuIFRoZSBkYWVtb24gZmlsbHMgYGlkYCBhbmRcbi8vIGRlZmF1bHRzIG5hbWUvdHlwZS9zdGF0dXMgb24gZWxlbWVudC5hZGQuXG5leHBvcnQgdHlwZSBOZXdFbGVtZW50ID0ge1xuICBiYm94OiBCYm94O1xuICBuYW1lPzogc3RyaW5nO1xuICB0eXBlPzogRWxlbWVudFR5cGU7XG4gIHN0YXR1cz86IEVsZW1lbnRTdGF0dXM7XG59O1xuXG4vLyBUaGUgc291cmNlIGNvbXBvc2l0ZSBpbWFnZSB1bmRlciByZXZpZXcuIGBwYXRoYCBpcyB0aGUgb24tZGlzayBmaWxlIHRoZSBhZ2VudFxuLy8gcmVhZHM7IGBzaXplYCBpcyBbdywgaF0gaW4gcHg7IGBzaGFgIGlzIHRoZSBmaXJzdC0xNiBvZiB0aGUgc2hhMjU2IChtYXRjaGVzXG4vLyB0aGUgUHl0aG9uIG9yaWdpbmFsJ3MgYHNvdXJjZV9zaGEyNTZfMTZgKS5cbmV4cG9ydCB0eXBlIFNvdXJjZSA9IHtcbiAgcGF0aDogc3RyaW5nO1xuICBzaXplOiBbbnVtYmVyLCBudW1iZXJdO1xuICBzaGE6IHN0cmluZztcbn07XG5cbi8vIOKUgOKUgCB0aGUgd2hvbGUgc3RhdGUgKFBST1ZJU0lPTkFMKSDilIDilIBcbmV4cG9ydCB0eXBlIE1hZ3BpZVN0YXRlID0ge1xuICB0aXRsZTogc3RyaW5nO1xuICBpbnRlbnQ6IHN0cmluZzsgLy8gd2hhdCB0aGUgdXNlciB3YW50cyBvdXQgb2YgdGhpcyBib2FyZCAoZnJlZSB0ZXh0IHRoZSBhZ2VudCBzZXRzKVxuICBwaGFzZTogUGhhc2VLZXk7IC8vIHRoZSBsaW5lYXIgcHJvY2VzcyBjdXJzb3IgKEludGFrZSDihpIgU2xpY2Ug4oaSIFJlbW92ZSDihpIgRXhwb3J0KVxuICBzb3VyY2U6IFNvdXJjZSB8IG51bGw7XG4gIGVsZW1lbnRzOiBFbGVtZW50W107XG4gIGNvbnZlcnNhdGlvbjogTWVzc2FnZVtdO1xuICBiYWNrZHJvcDogQmFja2Ryb3A7XG4gIHN0YXR1czogeyBidXN5OiBib29sZWFuOyB0ZXh0OiBzdHJpbmcgfTtcbiAgLy8gVGhlIGJ1aWx0IGV4cG9ydCBidW5kbGUgKEV4cG9ydCBwaGFzZSksIGlmIGFueSDigJQgc2VydmVkIHZpYSAvYXNzZXRzLzxuYW1lPi5cbiAgYnVuZGxlPzogeyBuYW1lOiBzdHJpbmc7IGNvdW50OiBudW1iZXIgfTtcbiAgLy8gVGhlIGN1cnJlbnQgc2Vzc2lvbiBpZCAocnVudGltZTsgdGhlIGRhZW1vbiBzZXRzIGl0IGF0IHN0YXJ0LCBOT1QgcGVyc2lzdGVkLVxuICAvLyBtZWFuaW5nZnVsIHNpbmNlIHJlc3RvcmUgbWludHMgYSBuZXcgb25lKSDigJQgc2hvd24gaW4gRXhwb3J0J3MgcmVvcGVuIGhpbnQuXG4gIHNlc3Npb25JZD86IHN0cmluZztcbn07XG5cbmV4cG9ydCBmdW5jdGlvbiBkZWZhdWx0U3RhdGUodGl0bGU6IHN0cmluZyk6IE1hZ3BpZVN0YXRlIHtcbiAgcmV0dXJuIHtcbiAgICB0aXRsZSxcbiAgICBpbnRlbnQ6IFwiXCIsXG4gICAgcGhhc2U6IFwiaW50YWtlXCIsXG4gICAgc291cmNlOiBudWxsLFxuICAgIGVsZW1lbnRzOiBbXSxcbiAgICBjb252ZXJzYXRpb246IFtdLFxuICAgIGJhY2tkcm9wOiBcInRyYW5zcGFyZW50XCIsXG4gICAgc3RhdHVzOiB7IGJ1c3k6IGZhbHNlLCB0ZXh0OiBcIlwiIH0sXG4gIH07XG59XG5cbi8vIOKUgOKUgCBTZXJ2ZXIg4oaSIGJyb3dzZXIgKFdlYlNvY2tldCkuIFRoZSBicm93c2VyIGhhbmRsZXMgZXhhY3RseSB0aGVzZS4g4pSA4pSAXG5leHBvcnQgdHlwZSBTZXJ2ZXJUb0NsaWVudCA9XG4gIHwgeyB0eXBlOiBcInN0YXRlXCI7IHN0YXRlOiBNYWdwaWVTdGF0ZSB9XG4gIHwgeyB0eXBlOiBcIm1lc3NhZ2VcIjsgdGV4dDogc3RyaW5nIH1cbiAgLy8gYWdlbnQgcHJlc2VuY2Ug4oCUIGlzIGF0IGxlYXN0IG9uZSBhZ2VudCB0YWlsaW5nIC9ldmVudHMgKHdhdGNoaW5nIHRoZSBib2FyZCk/XG4gIC8vIHB1c2hlZCBvbiBjaGFuZ2UgKyBvbiBicm93c2VyIGNvbm5lY3Q7IHJ1bnRpbWUtb25seSwgbmV2ZXIgcGVyc2lzdGVkIGluIHN0YXRlLlxuICB8IHsgdHlwZTogXCJwcmVzZW5jZVwiOyBhZ2VudDogYm9vbGVhbiB9XG4gIHwgeyB0eXBlOiBcInN1Ym1pdFwiIH1cbiAgfCB7IHR5cGU6IFwiY2FuY2VsXCIgfTtcblxuLy8g4pSA4pSAIEJyb3dzZXIg4oaSIHNlcnZlciAoV2ViU29ja2V0KS4gVGhlIGNsaWVudCBzZW5kcyBleGFjdGx5IHRoZXNlLiDilIDilIBcbi8vIEVhY2ggZWl0aGVyIG11dGF0ZXMgc3RhdGUgKHJlLWJyb2FkY2FzdCkgYW5kL29yIGVtaXRzIGFuIFNTRSBldmVudCB0aGUgYWdlbnRcbi8vIHJlYWN0cyB0by5cbmV4cG9ydCB0eXBlIENsaWVudFRvU2VydmVyID1cbiAgfCB7IHR5cGU6IFwic2F5XCI7IHRleHQ6IHN0cmluZyB9IC8vIHVzZXIgcG9zdHMgYSBtZXNzYWdlIC8gaW5zdHJ1Y3Rpb25cbiAgfCB7IHR5cGU6IFwic291cmNlLmltcG9ydFwiOyBuYW1lOiBzdHJpbmc7IGRhdGFVcmw6IHN0cmluZyB9IC8vIHVzZXIgZHJvcHBlZCBhIGNvbXBvc2l0ZSDihpIgZGFlbW9uIG1hdGVyaWFsaXplcyBpdFxuICB8IHsgdHlwZTogXCJlbGVtZW50LmFkZFwiOyBlbGVtZW50OiBOZXdFbGVtZW50IH0gLy8gdXNlciBkcmV3IGEgbWlzc2VkIHJlZ2lvbiBvbiB0aGUgY2FudmFzXG4gIHwgeyB0eXBlOiBcImVsZW1lbnQudXBkYXRlXCI7IGlkOiBzdHJpbmc7IHBhdGNoOiBQYXJ0aWFsPEVsZW1lbnQ+IH0gLy8gbW92ZSAvIHJlc2l6ZSAvIHJlbmFtZSAvIHJldHlwZVxuICB8IHsgdHlwZTogXCJlbGVtZW50LnJlbW92ZVwiOyBpZDogc3RyaW5nIH0gLy8gaGFyZC1kZWxldGUgYSBib3ggKHVzdWFsbHkgYSB1c2VyLWRyYXduIG9uZSlcbiAgfCB7IHR5cGU6IFwiZWxlbWVudC5qdWRnZVwiOyBpZDogc3RyaW5nOyBzdGF0dXM6IEVsZW1lbnRTdGF0dXMgfSAvLyBzb2Z0IGNvbmZpcm0vZHJvcCBhIGRpc2NvdmVyZWQgZWxlbWVudFxuICB8IHsgdHlwZTogXCJleHRyYWN0XCI7IGlkcz86IHN0cmluZ1tdIH0gLy8gY3V0IHNsaWNlcyBmb3IgYWxsIGNvbmZpcm1lZCBlbGVtZW50cywgb3IgYSBzdWJzZXQgKHJlLWN1dClcbiAgfCB7IHR5cGU6IFwiZWxlbWVudC5mbGFnXCI7IGlkOiBzdHJpbmc7IGZsYWdnZWQ6IGJvb2xlYW4gfSAvLyBmbGFnL3VuZmxhZyBmb3IgcmUtcnVuIChyZS1zbGljZSBvciByZS1yZW1vdmUpXG4gIHwgeyB0eXBlOiBcInZlcnNpb24uY2hvb3NlXCI7IGlkOiBzdHJpbmc7IHZlcnNpb25JZDogc3RyaW5nIH0gLy8gdXNlciBwaWNrZWQgYSB2ZXJzaW9uIOKGkiBpdCBiZWNvbWVzIGNob3NlbiAoYW1iaWVudClcbiAgfCB7IHR5cGU6IFwicmVtb3ZlQmdcIjsgaWRzPzogc3RyaW5nW10gfSAvLyByZW1vdmUgYmFja2dyb3VuZHMgZm9yIHRoZXNlIGFscGhhLWVsaWdpYmxlIGVsZW1lbnRzIChhYnNlbnQg4oaSIGFsbCBlbGlnaWJsZSlcbiAgfCB7IHR5cGU6IFwicmV0cnlSZW1vdmFsXCI7IGlkczogc3RyaW5nW10gfSAvLyBcInRyeSBhIGRpZmZlcmVudCByZW1vdmFsXCIg4oCUIGFnZW50IHBpY2tzIGFuIFVOVVNFRCBtb2RlbDsgcGF5bG9hZCBpcyBpZHMgb25seVxuICB8IHsgdHlwZTogXCJiYWNrZHJvcC5zZXRcIjsgYmFja2Ryb3A6IEJhY2tkcm9wIH0gLy8gYW1iaWVudCBwcmV2aWV3IGJhY2tkcm9wXG4gIHwgeyB0eXBlOiBcInBoYXNlLmFkdmFuY2VcIiB9IC8vIHNlYWwgdGhlIGFjdGl2ZSBwaGFzZSwgbW92ZSB0aGUgY3Vyc29yIHRvIHRoZSBuZXh0IChpbXBlcmF0aXZlIGhhbmQtb2ZmKVxuICB8IHsgdHlwZTogXCJwaGFzZS5zZXRcIjsgcGhhc2U6IFBoYXNlS2V5IH0gLy8gYmFjay1uYXYgLyBqdW1wIHRvIGEgcGhhc2UgKGFtYmllbnQpXG4gIHwgeyB0eXBlOiBcImV4cG9ydFwiOyBpZHM/OiBzdHJpbmdbXSB9IC8vIGJ1aWxkIHRoZSBkb3dubG9hZGFibGUgYXNzZXQgYnVuZGxlIChjaG9zZW4gdmVyc2lvbnMgb2YgdGhlc2UgLyBhbGwgbm9uLWRyb3BwZWQpXG4gIHwgeyB0eXBlOiBcInN1Ym1pdFwiIH1cbiAgfCB7IHR5cGU6IFwiY2FuY2VsXCIgfTtcblxuLy8g4pSA4pSAIEFnZW50IOKGkiBzZXJ2ZXIgKFBPU1QgL2NtZCkuIFRoZSBhZ2VudCBkcml2ZXMgdGhlIGRhZW1vbiB3aXRoIGV4YWN0bHkgdGhlc2UuIOKUgOKUgFxuZXhwb3J0IHR5cGUgQWdlbnRDb21tYW5kID1cbiAgfCB7IHR5cGU6IFwiaW5pdFwiOyB0aXRsZT86IHN0cmluZzsgaW50ZW50Pzogc3RyaW5nIH1cbiAgfCB7XG4gICAgICB0eXBlOiBcInNheVwiO1xuICAgICAgdGV4dDogc3RyaW5nO1xuICAgICAgYWN0aW9uPzogeyBsYWJlbDogc3RyaW5nOyBjb21tYW5kOiBDbGllbnRUb1NlcnZlciB9O1xuICAgIH0gLy8gcG9zdCBhZ2VudCBkaWFsb2d1ZSAoa2luZDpcInRleHRcIik7IG9wdGlvbmFsIGlubGluZSBDVEEgc2hvcnRjdXRcbiAgfCB7IHR5cGU6IFwiYXNrXCI7IHRleHQ6IHN0cmluZzsgb3B0aW9ucz86IHN0cmluZ1tdIH0gLy8gcG9zdCBhbiBpbi10aHJlYWQgcXVlc3Rpb25cbiAgfCB7IHR5cGU6IFwic291cmNlLnNldFwiOyBwYXRoOiBzdHJpbmc7IHNpemU6IFtudW1iZXIsIG51bWJlcl07IHNoYTogc3RyaW5nIH0gLy8gdGhlIGNvbXBvc2l0ZSB1bmRlciByZXZpZXdcbiAgfCB7IHR5cGU6IFwiZWxlbWVudHMuc2V0XCI7IGVsZW1lbnRzOiBFbGVtZW50W10gfSAvLyBwb3N0IHRoZSBkaXNjb3ZlcmVkIGJyZWFrZG93blxuICB8IHsgdHlwZTogXCJlbGVtZW50LmFkZFwiOyBlbGVtZW50OiBOZXdFbGVtZW50IH0gLy8gYWdlbnQgYm94ZXMgYSByZWdpb24gaW5jcmVtZW50YWxseVxuICB8IHsgdHlwZTogXCJlbGVtZW50LnVwZGF0ZVwiOyBpZDogc3RyaW5nOyBwYXRjaDogUGFydGlhbDxFbGVtZW50PiB9IC8vIG1vdmUvcmVzaXplL3JlbmFtZS9yZXR5cGUgKHZlcnNpb25zIGFwcGVuZCB2aWEgZWxlbWVudC5hZGRWZXJzaW9uKVxuICB8IHsgdHlwZTogXCJlbGVtZW50LnJlbW92ZVwiOyBpZDogc3RyaW5nIH0gLy8gYWdlbnQgcmV0cmFjdHMgYSBib3hcbiAgfCB7IHR5cGU6IFwiZWxlbWVudC5hZGRWZXJzaW9uXCI7IGlkOiBzdHJpbmc7IHZlcnNpb246IEVsZW1lbnRWZXJzaW9uOyBjaG9vc2U/OiBib29sZWFuIH0gLy8gYWdlbnQgYXBwZW5kcyBhIHByb2R1Y2VkIHZlcnNpb25cbiAgfCB7IHR5cGU6IFwicGhhc2Uuc2V0XCI7IHBoYXNlOiBQaGFzZUtleSB9IC8vIGFnZW50IGFkdmFuY2VzL21vdmVzIHRoZSBjdXJzb3Igb24gdGhlIHVzZXIncyBjb252ZXJzYXRpb25hbCByZXF1ZXN0XG4gIHwgeyB0eXBlOiBcImJ1bmRsZS5zZXRcIjsgbmFtZTogc3RyaW5nOyBjb3VudDogbnVtYmVyIH0gLy8gYWdlbnQgcG9zdHMgdGhlIGJ1aWx0IGV4cG9ydCBidW5kbGUgKHNlcnZlZCB2aWEgL2Fzc2V0cy88bmFtZT4pXG4gIHwgeyB0eXBlOiBcInN0YXR1c1wiOyBidXN5OiBib29sZWFuOyB0ZXh0Pzogc3RyaW5nIH1cbiAgfCB7IHR5cGU6IFwiY2xvc2VcIiB9O1xuXG4vLyBUaGUgYWdlbnQgZXZlbnQgc2V0IChzZXJ2ZXIg4oaSIGFnZW50IFNTRSkg4oCUIElNUEVSQVRJVkVTIE9OTFk6IHRoZSBtb3ZlcyB3aGVyZVxuLy8gdGhlIHVzZXIgKmhhbmRzIHdvcmsgdG8gdGhlIGFnZW50KiwgcGx1cyBsaWZlY3ljbGUuIEFtYmllbnQgZWRpdGluZyBvZiB0aGVcbi8vIGJyZWFrZG93biBpcyBkZWxpYmVyYXRlbHkgTk9UIGhlcmUg4oCUIGJveCBtb3ZlL3Jlc2l6ZS9yZW5hbWUvcmV0eXBlXG4vLyAoZWxlbWVudC51cGRhdGUpLCBkcmF3IChlbGVtZW50LmFkZCksIGRlbGV0ZSAoZWxlbWVudC5yZW1vdmUpLCBjb25maXJtL2Ryb3Bcbi8vIChlbGVtZW50Lmp1ZGdlKSwgcmUtcnVuIGZsYWcgKGVsZW1lbnQuZmxhZyksIHZlcnNpb24gcGljayAodmVyc2lvbi5jaG9vc2UpLCBhbmRcbi8vIGJhY2tkcm9wIGFyZSBhbGwgcmVhY2hhYmxlIGZyb20gL3N0YXRlLCB3aGljaCB0aGUgYWdlbnQgcmVhZHMgYXQgdGhlIG1vbWVudCBhblxuLy8gaW1wZXJhdGl2ZSBmaXJlcy4gUHVzaGluZyBlYWNoIGVkaXQgd291bGQganVzdCBuYXJyYXRlIHRoZSB1c2VyJ3MgYnVzeSB3b3JrLlxuLy8gVGhlIGltcGVyYXRpdmVzOiBgc2F5YCwgYHNvdXJjZS5hZGRlZGAgKOKGkiBkaXNjb3ZlciksIGBleHRyYWN0YCAo4oaSIGN1dCB0aGVcbi8vIGN1cnJlbnQgYm94ZXMpLCBgcmVtb3ZlQmdgICjihpIgcmVtb3ZlIGJhY2tncm91bmRzLCBhZ2VudCBwaWNrcyB0aGUgbW9kZWwpLFxuLy8gYHJldHJ5UmVtb3ZhbGAgKOKGkiB0cnkgYSBkaWZmZXJlbnQgcmVtb3ZhbCwgYWdlbnQgcGlja3MgYW4gdW51c2VkIG1vZGVsKSxcbi8vIGBwaGFzZS5hZHZhbmNlYCAo4oaSIHVzZXIgc2VhbGVkIGEgcGhhc2U7IGEgaGFuZC1vZmYgdG8gdGhlIG5leHQgbGVnKSxcbi8vIGBwaGFzZS5zZXRgICjihpIgdXNlciBzdGVwcGVkIEJBQ0sgdG8gYSBwaGFzZSDigJQgbm90IGFuIGFjdGlvbiB0byB0YWtlLCBidXRcbi8vIGNvbnRleHQgZm9yIHdoYXQncyBjb21pbmcsIGUuZy4gcmUtY3V0cyksIGBzdWJtaXRgLCArIGxpZmVjeWNsZS4gQSBwaGFzZSBzd2l0Y2hcbi8vIGlzIGEgZGVsaWJlcmF0ZSByZWxvY2F0aW9uLCBOT1QgYW1iaWVudCBlZGl0aW5nIOKAlCBzbyBib3RoIGRpcmVjdGlvbnMgYXJlIHB1c2hlZC5cbmV4cG9ydCBjb25zdCBBR0VOVF9FVkVOVF9UWVBFUyA9IE9iamVjdC5mcmVlemUoW1xuICBcInJlYWR5XCIsXG4gIFwiY29ubmVjdGVkXCIsXG4gIFwiZGlzY29ubmVjdGVkXCIsXG4gIFwic2F5XCIsXG4gIFwic291cmNlLmFkZGVkXCIsIC8vIHVzZXIgZHJvcHBlZCBhIGNvbXBvc2l0ZSDigJQgdGhlIGFnZW50IHJ1bnMgZGlzY292ZXIgb24gaXRcbiAgXCJleHRyYWN0XCIsIC8vIHVzZXIgYXNrZWQgdG8gKHJlLSljdXQg4oCUIHRoZSBhZ2VudCByZWFkcyB0aGUgYm94ZXMgZnJvbSAvc3RhdGVcbiAgXCJyZW1vdmVCZ1wiLCAvLyB1c2VyIGFza2VkIHRvIHJlbW92ZSBiYWNrZ3JvdW5kcyDigJQgdGhlIGFnZW50IHBpY2tzIHRoZSBtb2RlbFxuICBcInJldHJ5UmVtb3ZhbFwiLCAvLyB1c2VyIGFza2VkIHRvIHRyeSBhIGRpZmZlcmVudCByZW1vdmFsIOKAlCB0aGUgYWdlbnQgcGlja3MgYW4gVU5VU0VEIG1vZGVsXG4gIFwicGhhc2UuYWR2YW5jZVwiLCAvLyB1c2VyIHNlYWxlZCB0aGUgYWN0aXZlIHBoYXNlIOKAlCBhIGhhbmQtb2ZmIHRvIHRoZSBuZXh0IGxlZyBvZiB3b3JrXG4gIFwicGhhc2Uuc2V0XCIsIC8vIHVzZXIgc3RlcHBlZCBCQUNLIHRvIGEgcGhhc2Ug4oCUIGNvbnRleHQgKHJlLWN1dHMgbGlrZWx5KSwgbm8gYWN0aW9uIHJlcXVpcmVkXG4gIFwiZXhwb3J0XCIsIC8vIHVzZXIgYXNrZWQgdG8gYnVpbGQgdGhlIGRvd25sb2FkYWJsZSBhc3NldCBidW5kbGUg4oCUIHRoZSBhZ2VudCB6aXBzIGl0XG4gIFwic3VibWl0XCIsXG4gIFwiY2xvc2VkXCIsXG5dIGFzIGNvbnN0KTtcbmV4cG9ydCB0eXBlIEFnZW50RXZlbnRUeXBlID0gKHR5cGVvZiBBR0VOVF9FVkVOVF9UWVBFUylbbnVtYmVyXTtcblxuLy8gVHlwZWQgcGF5bG9hZHMgZm9yIHRoZSBldmVudHMgdGhhdCBjYXJyeSBkYXRhLlxuZXhwb3J0IHR5cGUgQWdlbnRFdmVudFBheWxvYWQgPSB7XG4gIHNheTogeyB0ZXh0OiBzdHJpbmcgfTtcbiAgXCJzb3VyY2UuYWRkZWRcIjogeyBwYXRoOiBzdHJpbmc7IHNpemU6IFtudW1iZXIsIG51bWJlcl07IHNoYTogc3RyaW5nIH07XG4gIGV4dHJhY3Q6IHsgaWRzPzogc3RyaW5nW10gfTsgLy8gd2hpY2ggZWxlbWVudHMgdG8gKHJlLSljdXQ7IGFic2VudCDihpIgYWxsIGNvbmZpcm1lZFxuICByZW1vdmVCZzogeyBpZHM/OiBzdHJpbmdbXSB9OyAvLyB3aGljaCBlbGVtZW50cyB0byByZW1vdmUgYmcgZm9yOyBhYnNlbnQg4oaSIGFsbCBlbGlnaWJsZVxuICByZXRyeVJlbW92YWw6IHsgaWRzOiBzdHJpbmdbXSB9OyAvLyB3aGljaCAoZmxhZ2dlZCkgZWxlbWVudHMgdG8gcmUtcmVtb3ZlOyBtb2RlbCBpcyB0aGUgYWdlbnQncyBjYWxsXG4gIFwicGhhc2UuYWR2YW5jZVwiOiB7IHBoYXNlOiBQaGFzZUtleSB9OyAvLyB0aGUgTkVXIHBoYXNlIHRoZSB1c2VyIGFkdmFuY2VkIHRvXG4gIFwicGhhc2Uuc2V0XCI6IHsgcGhhc2U6IFBoYXNlS2V5IH07IC8vIHRoZSBwaGFzZSB0aGUgdXNlciBzdGVwcGVkIGJhY2sgdG9cbiAgZXhwb3J0OiB7IGlkcz86IHN0cmluZ1tdIH07IC8vIHdoaWNoIGVsZW1lbnRzIHRvIGJ1bmRsZSAoYWJzZW50IOKGkiBhbGwgbm9uLWRyb3BwZWQpXG59O1xuIiwKICAgICIvLyBzY3JpcHRzL3JlZHVjZS50c1xuLy8gUHVyZSwgaW4tcGxhY2UgbXV0YXRvcnMgb3ZlciBNYWdwaWVTdGF0ZSArIHRoZSBsZWFuIHByb2plY3Rpb24uIFRoZSBkYWVtb25cbi8vIChzZXJ2ZXIudHMpIG9yY2hlc3RyYXRlcyB0aGVzZSAoaXQgb3ducyBpZHMsIGJyb2FkY2FzdCwgU1NFKTsgdGhlc2UgZnVuY3Rpb25zXG4vLyBqdXN0IG11dGF0ZSBjYW5vbmljYWwgc3RhdGUgYW5kIHJlcG9ydCB3aGV0aGVyIGFueXRoaW5nIGNoYW5nZWQsIHNvIHRoZXkncmVcbi8vIHVuaXQtdGVzdGFibGUgd2l0aCBubyBzdWJwcm9jZXNzLiBLZWVwIHRoZW0gVEhJTiDigJQgdGhlIG1hZ3BpZS1zcGVjaWZpYyByZXZpZXdcbi8vIG1hY2hpbmVyeSAoanVkZ21lbnQsIGN1dG91dHMpIGlzIG1vY2tlZCBvdXQgZm9yIG5vdzsgd2lkZW4gdGhlc2UgYXMgaXQgbGFuZHMuXG5cbmltcG9ydCB7XG4gIHR5cGUgQmFja2Ryb3AsXG4gIHR5cGUgRWxlbWVudCxcbiAgdHlwZSBFbGVtZW50U3RhdHVzLFxuICB0eXBlIEVsZW1lbnRWZXJzaW9uLFxuICB0eXBlIE1hZ3BpZVN0YXRlLFxuICB0eXBlIE1lc3NhZ2UsXG4gIHR5cGUgTmV3RWxlbWVudCxcbiAgUEhBU0VTLFxuICB0eXBlIFBoYXNlS2V5LFxuICB0eXBlIFNvdXJjZSxcbn0gZnJvbSBcIi4uL3NoYXJlZC90eXBlc1wiO1xuXG4vLyDilIDilIAgaWQgaGVscGVycyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbmZ1bmN0aW9uIHJhbmRIZXgoYnl0ZXM6IG51bWJlcik6IHN0cmluZyB7XG4gIGNvbnN0IGJ1ZiA9IG5ldyBVaW50OEFycmF5KGJ5dGVzKTtcbiAgY3J5cHRvLmdldFJhbmRvbVZhbHVlcyhidWYpO1xuICByZXR1cm4gQXJyYXkuZnJvbShidWYsIChiKSA9PiBiLnRvU3RyaW5nKDE2KS5wYWRTdGFydCgyLCBcIjBcIikpLmpvaW4oXCJcIik7XG59XG5leHBvcnQgZnVuY3Rpb24gbmV3SWQocHJlZml4OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gYCR7cHJlZml4fS0ke3JhbmRIZXgoNCl9YDtcbn1cblxuLy8g4pSA4pSAIG11dGF0b3JzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5leHBvcnQgZnVuY3Rpb24gcHVzaE1lc3NhZ2UoXG4gIHM6IE1hZ3BpZVN0YXRlLFxuICBtOiBPbWl0PE1lc3NhZ2UsIFwiaWRcIiB8IFwidHNcIj4gJiB7IGlkPzogc3RyaW5nIH0sXG4pOiBNZXNzYWdlIHtcbiAgY29uc3QgbXNnOiBNZXNzYWdlID0geyBpZDogbS5pZCA/PyBuZXdJZChcIm1cIiksIHRzOiBEYXRlLm5vdygpLCAuLi5tIH0gYXMgTWVzc2FnZTtcbiAgcy5jb252ZXJzYXRpb24ucHVzaChtc2cpO1xuICByZXR1cm4gbXNnO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2V0U3RhdHVzKHM6IE1hZ3BpZVN0YXRlLCBidXN5OiBib29sZWFuLCB0ZXh0ID0gXCJcIik6IHZvaWQge1xuICBzLnN0YXR1cyA9IHsgYnVzeSwgdGV4dCB9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2V0SW50ZW50KHM6IE1hZ3BpZVN0YXRlLCBpbnRlbnQ6IHN0cmluZyk6IHZvaWQge1xuICBzLmludGVudCA9IGludGVudDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNldFNvdXJjZShzOiBNYWdwaWVTdGF0ZSwgc291cmNlOiBTb3VyY2UpOiB2b2lkIHtcbiAgcy5zb3VyY2UgPSBzb3VyY2U7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzZXRFbGVtZW50cyhzOiBNYWdwaWVTdGF0ZSwgZWxlbWVudHM6IEVsZW1lbnRbXSk6IHZvaWQge1xuICAvLyBUcnVzdCB0aGUgYWdlbnQncyBkaXNjb3ZlcmVkIGJyZWFrZG93biB3aG9sZXNhbGU7IGRlZmF1bHQgYW55IG1pc3NpbmdcbiAgLy8gc3RhdHVzIHRvIFwicHJvcG9zZWRcIiBzbyB0aGUgc3VyZmFjZSBhbHdheXMgaGFzIGEganVkZ2VhYmxlIGVsZW1lbnQsIGFuZFxuICAvLyAoZGVmZW5zaXZlbHkpIG1pbnQgYW4gaWQgZm9yIGFueSBlbGVtZW50IHBvc3RlZCB3aXRob3V0IG9uZSDigJQgZGlzY292ZXJcbiAgLy8gYXNzaWducyBpZHMsIGJ1dCBhIGhhbmQtcm9sbGVkIGBlbGVtZW50cy5zZXRgIGJvZHkgbWlnaHQgbm90LlxuICBzLmVsZW1lbnRzID0gZWxlbWVudHMubWFwKChlKSA9PiAoe1xuICAgIC4uLmUsXG4gICAgaWQ6IGUuaWQgfHwgbmV3SWQoXCJlXCIpLFxuICAgIHN0YXR1czogZS5zdGF0dXMgPz8gXCJwcm9wb3NlZFwiLFxuICB9KSk7XG59XG5cbi8vIERlZmF1bHQgbmFtZSBmb3IgYW4gdW5uYW1lZCBkcmF3biByZWdpb246IHJlZ2lvbl88bj4sIHdoZXJlIG4gaXMgb25lIHBhc3QgdGhlXG4vLyBjb3VudCBvZiBleGlzdGluZyByZWdpb25fXFxkKyBuYW1lcyAoc28gYSBkZWxldGUtdGhlbi1kcmF3IGRvZXNuJ3QgY29sbGlkZSB3aXRoXG4vLyBhIGxpdmUgb25lIOKAlCBpdCBudW1iZXJzIG9mZiB0aGUgY3VycmVudCBwb3B1bGF0aW9uLCB0aGUgY2hlYXAgaG91c2UgaGV1cmlzdGljKS5cbmNvbnN0IFJFR0lPTl9SRSA9IC9ecmVnaW9uX1xcZCskLztcbmZ1bmN0aW9uIG5leHRSZWdpb25OYW1lKHM6IE1hZ3BpZVN0YXRlKTogc3RyaW5nIHtcbiAgY29uc3QgbiA9IHMuZWxlbWVudHMuZmlsdGVyKChlKSA9PiBSRUdJT05fUkUudGVzdChlLm5hbWUpKS5sZW5ndGggKyAxO1xuICByZXR1cm4gYHJlZ2lvbl8ke259YDtcbn1cblxuLy8gQWRkIGEgdXNlci1kcmF3biAob3IgYWdlbnQtYm94ZWQpIHJlZ2lvbjogbWludCBhbiBpZCwgZGVmYXVsdCBuYW1lL3R5cGUvc3RhdHVzLlxuLy8gUmV0dXJucyB0aGUgbWF0ZXJpYWxpemVkIEVsZW1lbnQgKHRoZSBkYWVtb24gZW1pdHMgaXQgb24gdGhlIFNTRS9icm9hZGNhc3QpLlxuZXhwb3J0IGZ1bmN0aW9uIGFkZEVsZW1lbnQoczogTWFncGllU3RhdGUsIGRyYWZ0OiBOZXdFbGVtZW50KTogRWxlbWVudCB7XG4gIGNvbnN0IGVsOiBFbGVtZW50ID0ge1xuICAgIGlkOiBuZXdJZChcImVcIiksXG4gICAgbmFtZTogZHJhZnQubmFtZSB8fCBuZXh0UmVnaW9uTmFtZShzKSxcbiAgICB0eXBlOiBkcmFmdC50eXBlID8/IFwib3RoZXJcIixcbiAgICBiYm94OiBkcmFmdC5iYm94LFxuICAgIHN0YXR1czogZHJhZnQuc3RhdHVzID8/IFwiY29uZmlybWVkXCIsXG4gIH07XG4gIHMuZWxlbWVudHMucHVzaChlbCk7XG4gIHJldHVybiBlbDtcbn1cblxuLy8gSGFyZC1kZWxldGUgYW4gZWxlbWVudCBieSBpZCAoYSB1c2VyIHJldHJhY3RpbmcgYSBkcmF3biBib3gpLiBSZXR1cm5zIHdoZXRoZXJcbi8vIGl0IGV4aXN0ZWQuXG5leHBvcnQgZnVuY3Rpb24gcmVtb3ZlRWxlbWVudChzOiBNYWdwaWVTdGF0ZSwgaWQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBpID0gcy5lbGVtZW50cy5maW5kSW5kZXgoKGUpID0+IGUuaWQgPT09IGlkKTtcbiAgaWYgKGkgPCAwKSByZXR1cm4gZmFsc2U7XG4gIHMuZWxlbWVudHMuc3BsaWNlKGksIDEpO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuLy8gUGFydGlhbC1tZXJnZSBhbiBlbGVtZW50ICh0aGUgYWdlbnQgcG9zdGluZyBuYW1lL3R5cGUvYmJveC9zdGF0dXMgZWRpdHMgbGFuZHNcbi8vIGhlcmUpLiBOZXZlciBsZXRzIGBpZGAgYmUgb3ZlcndyaXR0ZW4uIFJldHVybnMgdHJ1ZSBpZiB0aGUgZWxlbWVudCBleGlzdGVkLlxuLy8gVmVyc2lvbiByZXN1bHRzIGRvIE5PVCBmbG93IHRocm91Z2ggaGVyZSDigJQgdGhleSBhcHBlbmQgdmlhIGFkZFZlcnNpb24gKGEgbGlzdFxuLy8gb3AsIG5vdCBhIGZpZWxkIG1lcmdlKS5cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVFbGVtZW50KHM6IE1hZ3BpZVN0YXRlLCBpZDogc3RyaW5nLCBwYXRjaDogUGFydGlhbDxFbGVtZW50Pik6IGJvb2xlYW4ge1xuICBjb25zdCBlbCA9IHMuZWxlbWVudHMuZmluZCgoZSkgPT4gZS5pZCA9PT0gaWQpO1xuICBpZiAoIWVsKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IHsgaWQ6IF9kcm9wLCAuLi5yZXN0IH0gPSBwYXRjaDtcbiAgT2JqZWN0LmFzc2lnbihlbCwgcmVzdCk7XG4gIHJldHVybiB0cnVlO1xufVxuXG5jb25zdCBFTEVNRU5UX1NUQVRVU0VTOiByZWFkb25seSBFbGVtZW50U3RhdHVzW10gPSBbXCJwcm9wb3NlZFwiLCBcImNvbmZpcm1lZFwiLCBcImRyb3BwZWRcIl07XG5cbmV4cG9ydCBmdW5jdGlvbiBqdWRnZUVsZW1lbnQoczogTWFncGllU3RhdGUsIGlkOiBzdHJpbmcsIHN0YXR1czogRWxlbWVudFN0YXR1cyk6IGJvb2xlYW4ge1xuICBpZiAoIUVMRU1FTlRfU1RBVFVTRVMuaW5jbHVkZXMoc3RhdHVzKSkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBlbCA9IHMuZWxlbWVudHMuZmluZCgoZSkgPT4gZS5pZCA9PT0gaWQpO1xuICBpZiAoIWVsIHx8IGVsLnN0YXR1cyA9PT0gc3RhdHVzKSByZXR1cm4gZmFsc2U7XG4gIGVsLnN0YXR1cyA9IHN0YXR1cztcbiAgcmV0dXJuIHRydWU7XG59XG5cbi8vIEZsYWcgKG9yIHVuZmxhZykgYW4gZWxlbWVudCBmb3IgYSByZS1ydW4g4oCUIHRoZSBzb2xlIHJldmlldyBzaWduYWwuIEFwcHJvdmFsIGlzXG4vLyB0aGUgYWJzZW5jZSBvZiBhIGZsYWc7IGRpc2NhcmRpbmcgaXMgc3RhdHVzOlwiZHJvcHBlZFwiLiBSZXR1cm5zIHdoZXRoZXIgdGhlIGZsYWdcbi8vIGFjdHVhbGx5IGNoYW5nZWQgKHRoZSBkYWVtb24gb25seSBicm9hZGNhc3RzIG9uIGEgY2hhbmdlKS5cbmV4cG9ydCBmdW5jdGlvbiBmbGFnRWxlbWVudChzOiBNYWdwaWVTdGF0ZSwgaWQ6IHN0cmluZywgZmxhZ2dlZDogYm9vbGVhbik6IGJvb2xlYW4ge1xuICBjb25zdCBlbCA9IHMuZWxlbWVudHMuZmluZCgoZSkgPT4gZS5pZCA9PT0gaWQpO1xuICBpZiAoIWVsKSByZXR1cm4gZmFsc2U7XG4gIGlmICgoZWwuZmxhZ2dlZCA/PyBmYWxzZSkgPT09IGZsYWdnZWQpIHJldHVybiBmYWxzZTtcbiAgZWwuZmxhZ2dlZCA9IGZsYWdnZWQ7XG4gIHJldHVybiB0cnVlO1xufVxuXG4vLyBBcHBlbmQgYSBwcm9kdWNlZCB2ZXJzaW9uLCBVUFNFUlRJTkcgYnkgbW9kZWw6IHJlLXJ1bm5pbmcgdGhlIHNhbWUgbW9kZWxcbi8vIG92ZXJ3cml0ZXMgaXRzIHBhdGggKyBidW1wcyByZXYgKGNhY2hlLWJ1c3QpIGFuZCBrZWVwcyB0aGUgc3RhYmxlIGlkOyBhIG5ld1xuLy8gbW9kZWwgYXBwZW5kcyBhIHJvdy4gQSBmcmVzaCByZXN1bHQgY2xlYXJzIGBmbGFnZ2VkYCAodGhlIHJlcXVlc3QgaXMgZnVsZmlsbGVkKVxuLy8gYW5kIOKAlCB1bmxlc3MgeyBjaG9vc2U6ZmFsc2UgfSDigJQgYmVjb21lcyB0aGUgY2hvc2VuIHZlcnNpb24uIFJldHVybnMgdGhlIHN0b3JlZFxuLy8gdmVyc2lvbiwgb3IgbnVsbCBpZiB0aGUgZWxlbWVudCBpcyBnb25lLlxuZXhwb3J0IGZ1bmN0aW9uIGFkZFZlcnNpb24oXG4gIHM6IE1hZ3BpZVN0YXRlLFxuICBpZDogc3RyaW5nLFxuICB2OiBFbGVtZW50VmVyc2lvbixcbiAgb3B0czogeyBjaG9vc2U/OiBib29sZWFuIH0gPSB7fSxcbik6IEVsZW1lbnRWZXJzaW9uIHwgbnVsbCB7XG4gIGNvbnN0IGVsID0gcy5lbGVtZW50cy5maW5kKChlKSA9PiBlLmlkID09PSBpZCk7XG4gIGlmICghZWwpIHJldHVybiBudWxsO1xuICBpZiAoIWVsLnZlcnNpb25zKSBlbC52ZXJzaW9ucyA9IFtdO1xuICBjb25zdCBleGlzdGluZyA9IGVsLnZlcnNpb25zLmZpbmQoKHgpID0+IHgubW9kZWwgPT09IHYubW9kZWwpO1xuICBsZXQgc3RvcmVkOiBFbGVtZW50VmVyc2lvbjtcbiAgaWYgKGV4aXN0aW5nKSB7XG4gICAgZXhpc3RpbmcucGF0aCA9IHYucGF0aDtcbiAgICBleGlzdGluZy5yZXYgPSAoZXhpc3RpbmcucmV2ID8/IDApICsgMTtcbiAgICBpZiAodi5raW5kICE9PSB1bmRlZmluZWQpIGV4aXN0aW5nLmtpbmQgPSB2LmtpbmQ7XG4gICAgaWYgKHYubm90ZSAhPT0gdW5kZWZpbmVkKSBleGlzdGluZy5ub3RlID0gdi5ub3RlO1xuICAgIHN0b3JlZCA9IGV4aXN0aW5nO1xuICB9IGVsc2Uge1xuICAgIHN0b3JlZCA9IHsgLi4udiwgcmV2OiB2LnJldiA/PyAwIH07XG4gICAgZWwudmVyc2lvbnMucHVzaChzdG9yZWQpO1xuICB9XG4gIGlmIChvcHRzLmNob29zZSA/PyB0cnVlKSBlbC5jaG9zZW5WZXJzaW9uSWQgPSBzdG9yZWQuaWQ7XG4gIGVsLmZsYWdnZWQgPSBmYWxzZTtcbiAgcmV0dXJuIHN0b3JlZDtcbn1cblxuLy8gVGhlIHVzZXIgc2VsZWN0aW5nIGEgdmVyc2lvbiDihpIgaXQgYmVjb21lcyBjaG9zZW4gKGFtYmllbnQpLiBSZXR1cm5zIHdoZXRoZXIgaXRcbi8vIGNoYW5nZWQ7IHJlamVjdHMgYW4gdW5rbm93biBlbGVtZW50IG9yIGEgdmVyc2lvbklkIG5vdCBwcmVzZW50IG9uIGl0LlxuZXhwb3J0IGZ1bmN0aW9uIGNob29zZVZlcnNpb24oczogTWFncGllU3RhdGUsIGlkOiBzdHJpbmcsIHZlcnNpb25JZDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IGVsID0gcy5lbGVtZW50cy5maW5kKChlKSA9PiBlLmlkID09PSBpZCk7XG4gIGlmICghZWwgfHwgIShlbC52ZXJzaW9ucyA/PyBbXSkuc29tZSgodikgPT4gdi5pZCA9PT0gdmVyc2lvbklkKSkgcmV0dXJuIGZhbHNlO1xuICBpZiAoZWwuY2hvc2VuVmVyc2lvbklkID09PSB2ZXJzaW9uSWQpIHJldHVybiBmYWxzZTtcbiAgZWwuY2hvc2VuVmVyc2lvbklkID0gdmVyc2lvbklkO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuY29uc3QgQkFDS0RST1BTOiByZWFkb25seSBCYWNrZHJvcFtdID0gW1wid2hpdGVcIiwgXCJncmF5XCIsIFwiYmxhY2tcIiwgXCJ0cmFuc3BhcmVudFwiXTtcblxuZXhwb3J0IGZ1bmN0aW9uIHNldEJhY2tkcm9wKHM6IE1hZ3BpZVN0YXRlLCBiYWNrZHJvcDogQmFja2Ryb3ApOiBib29sZWFuIHtcbiAgaWYgKCFCQUNLRFJPUFMuaW5jbHVkZXMoYmFja2Ryb3ApIHx8IHMuYmFja2Ryb3AgPT09IGJhY2tkcm9wKSByZXR1cm4gZmFsc2U7XG4gIHMuYmFja2Ryb3AgPSBiYWNrZHJvcDtcbiAgcmV0dXJuIHRydWU7XG59XG5cbi8vIOKUgOKUgCBwaGFzZSBzcGluZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuLy8gQWR2YW5jZSB0aGUgbGluZWFyIHBoYXNlIGN1cnNvciB0byB0aGUgbmV4dCBwaGFzZSDigJQgd2hhdCB0aGUgc2VhbC1hbmQtaGFuZC1vZmZcbi8vIGdhdGUgZmlyZXMuIFJldHVybnMgdGhlIG5ldyBwaGFzZSwgb3IgbnVsbCBpZiBhbHJlYWR5IGF0IHRoZSBsYXN0IChuby1vcCkuXG5leHBvcnQgZnVuY3Rpb24gYWR2YW5jZVBoYXNlKHM6IE1hZ3BpZVN0YXRlKTogUGhhc2VLZXkgfCBudWxsIHtcbiAgY29uc3QgaSA9IFBIQVNFUy5pbmRleE9mKHMucGhhc2UpO1xuICBpZiAoaSA8IDAgfHwgaSA+PSBQSEFTRVMubGVuZ3RoIC0gMSkgcmV0dXJuIG51bGw7XG4gIHMucGhhc2UgPSBQSEFTRVNbaSArIDFdO1xuICByZXR1cm4gcy5waGFzZTtcbn1cblxuLy8gU2V0IHRoZSBwaGFzZSBjdXJzb3IgZGlyZWN0bHkgKGJhY2stbmF2IC8ganVtcCkuIFZhbGlkYXRlcyBhZ2FpbnN0IFBIQVNFUztcbi8vIHJlcG9ydHMgd2hldGhlciBpdCBjaGFuZ2VkLlxuZXhwb3J0IGZ1bmN0aW9uIHNldFBoYXNlKHM6IE1hZ3BpZVN0YXRlLCBwaGFzZTogUGhhc2VLZXkpOiBib29sZWFuIHtcbiAgaWYgKCFQSEFTRVMuaW5jbHVkZXMocGhhc2UpIHx8IHMucGhhc2UgPT09IHBoYXNlKSByZXR1cm4gZmFsc2U7XG4gIHMucGhhc2UgPSBwaGFzZTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbi8vIFJlY29yZCB0aGUgYnVpbHQgZXhwb3J0IGJ1bmRsZSAodGhlIGFnZW50IHBvc3RzIGl0IGFmdGVyIHppcHBpbmcpLiBUaGUgc3VyZmFjZVxuLy8gb2ZmZXJzIGl0IGFzIGEgZG93bmxvYWQgdmlhIC9hc3NldHMvPG5hbWU+LlxuZXhwb3J0IGZ1bmN0aW9uIHNldEJ1bmRsZShzOiBNYWdwaWVTdGF0ZSwgbmFtZTogc3RyaW5nLCBjb3VudDogbnVtYmVyKTogdm9pZCB7XG4gIHMuYnVuZGxlID0geyBuYW1lLCBjb3VudCB9O1xufVxuXG4vLyDilIDilIAgbGVhbiBwcm9qZWN0aW9uIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy8gU3RyaXAgYW55IChldmVudHVhbGx5IGhlYXZ5KSBpbmxpbmVkIGJsb2JzIGZyb20gdGhlIGFnZW50LWZhY2luZyAvc3RhdGUgc28gdGhlXG4vLyBzbmFwc2hvdCBzdGF5cyBzbWFsbDsgdGhlIGFnZW50IHJlYWRzIG9uLWRpc2sgdmVyc2lvbiBwYXRocyBpbnN0ZWFkLiBWZXJzaW9uc1xuLy8gY2Fycnkgb25seSBgcGF0aGAgKG5vdCBpbmxpbmVkIGltYWdlIGRhdGEpLCBzbyB0aGlzIGlzIG5lYXItaWRlbnRpdHkg4oCUIGJ1dCBpdFxuLy8gZGVmZW5zaXZlbHkgZHJvcHMgYW55IGBzcmNgL2BjdXRvdXRzYCBmaWVsZHMgYW4gZWxlbWVudCBtaWdodCBpbmxpbmUsIGFuZCBuZXZlclxuLy8gbXV0YXRlcyB0aGUgc291cmNlIHN0YXRlLlxuZXhwb3J0IGZ1bmN0aW9uIGxlYW5TdGF0ZShzOiBNYWdwaWVTdGF0ZSk6IE1hZ3BpZVN0YXRlIHtcbiAgcmV0dXJuIHtcbiAgICAuLi5zLFxuICAgIGVsZW1lbnRzOiBzLmVsZW1lbnRzLm1hcCgoZSkgPT4ge1xuICAgICAgY29uc3QgbGVhbiA9IHsgLi4uZSB9IGFzIEVsZW1lbnQgJiB7IHNyYz86IHVua25vd247IGN1dG91dHM/OiB1bmtub3duIH07XG4gICAgICBkZWxldGUgbGVhbi5zcmM7XG4gICAgICBkZWxldGUgbGVhbi5jdXRvdXRzO1xuICAgICAgcmV0dXJuIGxlYW47XG4gICAgfSksXG4gIH07XG59XG4iLAogICAgIi8vIHNoYXJlZC92ZXJzaW9ucy50c1xuLy8gUHVyZSB2ZXJzaW9uIGhlbHBlcnMgc2hhcmVkIGJ5IHRoZSBiYWNrZW5kIENMSSAoc3JjL21hZ3BpZS9iYWNrZW5kL2NsaS50cyxcbi8vIHdoaWNoIHJlYWRzIGNob3NlblZlcnNpb24gZm9yIGV4cG9ydCkgQU5EIHRoZSBSZWFjdCBjbGllbnQgKE1hZ3BpZVNoZWxsLFxuLy8gRXhwb3J0VmlldywgUmVtb3ZlR2FsbGVyeSkuIHNlcnZlci50cyBkb2VzIE5PVCBpbXBvcnQgdGhlbSDigJQgdGhlIGRhZW1vbi1zaWRlXG4vLyBjb25zdW1lciBpcyB0aGUgQ0xJLCBhbmQgdGhhdCBpcyB3aGF0IG1ha2VzIHRoaXMgdHdvLXNpZGVkLiBObyBub2RlOiog4oCUIGtlZXBcbi8vIGJyb3dzZXItc2FmZS4gQW4gZWxlbWVudCdzIHByb2R1Y2VkIGFzc2V0cyBhcmUgYSBtb2RlbC10YWdnZWQgbGlzdCAodmVyc2lvbnNbXSk7XG4vLyB0aGVzZSByZXNvbHZlIFwid2hpY2ggb25lIGlzIHNob3duXCIgYW5kIFwiaXRzIGNhY2hlLWJ1c3RlZCBVUkxcIi5cblxuaW1wb3J0IHR5cGUgeyBFbGVtZW50LCBFbGVtZW50VmVyc2lvbiB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbi8vIFRoZSB2ZXJzaW9uIHRoZSBzdXJmYWNlIHJlbmRlcnM6IHRoZSBleHBsaWNpdGx5IGNob3NlbiBvbmUsIGVsc2UgdGhlIGZpcnN0XG4vLyAodGhlIGNyb3ApLiBUb2xlcmF0ZXMgYW4gYWJzZW50L2VtcHR5IGxpc3QgYW5kIGEgc3RhbGUgY2hvc2VuVmVyc2lvbklkLlxuZXhwb3J0IGZ1bmN0aW9uIGNob3NlblZlcnNpb24oZWw6IEVsZW1lbnQpOiBFbGVtZW50VmVyc2lvbiB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IHZzID0gZWwudmVyc2lvbnMgPz8gW107XG4gIHJldHVybiB2cy5maW5kKCh2KSA9PiB2LmlkID09PSBlbC5jaG9zZW5WZXJzaW9uSWQpID8/IHZzWzBdO1xufVxuXG4vLyBUaGUgL2Fzc2V0cyBVUkwgZm9yIGEgdmVyc2lvbiwgY2FjaGUtYnVzdGVkIGJ5IGl0cyByZXYuIEEgcmUtcnVuIG92ZXJ3cml0ZXMgdGhlXG4vLyBmaWxlIGluIHBsYWNlLCBzbyB3aXRob3V0ID92PTxyZXY+IHRoZSBicm93c2VyIHNob3dzIHRoZSBzdGFsZSBjYWNoZWQgaW1hZ2UuXG5leHBvcnQgZnVuY3Rpb24gdmVyc2lvblVybCh2OiBFbGVtZW50VmVyc2lvbik6IHN0cmluZyB7XG4gIHJldHVybiBgL2Fzc2V0cy8ke3YucGF0aC5zcGxpdChcIi9cIikucG9wKCl9P3Y9JHt2LnJldiA/PyAwfWA7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3Mgb25lLWxpbmUgSlNPTiBlbWl0dGVyIOKAlCBPTkUgaW1wbGVtZW50YXRpb24sIGltcG9ydGVkIGJ5IGV2ZXJ5XG4gKiBzcGVsbCB0aGF0IHNwZWFrcyB0aGUgYWdlbnQgd2lyZS5cbiAqXG4gKiDim5QgVEhJUyBGSUxFIElTIGBzcmMva2l0L2AncyBGSVJTVCBJTkhBQklUQU5ULCBhbmQgdGhhdCBpcyBsb2FkLWJlYXJpbmcgYmV5b25kXG4gKiB0aGUgc2hhcmluZyBpdCBkb2VzLiBXYXJkIDIgKFwidGhlIGtpdCBpcyBhIGxlYWZcIikgaGFzIGJlZW4gZ3JlZW4gYnlcbiAqIENPTlNUUlVDVElPTiBzaW5jZSBQaGFzZSAwIOKAlCBpdCBoYWQgbm90aGluZyB0byB3YWxrLCBhbmQgc2FpZCBzbyBvbiBldmVyeVxuICogcnVuLiBUaGlzIG1vZHVsZSBpcyB0aGUgZmlyc3QgdGhpbmcgaXQgYWN0dWFsbHkgZ3VhcmRzLCB3aGljaCBpcyB3aHkgdGhlXG4gKiB3YXJkJ3MgemVyby1ndWFyZCBjZWxsIGRpc3Rpbmd1aXNoZXMgYW4gQUJTRU5UIGtpdCBmcm9tIGFuIEVNUFRZIG9uZS5cbiAqXG4gKiDim5QgVEhFIEtJVCBJUyBBIExFQUYuIE5vdGhpbmcgaGVyZSBtYXkgaW1wb3J0IG91dCBvZiBgc3JjL2tpdC9gIOKAlCBub3QgYSBzcGVsbCxcbiAqIG5vdCBhIHN1cmZhY2UsIG5vdCBhIGJhY2tlbmQuIFRoYXQgaXMgd2FyZCAyJ3MgYXNzZXJ0aW9uLCBub3QgYSBjb252ZW50aW9uLFxuICogYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhlIGtpdCBzYWZlIHRvIGJ1bmRsZSBpbnRvIGFueSBzcGVsbCdzIGFydGlmYWN0LlxuICpcbiAqIERlbGliZXJhdGVseSBkZXBlbmRlbmN5LWZyZWUgYW5kIGRlbGliZXJhdGVseSBkdWxsOiBpdCBpcyBidW5kbGVkIElOVE8gZWFjaFxuICogc3BlbGwncyBlbWl0dGVkIENMSSAoQ29udHJhY3QgNCdzIGJ1aWx0LWJhY2tlbmQgYW1lbmRtZW50KSwgc28gYW55dGhpbmcgaXRcbiAqIHJlYWNoZWQgZm9yIHdvdWxkIGJlY29tZSBhIGRlcGVuZGVuY3kgb2YgdHdvIHNoaXBwZWQgYXJ0aWZhY3RzIGF0IG9uY2UuXG4gKlxuICogVGhlIHdpcmUgY29udHJhY3QgaXQgZW5jb2RlczogZXhhY3RseSBvbmUgSlNPTiBkb2N1bWVudCwgb25lIHRyYWlsaW5nXG4gKiBuZXdsaW5lLCBub3RoaW5nIGVsc2Ugb24gc3Rkb3V0LiBBIGNhbGxlciByZWFkaW5nIG91ciBzdGRvdXQgd2l0aCBhXG4gKiBsaW5lLWRlbGltaXRlZCBwYXJzZXIgZGVwZW5kcyBvbiB0aGF0IG5ld2xpbmU7IGEgY2FsbGVyIHJlYWRpbmcgdG8gRU9GXG4gKiBkZXBlbmRzIG9uIHRoZXJlIGJlaW5nIG5vIHNlY29uZCBkb2N1bWVudC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByaW50SnNvbihkYXRhOiB1bmtub3duKTogdm9pZCB7XG4gIHByb2Nlc3Muc3Rkb3V0LndyaXRlKGAke0pTT04uc3RyaW5naWZ5KGRhdGEpfVxcbmApO1xufVxuIiwKICAgICIvKipcbiAqIFRoZSBob3VzZSdzIE9ORSBDTEkgZmFpbHVyZSBjb250cmFjdCDigJQgdGhlIHRheG9ub215LCB0aGUgZXhpdCBjb2RlcywgdGhlXG4gKiBlbnZlbG9wZSwgYW5kIHRoZSBgZGllYCB0aGF0IHJhaXNlcyBvbmUuXG4gKlxuICog4puUIFRIRSBLSVQgSVMgQSBMRUFGLiBOb3RoaW5nIGhlcmUgbWF5IGltcG9ydCBvdXQgb2YgYHNyYy9raXQvYCDigJQgd2FyZCAyJ3NcbiAqIGFzc2VydGlvbiwgbm90IGEgY29udmVudGlvbiwgYW5kIGl0IGlzIHdoYXQgbWFrZXMgdGhpcyBtb2R1bGUgc2FmZSB0byBidW5kbGVcbiAqIGludG8gYW55IHNwZWxsJ3MgYnVuZGxlIChzZWUgYC4uL2xpYi9wcmludEpzb24udHNgLCB0aGUga2l0J3MgZmlyc3RcbiAqIGluaGFiaXRhbnQsIGZvciB0aGUgZnVsbCBhY2NvdW50KS5cbiAqXG4gKiDilIDilIAgV0hZIFRISVMgSVMgQSBDT05UUkFDVCBBTkQgTk9UIEEgVVRJTElUWSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAqXG4gKiBga2luZGAgaXMgdGhlIGNvbnRyYWN0OyBgbWVzc2FnZWAgaXMgcHJlc2VudGF0aW9uLiBSZXdvcmRpbmcgYSBtZXNzYWdlIG11c3RcbiAqIG5ldmVyIGJyZWFrIGEgY2FsbGVyLCB3aGljaCBpdCBkb2VzIHRoZSBtb21lbnQgYW55b25lIG1hdGNoZXMgb24gcHJvc2UuIEFuXG4gKiBhZ2VudCByb3V0ZXMgb24gYGtpbmRgIGFuZCBvbiB0aGUgZXhpdCBjb2RlLCBzbyBjaGFuZ2luZyBlaXRoZXIgaXMgYSBjaGFuZ2VcbiAqIGFuIGFnZW50IE9CU0VSVkVTIGFuZCB0aGUgc3BlbGwgbmVlZHMgYW4gYWNjIHJlLWdyYWRlLiBUaGF0IGlzIHRoZSBjdXQgdGhpc1xuICogZGlyZWN0b3J5IGlzIG5hbWVkIGZvci5cbiAqXG4gKiDilIDilIAg4puUIGBkaWVgIFRIUk9XUy4gSVQgRE9FUyBOT1QgRVhJVCwgQU5EIFRIQVQgSVMgVEhFIFBPSU5UIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEJ1bidzIHN0ZG91dCBpcyBBU1lOQ0hST05PVVMgb24gYSBwaXBlIChzeW5jaHJvbm91cyBvbiBhIFRUWSBvciBmaWxlKSwgc29cbiAqIGBwcm9jZXNzLmV4aXQoKWAgZGlzY2FyZHMgd2hhdGV2ZXIgaGFzIG5vdCBkcmFpbmVkIOKAlCBtZWFzdXJlZCBhdCBleGFjdGx5XG4gKiA2NSw1MzYgYnl0ZXMsIGFuZCB0aGUgY2FsbGVyIGdldHMgd2VsbC1mb3JtZWQtbG9va2luZyBKU09OIHRoYXQgc3RvcHNcbiAqIG1pZC1zdHJpbmcuIFJlcHJvZHVjZWQsIHJlcGFpcmVkIGFuZCBnYXRlZCBpbiBib3VudHkgZmlyc3QgKFAwLCAjNzcvIzc4KS5cbiAqXG4gKiBUaGUgb2xkIHNoYXBlIHdyb3RlIG9uZSBzaG9ydCBlbnZlbG9wZSB0byBzdGRlcnIgYW5kIGV4aXRlZCBpbW1lZGlhdGVseSxcbiAqIHdoaWNoIGlzIHNhZmUgT05MWSB3aGlsZSB0aGUgcGF5bG9hZCBmaXRzIHRoZSA2NCBLaUIgcGlwZSBidWZmZXIg4oCUIHN0ZGVyclxuICogaXMgY3V0IHNob3J0IGV4YWN0bHkgbGlrZSBzdGRvdXQgKG1lYXN1cmVkKS4gSXQgYWxzbyBtZWFudCBldmVyeSBgZGllYCB3YXMgYVxuICogc2Vjb25kIHBsYWNlIHRoZSBwcm9jZXNzIGNvdWxkIGVuZCwgb3BhcXVlIHRvIHdoYXRldmVyIHRoZSB2ZXJiIGhhZFxuICogYWxyZWFkeSB3cml0dGVuIHRvIHN0ZG91dC5cbiAqXG4gKiBTbzogYGRpZWAgcmFpc2VzIGEgYENsaUVycm9yYCwgdGhlIHNwZWxsJ3MgYG1haW5gIGNhdGNoZXMgaXQgd2l0aFxuICogYHJlcG9ydENsaUVycm9yYCwgYW5kIHRoZSBwcm9jZXNzIGVuZHMgdGhlIG9uZSB3YXkgdGhlIGhvdXNlIHNhbmN0aW9ucyDigJRcbiAqIGBwcm9jZXNzLmV4aXRDb2RlYCBwbHVzIGEgbmF0dXJhbCByZXR1cm4uIGdsYW1vdXIgYW5kIG1pbmQtbWFwcGVyIHJlYWNoZWRcbiAqIHRoaXMgc2hhcGUgaW5kZXBlbmRlbnRseSBhdCB0aGVpciBhY2MgTDAgcGFzc2VzOyB0aGlzIG1vZHVsZSBpcyB3aGVyZSB0aGVcbiAqIHRocmVlIGNvcGllcyBzdG9wIGJlaW5nIHRocmVlLlxuICpcbiAqIOKaoCBBIGBkaWVgIFJFQUNIQUJMRSBmcm9tIGluc2lkZSBhIGB0cnlgIHdob3NlIGBjYXRjaGAgU1dBTExPV1MgaXMgbm93IGFcbiAqIHNpbGVudCBjb250aW51ZSByYXRoZXIgdGhhbiBhbiBleGl0LiDim5QgUkVBQ0hBQklMSVRZLCBOT1QgQ0FMTCBTSVRFUzogYVxuICogSEVMUEVSIHRoYXQgZGllcywgaW52b2tlZCBmcm9tIGluc2lkZSBhIHN3YWxsb3dpbmcgYGNhdGNoYCwgaGFzIGl0cyBgZGllYCBhdFxuICogYSBzaXRlIHRoYXQgcmVhZHMgYXMgcGVyZmVjdGx5IHNhZmUuIEFuIGFkb3B0aW5nIHNwZWxsIG11c3QgZm9sbG93IHRoZSBjYWxsXG4gKiBncmFwaCwgbm90IGdyZXAgZm9yIGBkaWUoYC4gQXVkaXRlZCB0aGF0IHdheSBvbiBhZG9wdGlvbiDigJQgMTUgc2l0ZXMgaW5cbiAqIGFzdHJvbGFiZSwgMjkgaW4gbWFncGllLCBwbHVzIHRoZSBoZWxwZXJzIHJlYWNoYWJsZSBmcm9tIHRoZW0g4oCUIGFuZCBldmVyeVxuICogcGF0aCBpcyBlaXRoZXIgb3V0c2lkZSBhIGB0cnlgIG9yIGluc2lkZSBhIGBjYXRjaGAsIGZyb20gd2hpY2ggdGhlIHRocm93XG4gKiBwcm9wYWdhdGVzLlxuICovXG5cbi8qKlxuICogVGhlIGZhaWx1cmUgdGF4b25vbXkuIEV4aXQgY29kZXMgZm9sbG93IHRoZSBhY2Mgc3RhbmRhcmQ6IGEgdXNhZ2UgZXJyb3IgaXNcbiAqIHRoZSBjYWxsZXIncyB0byBmaXggYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmQsIGFuIGludGVybmFsIGZhdWx0IGlzIG5vdCwgYW5kXG4gKiBjb2xsYXBzaW5nIHRoZW0gaW50byBvbmUgbnVtYmVyIGxlYXZlcyBhbiBhZ2VudCB3aXRoIG5vdGhpbmcgdG8gcm91dGUgb24uXG4gKi9cbmV4cG9ydCB0eXBlIEVycktpbmQgPSBcInVzYWdlXCIgfCBcImludGVybmFsXCIgfCBcIm5vdF9mb3VuZFwiIHwgXCJjb25mbGljdFwiO1xuXG5leHBvcnQgY29uc3QgRVhJVF9GT1I6IFJlY29yZDxFcnJLaW5kLCBudW1iZXI+ID0ge1xuICB1c2FnZTogMiwgLy8gdGhlIGNhbGxlciBjYW4gZml4IHRoaXMgYnkgY2hhbmdpbmcgdGhlIGNvbW1hbmRcbiAgaW50ZXJuYWw6IDEsIC8vIHRoZSBzcGVsbCBicm9rZTsgdGhlIGludm9jYXRpb24gbWF5IGhhdmUgYmVlbiBmaW5lXG4gIG5vdF9mb3VuZDogNSwgLy8gdGhlIG5hbWVkIHRoaW5nIGRvZXMgbm90IGV4aXN0XG4gIGNvbmZsaWN0OiA2LCAvLyBhIHByZWNvbmRpdGlvbiBmYWlsZWRcbn07XG5cbi8qKiBFeHRyYSBmaWVsZHMgYSBmYWlsdXJlIG1heSBjYXJyeS4gYGhpbnRgIGlzIHByb3NlIGZvciBhIGh1bWFuIG9yIGFuIGFnZW50O1xuICogIGBjaG9pY2VzYCBlbnVtZXJhdGVzIHdoYXQgV09VTEQgaGF2ZSBiZWVuIGFjY2VwdGVkLiAqL1xuZXhwb3J0IHR5cGUgRXJyRXh0cmEgPSB7IGhpbnQ/OiBzdHJpbmc7IGNob2ljZXM/OiBzdHJpbmdbXSB9O1xuXG4vKiogVGhlIHZlcmIgdW5kZXIgZXhlY3V0aW9uLCBzbyBhbiBlbnZlbG9wZSBjYW4gbmFtZSBpdC4gU2V0IG9uY2UgYnkgYG1haW5gLiAqL1xubGV0IGN1cnJlbnRDb21tYW5kOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuZXhwb3J0IGZ1bmN0aW9uIHNldEN1cnJlbnRDb21tYW5kKGNvbW1hbmQ6IHN0cmluZyB8IG51bGwpOiB2b2lkIHtcbiAgY3VycmVudENvbW1hbmQgPSBjb21tYW5kO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2V0Q3VycmVudENvbW1hbmQoKTogc3RyaW5nIHwgbnVsbCB7XG4gIHJldHVybiBjdXJyZW50Q29tbWFuZDtcbn1cblxuLyoqXG4gKiBPTkUgSlNPTiBkb2N1bWVudCBvbiBzdGRlcnIsIGFuZCBzdGRvdXQgc3RheXMgZW1wdHkg4oCUIHN0ZG91dCBjYXJyaWVzIGRhdGFcbiAqIGFuZCBhIGZhaWx1cmUgaGFzIG5vbmUuIEEgY2FsbGVyIHRoYXQgZ2V0cyBvbmUgSlNPTiBkb2N1bWVudCBmcm9tIGEgdmVyYiBhbmRcbiAqIHByb3NlIGZyb20gYSBmYWlsdXJlIGhhcyB0byBwYXJzZSB0d28gZm9ybWF0cyB0byB1c2Ugb25lIHRvb2wsIGFuZCB0aGVcbiAqIGZhaWx1cmUgaXMgdGhlIGNhc2Ugd2hlcmUgaXQgY2FuIGxlYXN0IGFmZm9yZCB0byBndWVzcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVycm9yRW52ZWxvcGUoa2luZDogRXJyS2luZCwgbWVzc2FnZTogc3RyaW5nLCBleHRyYT86IEVyckV4dHJhKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke0pTT04uc3RyaW5naWZ5KHtcbiAgICBvazogZmFsc2UsXG4gICAgZXJyb3I6IHtcbiAgICAgIGtpbmQsXG4gICAgICBleGl0X2NvZGU6IEVYSVRfRk9SW2tpbmRdLFxuICAgICAgLy8gT25seSByYXRlIGxpbWl0cyBhcmUgd29ydGggcmV0cnlpbmcgdW5jaGFuZ2VkOyBub3RoaW5nIHRoZSBob3VzZSByYWlzZXMgaXMuXG4gICAgICByZXRyeWFibGU6IGZhbHNlLFxuICAgICAgbWVzc2FnZSxcbiAgICAgIC4uLihleHRyYT8uaGludCA/IHsgaGludDogZXh0cmEuaGludCB9IDoge30pLFxuICAgICAgLi4uKGV4dHJhPy5jaG9pY2VzID8geyBjaG9pY2VzOiBleHRyYS5jaG9pY2VzIH0gOiB7fSksXG4gICAgfSxcbiAgICBtZXRhOiB7IGNvbW1hbmQ6IGN1cnJlbnRDb21tYW5kIH0sXG4gIH0pfVxcbmA7XG59XG5cbi8qKiBBIGZhaWx1cmUgd2l0aCBhIHRheG9ub215IGBraW5kYCwgcmFpc2VkIGJ5IGBkaWVgIGFuZCBjYXVnaHQgYnkgYG1haW5gLiAqL1xuZXhwb3J0IGNsYXNzIENsaUVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICByZWFkb25seSBraW5kOiBFcnJLaW5kO1xuICByZWFkb25seSBleHRyYT86IEVyckV4dHJhO1xuXG4gIGNvbnN0cnVjdG9yKGtpbmQ6IEVycktpbmQsIG1lc3NhZ2U6IHN0cmluZywgZXh0cmE/OiBFcnJFeHRyYSkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICAgIHRoaXMubmFtZSA9IFwiQ2xpRXJyb3JcIjtcbiAgICB0aGlzLmtpbmQgPSBraW5kO1xuICAgIHRoaXMuZXh0cmEgPSBleHRyYTtcbiAgfVxuXG4gIGdldCBleGl0Q29kZSgpOiBudW1iZXIge1xuICAgIHJldHVybiBFWElUX0ZPUlt0aGlzLmtpbmRdO1xuICB9XG59XG5cbi8qKiBSYWlzZSBhIHRheG9ub215IGZhaWx1cmUuIFJldHVybnMgYG5ldmVyYCwgc28gZGVmaW5pdGUtYXNzaWdubWVudCBhbmFseXNpc1xuICogIHN0aWxsIG5hcnJvd3MgYWZ0ZXIgaXQg4oCUIHRoZSBwcm9wZXJ0eSB0aGF0IGxldCB0aGUgb2xkIGV4aXRpbmcgZm9ybSBzaXQgaW5cbiAqICBhIGBjYXRjaGAgYW5kIGxlYXZlIHRoZSB2YXJpYWJsZSBpdCBndWFyZHMgYXNzaWduZWQuICovXG5leHBvcnQgZnVuY3Rpb24gZGllKG1lc3NhZ2U6IHN0cmluZywga2luZDogRXJyS2luZCA9IFwidXNhZ2VcIiwgZXh0cmE/OiBFcnJFeHRyYSk6IG5ldmVyIHtcbiAgdGhyb3cgbmV3IENsaUVycm9yKGtpbmQsIG1lc3NhZ2UsIGV4dHJhKTtcbn1cblxuLyoqXG4gKiBSZXBvcnQgYSBjYXVnaHQgZXJyb3IgYXMgdGhlIGhvdXNlIGVudmVsb3BlIGFuZCBoYW5kIGJhY2sgYW4gZXhpdCBjb2RlLCBvclxuICogYG51bGxgIHdoZW4gdGhlIGVycm9yIGlzIE5PVCBhIGBDbGlFcnJvcmAg4oCUIHdoaWNoIHRoZSBjYWxsZXIgbXVzdCByZXRocm93LlxuICogU3dhbGxvd2luZyBhbiB1bmtub3duIHRocm93IGhlcmUgd291bGQgcmVwb3J0IGFuIGludGVybmFsIGZhdWx0IGFzIGEgdGlkeVxuICogdGF4b25vbXkgZmFpbHVyZSBhbmQgbG9zZSB0aGUgc3RhY2sgdGhhdCBzYXlzIHdoYXQgYWN0dWFsbHkgYnJva2UuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXBvcnRDbGlFcnJvcihcbiAgZTogdW5rbm93bixcbiAgZXJyOiB7IHdyaXRlKGNodW5rOiBzdHJpbmcpOiB1bmtub3duIH0gPSBwcm9jZXNzLnN0ZGVycixcbik6IG51bWJlciB8IG51bGwge1xuICBpZiAoIShlIGluc3RhbmNlb2YgQ2xpRXJyb3IpKSByZXR1cm4gbnVsbDtcbiAgZXJyLndyaXRlKGVycm9yRW52ZWxvcGUoZS5raW5kLCBlLm1lc3NhZ2UsIGUuZXh0cmEpKTtcbiAgcmV0dXJuIGUuZXhpdENvZGU7XG59XG4iLAogICAgIi8qKlxuICogVGhlIGhvdXNlJ3MgT05FIFNTRSB0YWlsIGNsaWVudCDigJQgdGhlIHN0YW5kaW5nLCBzZWxmLWhlYWxpbmcgcmVhZCBsb29wIGV2ZXJ5XG4gKiBzcGVsbCdzIGB0YWlsYC9gam9pbmAgdmVyYiBydW5zLlxuICpcbiAqIOKblCBUSEUgS0lUIElTIEEgTEVBRi4gTm90aGluZyBoZXJlIG1heSBpbXBvcnQgb3V0IG9mIGBzcmMva2l0L2Ag4oCUIHdhcmQgMidzXG4gKiBhc3NlcnRpb24sIGFuZCBpdCBpcyB3aGF0IG1ha2VzIHRoaXMgbW9kdWxlIHNhZmUgdG8gYnVuZGxlIGludG8gYW55IHNwZWxsJ3NcbiAqIGJ1bmRsZS4gSXQgcmVhY2hlcyBmb3Igbm90aGluZywgbm90IGV2ZW4gdGhlIHNpYmxpbmcgZXJyb3IgY29udHJhY3QuXG4gKlxuICogRGVzaWduZWQgYWdhaW5zdCBhbGwgc2V2ZW4gb2YgdGhlIGhvdXNlJ3MgaGFuZC13cml0dGVuIHRhaWxzICh0aGUgY29udmVyZ2VuY2VcbiAqIGRlc2lnbiwgYGRvY3MvaW52ZXN0aWdhdGlvbnMvMjAyNi0wOS0wOC10YWlsLXJlYWRlci1jb252ZXJnZW5jZS5tZGApIGFuZFxuICogYWRvcHRlZCBmaXJzdCBieSBhc3Ryb2xhYmUgYW5kIG1hZ3BpZS5cbiAqXG4gKiDilIDilIAgVEhFIFRXTyBERUNJU0lPTlMgVEhBVCBNQUtFIE9ORSBDTElFTlQgUE9TU0lCTEUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogKioxLiBcIldoZXJlIGlzIHRoZSBkYWVtb25cIiBpcyBhIENBTExCQUNLLCBub3QgYSBVUkwuKiogYHJlc29sdmVgIGlzIGNhbGxlZFxuICogYmVmb3JlIEVWRVJZIGNvbm5lY3QgYXR0ZW1wdCBhbmQgaXRzIGFuc3dlciBpcyBuZXZlciBjYXB0dXJlZC4gVGhhdCBzaW5nbGVcbiAqIGNoYW5nZSB1bmlmaWVzIGZvdXIgaW5jb21wYXRpYmxlIGRpc2NvdmVyeSBtb2RlbHMg4oCUIHNlc3Npb24tcG9pbnRlciByZS1yZWFkLFxuICogcGlkLWNoZWNrZWQgcG9ydCBmaWxlLCByZXNwYXduLWlmLWFic2VudCDigJQgYW5kIGl0IHJlcGFpcnMgYSBkZWZlY3QgYnlcbiAqIGNvbnN0cnVjdGlvbiByYXRoZXIgdGhhbiBieSBhbnlvbmUgZml4aW5nIGl0OiBhc3Ryb2xhYmUgcmVzb2x2ZWQgaXRzIGRhZW1vblxuICogYmFzZSBPTkNFIGFuZCByZWNvbm5lY3RlZCB0byB0aGF0IG9uZSBjYXB0dXJlZCBwb3J0IGZvcmV2ZXIsIHNvIGBqb2luYCDigJQgdGhlIHZlcmJcbiAqIGRlc2lnbmVkIHRvIHJ1biBmb3IgaG91cnMgY2FycnlpbmcgcHJlc2VuY2Ug4oCUIHNwdW4gc2lsZW50bHkgYWdhaW5zdCBhIGRlYWRcbiAqIHBvcnQgYWZ0ZXIgYW55IGRhZW1vbiByZXN0YXJ0LCBhbmQgYXN0cm9sYWJlIGJpbmRzIGFuIGVwaGVtZXJhbCBwb3J0LlxuICpcbiAqICoqMi4gVGhpcyBjbGllbnQgTkVWRVIgY2FsbHMgYHByb2Nlc3MuZXhpdGAuIEl0IFJFVFVSTlMgYW4gZXhpdCBjb2RlLioqIFNlZVxuICogdGhlIHNjYXIgYmVsb3c7IHRoYXQgaXMgdGhlIHdob2xlIG9mIGl0LlxuICpcbiAqIOKUgOKUgCDim5QgVEhFIFNDQVI6IFAwZiwgU0hBUEUgQiDigJQgUkUtSE9NRUQgSEVSRSwgV1JJVFRFTiBPTkNFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICpcbiAqIEZpdmUgc3BlbGxzIGVhY2ggY2FycmllZCBhIGNvcHkgb2YgdGhpcyBwYXJhZ3JhcGgsIGJlY2F1c2UgZml2ZSBzaXRlcyBlYWNoXG4gKiBoYWQgdG8gcHJvdmUgTE9DQUxMWSB0aGF0IGVuZGluZyBhIHRhaWwgZG9lcyBub3QgY3V0IGl0cyBvd24gbGFzdCBsaW5lIHNob3J0LlxuICogSXQgZG9jdW1lbnRzIGEgMjMtbWludXRlIGhhbmcgdGhhdCBzaGlwcGVkLiBUaGUgcmVhc29uaW5nIG5vdyBsaXZlcyBpbiBvbmVcbiAqIHBsYWNlOyB0aGUgY29waWVzIGFyZSBnb25lLCBhbmQgdGhpcyBpcyB3aGF0IHRoZXkgc2FpZC5cbiAqXG4gKiBCdW4ncyBzdGRvdXQgaXMgQVNZTkNIUk9OT1VTIG9uIGEgcGlwZSAoc3luY2hyb25vdXMgb24gYSBUVFkgb3IgYSBmaWxlKS4gQW5cbiAqIGV4cGxpY2l0IGBwcm9jZXNzLmV4aXQoKWAgdGhlcmVmb3JlIGRpc2NhcmRzIHdoYXRldmVyIGhhcyBub3QgZHJhaW5lZCDigJRcbiAqIG1lYXN1cmVkIGF0IGV4YWN0bHkgNjUsNTM2IGJ5dGVzLCBvbmUgcGlwZSBidWZmZXIuIFRoZSBwYXlsb2FkIGlzIGNvbXBsZXRlXG4gKiBhbmQgb25seSB0aGUgd3JpdGUgaXMgbG9zdCwgc28gYSBjYWxsZXIgcmVjZWl2ZXMgd2VsbC1mb3JtZWQtTE9PS0lORyBKU09OXG4gKiB0aGF0IHN0b3BzIG1pZC1zdHJpbmcuIE1lYXN1cmVkLCBCdW4gMS4zLjE0LCAzMDBLQiB3cml0ZXM6XG4gKlxuICogICAgIHdyaXRlKGJpZywgY2IgLT4gZXhpdCkgICAgICAgICAgICAgICAgICAgIOKchSAzMDAwMDEgYnl0ZXMgYXJyaXZlXG4gKiAgICAgYXdhaXQgQnVuLndyaXRlKEJ1bi5zdGRvdXQsIGJpZykgICAgICAgICAg4pyFXG4gKiAgICAgbmF0dXJhbCByZXR1cm4sIHByb2Nlc3MuZXhpdENvZGUgICAgICAgICAg4pyFXG4gKiAgICAgd3JpdGUoYmlnKTsgd3JpdGUoXCJcIiwgY2IgLT4gZXhpdCkgICAgICAgICDinYwgNjU1MzZcbiAqICAgICA1eCB3cml0ZShiaWcpOyB3cml0ZShcIlwiLCBjYiAtPiBleGl0KSAgICAgIOKdjCBleGFjdGx5IDV4NjU1MzZcbiAqXG4gKiDim5QgVGhlIGxhc3QgdHdvIHJvd3MgYXJlIHdoeSBhIHRyYWlsaW5nIGB3cml0ZShcIlwiLCBjYilgIGlzIE5PVCBhIGJhcnJpZXI6IGFcbiAqIGRyYWluIGNhbGxiYWNrIGNvdmVycyBPTkxZIElUUyBPV04gV1JJVEUuIFRoYXQgaXMgZXhhY3RseSB0aGUgaGVscGVyIGFcbiAqIHdyaXRlLXRoZW4tZXhpdCBzaGFwZSBpbnZpdGVzLCBhbmQgaXQgbWVhc3VyZWQgYnl0ZS1mb3ItYnl0ZSBhcyBicm9rZW4gYXMgbm9cbiAqIGZpeCBhdCBhbGwuIERvIG5vdCByZWludHJvZHVjZSBpdC5cbiAqXG4gKiBUaGUgZml2ZSBjb3BpZXMgdGhlbiBlYWNoIGhhZCB0byBlc3RhYmxpc2ggYSBQRVItU0lURSBQUkVDT05ESVRJT04g4oCUIHdoZXRoZXJcbiAqIGEgYHJldHVybmAgZXNjYXBlcyB0aGUgdGhyZWUgbmVzdGVkIGxvb3BzIChvdXRlciByZWNvbm5lY3QsIGlubmVyIHJlYWQsIGZyYW1lXG4gKiBkcmFpbikgb3IgbWVyZWx5IGZhbGxzIHRocm91Z2ggaW50byBhbm90aGVyIHJldHJ5LiBUaGV5IGRpZCBub3QgYWdyZWU6IHR3b1xuICogbmVlZGVkIGFuIGV4cGxpY2l0IGByZXR1cm5gLCBvbmUgbmVlZGVkIGEgYHN0b3BwZWRgIGZsYWcgYXMgd2VsbCwgYW5kXG4gKiBhc3Ryb2xhYmUncyBzaXRlIGNvdWxkIGByZXR1cm5gIG9ubHkgYmVjYXVzZSBpdHMgY2FsbGVyIHJldHVybmVkIHN0cmFpZ2h0XG4gKiBhZnRlci4g4q2QICoqUkVUVVJOSU5HIEFOIEVYSVQgQ09ERSBSRVRJUkVTIFRIQVQgUVVFU1RJT04gRU5USVJFTFkuKiogVGhlcmUgaXNcbiAqIG9uZSBsb29wIG5vdzsgaXQgYnJlYWtzIHRvIG9uZSBwbGFjZTsgdGhlIGNhbGxlciBhc3NpZ25zIGBwcm9jZXNzLmV4aXRDb2RlYFxuICogYW5kIHJldHVybnMgbmF0dXJhbGx5LCBhbmQgdGhlIHJ1bnRpbWUgZHJhaW5zIHN0ZG91dCBiZWZvcmUgdGhlIHByb2Nlc3MgZW5kcy5cbiAqIE5vdGhpbmcgaGVyZSBuZWVkcyB0byBrbm93IHdoYXQgaXRzIGNhbGxlciBkb2VzIG5leHQuXG4gKlxuICogVGhhdCBhbHNvIHJlcGFpcnMgYSBkZWZlY3QgdGhlIGNvcGllcyBzaGFyZWQ6IHRoZSBkcmFpbiBmaXggd2FzIGFwcGxpZWQgdG9cbiAqIHRoZSB0ZXJtaW5hbCBmcmFtZSBidXQgTk9UIHRvIHRoZSBzaWduYWwgaGFuZGxlciB0d2VsdmUgbGluZXMgYWJvdmUgaXQsIHNvXG4gKiBDdHJsLUMgb24gYSB0YWlsIHBpcGVkIGludG8gYSByZWFkZXIgZGlzY2FyZGVkIHVuZHJhaW5lZCBzdGRvdXQuIFNhbWUgbG9vcCxcbiAqIHNhbWUgZXhpdCBwYXRoLCBvbmUgYW5zd2VyLlxuICpcbiAqIOKaoCBOT1QgcmUtaG9tZWQsIGRlbGliZXJhdGVseTogbWluZC1tYXBwZXIncyBtZWFzdXJlZCBCdW4gMS4zLjE0IGZpbmRpbmcgdGhhdFxuICogYGNvbnRyb2xsZXIuZW5xdWV1ZSgpYCBvbiBhbiBvcnBoYW5lZCBzdHJlYW0gbmV2ZXIgdGhyb3dzLiBJdCBpcyBhIERBRU1PTi1zaWRlXG4gKiBmYWN0IGFib3V0IGRlYWQtc29ja2V0IGRldGVjdGlvbiBhbmQgYmVhcnMgb24gYHNzZVJlc3BvbnNlYCwgbm90IG9uIGFueVxuICogY2xpZW50LiBJdCBzdGF5cyB3aGVyZSBpdCB3YXMgbWVhc3VyZWQuXG4gKlxuICog4pSA4pSAIFRIRSBXSVJFIEZPUk1BVCwgQU5EIFRIRSBgXCJkYXRhOiBcImAgUVVFU1RJT04gUkVTT0xWRUQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gKlxuICogUGVyIFdIQVRXRyBIVE1MLCBcIkludGVycHJldGluZyBhbiBldmVudCBzdHJlYW1cIjogc3BsaXQgZWFjaCBsaW5lIGF0IHRoZSBGSVJTVFxuICogY29sb247IGlmIHRoZSB2YWx1ZSBiZWdpbnMgd2l0aCBFWEFDVExZIE9ORSBzcGFjZSwgcmVtb3ZlIHRoYXQgb25lIHNwYWNlO1xuICogYXBwZW5kIGVhY2ggZGF0YSB2YWx1ZSBwbHVzIGEgbmV3bGluZSwgdGhlbiBzdHJpcCB0aGUgZmluYWwgbmV3bGluZS5cbiAqXG4gKiBUaGUgaG91c2UncyBzZXZlbiB0YWlscyBzcGxpdCBpbnRvIHR3byBub24tY29uZm9ybWFudCBjYW1wcywgYW5kIG5laXRoZXIgaXNcbiAqIGN1cnJlbnRseSB3cm9uZyBpbiBwcm9kdWN0aW9uLCBiZWNhdXNlIGV2ZXJ5IGhvdXNlIGRhZW1vbiBlbWl0cyBvbmUgZGF0YSBsaW5lXG4gKiBwZXIgZnJhbWUgV0lUSCB0aGUgc3BhY2U6XG4gKlxuICogICDigKIgYHN0YXJ0c1dpdGgoXCJkYXRhOiBcIilgIOKAlCB0aGUgbW9yZSBkYW5nZXJvdXMgZXJyb3IuIEEgc3BlYy1sZWdhbFxuICogICAgIGBkYXRhOnsuLi59YCBtYXRjaGVzIG5vdGhpbmcsIHNvIHRoZSBmcmFtZSBpcyBzaWxlbnRseSBkcm9wcGVkIEFORCBUSEVcbiAqICAgICBDVVJTT1IgRE9FUyBOT1QgQURWQU5DRS4gSXQgYWxzbyBrZWVwcyBvbmx5IHRoZSBmaXJzdCBkYXRhIGxpbmUuXG4gKiAgIOKAoiBgLnNsaWNlKDUpLnRyaW0oKWAg4oCUIHRoZSBtb3JlIGZvcmdpdmluZyBlcnJvci4gSXQgYWNjZXB0cyBib3RoIGZvcm1zIGJ1dFxuICogICAgIHN0cmlwcyBBTEwgd2hpdGVzcGFjZSByYXRoZXIgdGhhbiBvbmUgbGVhZGluZyBzcGFjZSwgd2hpY2ggd291bGQgY29ycnVwdFxuICogICAgIGEgcGF5bG9hZCB3aXRoIG1lYW5pbmdmdWwgaW5kZW50YXRpb24uXG4gKlxuICogVGhpcyBjbGllbnQgZG9lcyBuZWl0aGVyLiBTcGVjLWNvcnJlY3QgaXMgc2ltdWx0YW5lb3VzbHkgYnl0ZS1jb21wYXRpYmxlIHdpdGhcbiAqIGFsbCBzZXZlbiBkYWVtb25zIOKAlCB0aGUgcmFyZSBjYXNlIHdoZXJlIHRoZSByaWdodCBhbnN3ZXIgY29zdHMgbm90aGluZy5cbiAqXG4gKiBgaWQ6YCAvIExhc3QtRXZlbnQtSUQgLyBgcmV0cnk6YCBhcmUgTk9UIGltcGxlbWVudGVkLCBhbmQgdGhhdCBpcyBhIHN0YXRlZFxuICogaG91c2UgY2hvaWNlIHJhdGhlciB0aGFuIGFuIG9taXNzaW9uOiByZXN1bWUgaXMgYSBxdWVyeS1wYXJhbSBjdXJzb3IsIHNvIHRoZVxuICogc2VydmVyJ3MgcmVwbGF5IHdpbmRvdyBhbmQgdGhlIGNsaWVudCdzIGBzaW5jZWAgYXJlIHRoZSBvbmUgbWVjaGFuaXNtLlxuICovXG5cbi8qKiBPbmUgcGFyc2VkIFNTRSBmcmFtZS4gYGV2ZW50YCBkZWZhdWx0cyB0byBcIm1lc3NhZ2VcIiBwZXIgdGhlIHNwZWMuICovXG5leHBvcnQgdHlwZSBTc2VGcmFtZSA9IHtcbiAgZXZlbnQ6IHN0cmluZztcbiAgLyoqIFRoZSBhY2N1bXVsYXRlZCBgZGF0YWAgdmFsdWU6IGZpZWxkcyBqb2luZWQgd2l0aCBcIlxcblwiLCBmaW5hbCBuZXdsaW5lIHN0cmlwcGVkLiAqL1xuICBkYXRhOiBzdHJpbmc7XG59O1xuXG4vKiogQSB3cml0YWJsZSBzaW5rLiBOYXJyb3cgb24gcHVycG9zZSDigJQgYHByb2Nlc3Muc3Rkb3V0YCBhbmQgYSB0ZXN0IGRvdWJsZVxuICogIGJvdGggc2F0aXNmeSBpdCwgYW5kIHRoZSBraXQgbWF5IG5vdCBuYW1lIGEgbm9kZSB0eXBlIGl0IGRvZXMgbm90IGltcG9ydC4gKi9cbmV4cG9ydCB0eXBlIFNpbmsgPSB7IHdyaXRlKGNodW5rOiBzdHJpbmcpOiB1bmtub3duIH07XG5cbmV4cG9ydCB0eXBlIFRhaWxPcHRpb25zPEV2PiA9IHtcbiAgLy8g4pSA4pSAIFdIRVJFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKipcbiAgICogVGhlIGRhZW1vbidzIGJhc2UgVVJMIChubyB0cmFpbGluZyBzbGFzaCksIG9yIGBudWxsYCB3aGVuIGl0IGNhbm5vdCBiZVxuICAgKiBmb3VuZCByaWdodCBub3cuIOKblCBDQUxMRUQgQkVGT1JFIEVWRVJZIENPTk5FQ1QgQVRURU1QVCBBTkQgTkVWRVIgQ0FQVFVSRURcbiAgICog4oCUIGEgdGFpbCBvdXRsaXZlcyB0aGUgZGFlbW9uIGl0IHN0YXJ0ZWQgYWdhaW5zdCwgYW5kIGEgY2FwdHVyZWQgYmFzZSBpc1xuICAgKiB0aGUgZGVmZWN0IHRoaXMgcGFyYW1ldGVyIGV4aXN0cyB0byBtYWtlIHVucmVhY2hhYmxlLiBJdCBtYXkgcmUtcmVhZCBhXG4gICAqIHBvaW50ZXIgZmlsZSwgcHJvYmUgbGl2ZW5lc3MsIG9yIHNwYXduOyBpdCBtYXkgdGhyb3csIGFuZCB0aGUgdGhyb3cgaXMgdGhlXG4gICAqIGNhbGxlcidzIHRvIGFuc3dlciAod2hpY2ggaXMgc3RyaWN0bHkgYmV0dGVyIHRoYW4gYSBgZGllYCByZWFjaGFibGUgZnJvbVxuICAgKiBpbnNpZGUgYSByZWNvbm5lY3QgbG9vcCkuXG4gICAqL1xuICByZXNvbHZlOiAoKSA9PiBzdHJpbmcgfCBudWxsIHwgUHJvbWlzZTxzdHJpbmcgfCBudWxsPjtcbiAgLyoqXG4gICAqIFdoYXQgdG8gZG8gd2hlbiBgcmVzb2x2ZWAgc2F5cyBcIm5vdCBmb3VuZFwiLiBEZWZhdWx0IGBcInJldHJ5XCJgIGZvcmV2ZXIuXG4gICAqIGBcInN0b3BcImAgZW5kcyB0aGUgdGFpbCBhdCBleGl0IGNvZGUgMCDigJQgdGhlIHNoYXBlIGEgc3BlbGwgd2FudHMgd2hlbiB0aGVcbiAgICogc2Vzc2lvbiBpdCBQSU5ORUQgaGFzIGdvbmUgYXdheSwgd2hpY2ggaXMgYSBjb21wbGV0ZWQgd2F0Y2ggYW5kIG5vdCBhXG4gICAqIGZhaWx1cmUuIFRoZSBmbGFncyBkaXN0aW5ndWlzaCBcIm5ldmVyIGZvdW5kIG9uZVwiIGZyb20gXCJoYWQgb25lLCBsb3N0IGl0XCIuXG4gICAqL1xuICBvblVucmVzb2x2ZWQ/OiAoczogeyBldmVyUmVzb2x2ZWQ6IGJvb2xlYW47IGV2ZXJDb25uZWN0ZWQ6IGJvb2xlYW4gfSkgPT4gXCJyZXRyeVwiIHwgXCJzdG9wXCI7XG5cbiAgLy8g4pSA4pSAIFdIQVQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBQYXRoIG9uIHRoZSBkYWVtb24sIGUuZy4gYFwiL2V2ZW50c1wiYC4gSm9pbmVkIHRvIGByZXNvbHZlYCdzIGFuc3dlci4gKi9cbiAgcGF0aDogc3RyaW5nO1xuICAvKiogVGhlIHN0YXJ0aW5nIGN1cnNvci4gU2VudCBhcyBgc2luY2VgIHVubGVzcyBgcXVlcnlgIHNheXMgb3RoZXJ3aXNlLiAqL1xuICBzaW5jZTogbnVtYmVyO1xuICAvKiogUmVhZCB0aGUgY3Vyc29yIG9mZiBhbiBldmVudCAoYGV2LmlkYCwgYGV2LnNlcWAsIGBwYXlsb2FkLmlkYCwg4oCmKS4gKi9cbiAgY3Vyc29yT2Y/OiAoZXY6IEV2KSA9PiBudW1iZXIgfCB1bmRlZmluZWQ7XG4gIC8qKlxuICAgKiBgXCJtb25vdG9uaWNcImAgKGRlZmF1bHQpIHRha2VzIHRoZSBtYXgsIHNvIGEgcmVwbGF5ZWQgb3Igb3V0LW9mLW9yZGVyIGZyYW1lXG4gICAqIGNhbm5vdCByZWdyZXNzIHRoZSBjdXJzb3IgYW5kIG1ha2UgdGhlIG5leHQgcmVjb25uZWN0IHJlLXJlcXVlc3QgZXZlbnRzXG4gICAqIGFscmVhZHkgc2Vlbi4gYFwiYXNzaWduXCJgIHRha2VzIHRoZSB2YWx1ZSBhcyBnaXZlbiDigJQgYXZhaWxhYmxlIGJlY2F1c2Ugb25lXG4gICAqIHNwZWxsIGRvZXMgdGhhdCB0b2RheSBhbmQgbm9ib2R5IGhhcyBydWxlZCB3aGV0aGVyIGl0IHdhcyBpbnRlbmRlZC5cbiAgICovXG4gIGN1cnNvclBvbGljeT86IFwibW9ub3RvbmljXCIgfCBcImFzc2lnblwiO1xuICAvKiogUGVyLWF0dGVtcHQgcXVlcnkgcGFyYW1ldGVycy4gRGVmYXVsdCBgeyBzaW5jZTogU3RyaW5nKGN1cnNvcikgfWAuXG4gICAqICBgZmlyc3RDb25uZWN0YCBpcyB3aGF0IGxldHMgYSBgLS1sYXN0IE5gIHdpbmRvdyByaWRlIHRoZSBmaXJzdCBjb25uZWN0aW9uXG4gICAqICBvbmx5LCBuZXZlciByZS1iYWNrZmlsbGluZyBvbiBhIHJlY29ubmVjdC4gKi9cbiAgcXVlcnk/OiAoY3Vyc29yOiBudW1iZXIsIGZpcnN0Q29ubmVjdDogYm9vbGVhbikgPT4gUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcblxuICAvLyDilIDilIAgRVBPQ0ggKG9wdC1pbjsgcmVxdWlyZXMgYSBkYWVtb24gdGhhdCBzdGFtcHMgb25lKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqIFJlYWQgdGhlIGRhZW1vbidzIGVwb2NoIG9mZiBhbiBldmVudC4gKi9cbiAgZXBvY2hPZj86IChldjogRXYpID0+IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgLyoqIEEgcmVjb25uZWN0IGxhbmRlZCBvbiBhIERJRkZFUkVOVCBlcG9jaDogdGhlIGRhZW1vbiByZXN0YXJ0ZWQsIHNvIHRoZVxuICAgKiAgY3Vyc29yIHJlc2V0cyB0byAwLiBSZXR1cm4gYSBsaW5lIHRvIGVtaXQgKGEgc3ludGhlc2l6ZWQgbm90aWNlLCBuZXZlciBhXG4gICAqICBidXMgZXZlbnQpIG9yIG51bGwuICovXG4gIG9uRXBvY2hDaGFuZ2U/OiAobmV4dDogc3RyaW5nKSA9PiBzdHJpbmcgfCBudWxsO1xuXG4gIC8vIOKUgOKUgCBGSUxURVIgYW5kIFNIQVBFIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogU2NvcGUg4oinIMKsc2VsZi1lY2hvLiBBIHJlamVjdGVkIGV2ZW50IHN0aWxsIEFEVkFOQ0VTIFRIRSBDVVJTT1IuICovXG4gIGFjY2VwdD86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gYm9vbGVhbjtcbiAgLyoqIFRoZSBsaW5lIHRvIHdyaXRlIGZvciBhbiBhY2NlcHRlZCBldmVudCwgb3IgbnVsbCB0byB3cml0ZSBub3RoaW5nLlxuICAgKiAgRGVmYXVsdDogdGhlIGZyYW1lJ3MgZGF0YSB2ZXJiYXRpbS4gUmVjZWl2ZXMgdGhlIGZyYW1lLCBzbyBhIGNsaWVudCB0aGF0XG4gICAqICBicmFuY2hlcyBvbiBhIG5hbWVkIG5vbi1kYXRhIGZyYW1lIChgZXZlbnQ6IHN1YnNjcmliZWRgKSBpcyBzZXJ2ZWQgaGVyZVxuICAgKiAgcmF0aGVyIHRoYW4gbmVlZGluZyBhIGhhdGNoIG9mIGl0cyBvd24uICovXG4gIHJlbmRlcj86IChldjogRXYsIGZyYW1lOiBTc2VGcmFtZSkgPT4gc3RyaW5nIHwgbnVsbDtcbiAgLyoqXG4gICAqIEEgZnJhbWUgd2hvc2UgZGF0YSB3aWxsIG5vdCBwYXJzZS4gRGVmYXVsdDogc2tpcCBpdC4g4puUIFRIRSBSRVRVUk5FRCBMSU5FXG4gICAqIEdPRVMgVE8gYGVycmAsIE5PVCBgb3V0YCDigJQgaXQgaXMgYSBkaWFnbm9zdGljIGFib3V0IHRoZSBzdHJlYW0sIGFuZCBzdGRvdXRcbiAgICogY2FycmllcyBkYXRhLiBBIHNwZWxsIHRoYXQgZ2VudWluZWx5IHdhbnRzIHRoZSB1bnBhcnNlZCBsaW5lIG9uIHN0ZG91dFxuICAgKiAob25lIGRvZXMpIHdyaXRlcyBpdCBmcm9tIGluc2lkZSB0aGlzIGhvb2sgYW5kIHJldHVybnMgbnVsbC5cbiAgICpcbiAgICog4pqgIFRoZSBjdXJzb3IgY2Fubm90IGFkdmFuY2UgcGFzdCBhIGZyYW1lIG5vYm9keSBjYW4gcmVhZCwgc28gYSBQRVJNQU5FTlRMWVxuICAgKiBtYWxmb3JtZWQgZnJhbWUgaXMgcmUtZGVsaXZlcmVkIG9uIGV2ZXJ5IHJlY29ubmVjdCBmb3IgdGhlIGRhZW1vbidzIGxpZmUuXG4gICAqL1xuICBvbk1hbGZvcm1lZD86IChmcmFtZTogU3NlRnJhbWUsIGVycm9yOiB1bmtub3duKSA9PiBzdHJpbmcgfCBudWxsO1xuXG4gIC8vIOKUgOKUgCBFTkQg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4gIC8qKiBUaGUgZnJhbWUgdGhhdCBlbmRzIHRoZSB3YXRjaCAoYSBgY2xvc2VkYCBsaWZlY3ljbGUgZXZlbnQpLiBPcHRpb25hbCwgYW5kXG4gICAqICB0aGF0IGlzIHRoZSBhY3R1YWwgc2hhcGUgb2YgdGhlIHJvc3RlciByYXRoZXIgdGhhbiBhIGhlZGdlOiBzb21lIHRhaWxzIHJ1blxuICAgKiAgZm9yZXZlciBhbmQgaGF2ZSBubyB0ZXJtaW5hbCBmcmFtZSBhdCBhbGwuICovXG4gIHRlcm1pbmFsPzogKGV2OiBFdikgPT4gYm9vbGVhbjtcbiAgLyoqIEVtaXQgdGhlIHRlcm1pbmFsIGZyYW1lIGV2ZW4gd2hlbiBgYWNjZXB0YCByZWplY3RlZCBpdC4gRGVmYXVsdCBmYWxzZS4gKi9cbiAgdGVybWluYWxFbWl0c0ZpbHRlcmVkPzogYm9vbGVhbjtcblxuICAvLyDilIDilIAgVFJBTlNQT1JUIEhFQUxUSCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbiAgLyoqXG4gICAqIFRoZSBpZGxlIHdhdGNoZG9nLCBpbiBtcy4gRGVmYXVsdCA0NV8wMDAg4omIIHRocmVlIG1pc3NlZCAxNXMgaGVhcnRiZWF0cy5cbiAgICogMCBkaXNhYmxlcyBpdC4gV2l0aG91dCBvbmUsIGBhd2FpdCByZWFkZXIucmVhZCgpYCBwYXJrcyBGT1JFVkVSIG9uIGFcbiAgICogaGFsZi1vcGVuIHNvY2tldCBhZnRlciBsYXB0b3Agc2xlZXAsIGEgTkFUIHJlYmluZCwgb3IgYSBTSUdLSUxMZWQgZGFlbW9uLlxuICAgKlxuICAgKiDimqAgSG9sZCBpdCB3ZWxsIGFib3ZlIHRoZSBkYWVtb24ncyBoZWFydGJlYXQuIFdoZXJlIGhvbGRpbmcgdGhlIGNvbm5lY3Rpb25cbiAgICogb3BlbiBJUyB0aGUgcHJlc2VuY2Ugc2lnbmFsLCBldmVyeSB3YXRjaGRvZyBmaXJlIGZsYXBzIGEgY2FyZCBpbiBhIGh1bWFuJ3NcbiAgICogdmlldyDigJQgdGhhdCBpcyB0aGUgb25lIHBsYWNlIHRoaXMgY29udmVyZ2VuY2Ugc2hvd3MgdXAgZm9yIGEgcGVyc29uLiBJdFxuICAgKiBzdGlsbCB3YW50cyB0aGUgd2F0Y2hkb2c6IGEgd2VkZ2VkIGhhbGYtb3BlbiBjb25uZWN0aW9uIHNob3dzIGEgY2FyZCBhc1xuICAgKiBwZXJtYW5lbnRseSBwcmVzZW50LCB3aGljaCBpcyB3b3JzZS5cbiAgICovXG4gIGlkbGVNcz86IG51bWJlcjtcbiAgLyoqIFJlY29ubmVjdCBiYWNrb2ZmLiBEZWZhdWx0IGB7IGluaXRpYWxNczogMjUwLCBtYXhNczogNTAwMCB9YDsgZG91YmxlcyBvblxuICAgKiAgZXZlcnkgZmFpbGVkIGF0dGVtcHQgYW5kIFJFU0VUUyBvbiBhIHN1Y2Nlc3NmdWwgb3Blbi4gQSBicmFuY2ggdGhhdCBzbGVlcHNcbiAgICogIHdpdGhvdXQgZ3Jvd2luZyB0aGUgZGVsYXkgaXMgYSBjb25zdGFudC1pbnRlcnZhbCByZWNvbm5lY3Qgc3Rvcm0g4oCUIHRoYXQgaXMgYVxuICAgKiAgbGl2ZSBkZWZlY3QgaW4gb25lIHNwZWxsIHRvZGF5LCBhbmQgdGhlcmUgaXMgb25lIGNvZGUgcGF0aCBoZXJlLiAqL1xuICByZXRyeT86IHsgaW5pdGlhbE1zOiBudW1iZXI7IG1heE1zOiBudW1iZXIgfTtcbiAgLyoqIEEgbm9uLTJ4eCByZXNwb25zZS4gRGVmYXVsdDogcmV0cnkgd2l0aCBiYWNrb2ZmLiBNYXkgdGhyb3cg4oCUIGEgcmVmdXNlZFxuICAgKiAgY29ubmVjdGlvbiAoYW4gdW5rbm93biBwcm9qZWN0LCBhIHN0b3JlIHRoYXQgbmVlZHMgb25lKSBpcyBhIHVzYWdlIGVycm9yLFxuICAgKiAgbm90IGEgdHJhbnNwb3J0IGJsaXAsIGFuZCByZXRyeWluZyBpdCBmb3JldmVyIGp1c3Qgc3BpbnMgc2lsZW50bHkuICovXG4gIG9uSHR0cEVycm9yPzogKHJlczogUmVzcG9uc2UpID0+IFwicmV0cnlcIiB8IFByb21pc2U8XCJyZXRyeVwiPjtcbiAgLyoqIEEgYDpgIGNvbW1lbnQgbGluZSAoYSBrZWVwYWxpdmUpLiBSZXR1cm4gYSBsaW5lIGZvciBgZXJyYCDigJQgdGhlIHNlbnRpbmVsXG4gICAqICB0aGF0IGxldHMgYSBgMj4mMWAgY29uc3VtZXIgdGVsbCBcImlkbGVcIiBmcm9tIFwid2VkZ2VkXCIg4oCUIG9yIG51bGwuXG4gICAqICDim5QgQ29tbWVudHMgRkVFRCBUSEUgV0FUQ0hET0cgZXZlbiB0aG91Z2ggb25seSBkYXRhIGZyYW1lcyBzdXJ2aXZlIHRoZVxuICAgKiAgc2VsZWN0aW9uIGJlbG93IOKAlCB0aGF0IGlzIGhhbmRsZWQgaGVyZSwgYmVmb3JlIHRoaXMgaG9vayBpcyBjYWxsZWQuICovXG4gIG9uQ29tbWVudD86ICh0ZXh0OiBzdHJpbmcpID0+IHN0cmluZyB8IG51bGw7XG4gIC8qKlxuICAgKiBPbmUgY29ubmVjdGlvbiBhdHRlbXB0IGVuZGVkLiBSZXR1cm4gYSBsaW5lIGZvciBgZXJyYCwgb3IgbnVsbC5cbiAgICpcbiAgICog4puUIFRISVMgSVMgQSBESUFHTk9TVElDUyBTSU5LLCBOT1QgQSBGSUZUSCBFU0NBUEUgSEFUQ0gg4oCUIGFuZCB0aGVcbiAgICogZGlzdGluY3Rpb24gaXMgYSBydWxpbmcsIG5vdCBhIHByZWZlcmVuY2UuIFRoZSBoYXRjaGVzIHRoaXMgY2xpZW50IG9mZmVyc1xuICAgKiAoYGFjY2VwdGAsIGByZW5kZXJgLCBgcXVlcnlgLCBgcmVzb2x2ZWApIGFyZSBCRUhBVklPVVJBTDogdGhleSBjaGFuZ2Ugd2hhdFxuICAgKiB0aGUgY2xpZW50IERPRVMuIFRoaXMgb25lIGNoYW5nZXMgb25seSB3aGF0IHRoZSBDQUxMRVIgUkVQT1JUUywgd2hpY2ggaXNcbiAgICogd2hhdCBgZXJyYCB3YXMgaW4gdGhlIHNpZ25hdHVyZSBmb3IuIFRoZSBkZXNpZ24ncyB0cmlwLXdpcmUg4oCUIFwiYSBmaWZ0aFxuICAgKiBlc2NhcGUgaGF0Y2ggbWVhbnMgZ3JhcGV2aW5lIGtlZXBzIGl0cyBvd24gbG9vcFwiIOKAlCBpcyBub3QgdHJpcHBlZCBieSBpdC5cbiAgICpcbiAgICogSXQgZXhpc3RzIGJlY2F1c2UgYSB0YWlsIHRoYXQgcmVjb25uZWN0cyBpbiBzaWxlbmNlIGlzIGluZGlzdGluZ3Vpc2hhYmxlXG4gICAqIGZyb20gYSB0YWlsIHRoYXQgaXMgd29ya2luZywgYW5kIG9uZSBzcGVsbCB3cml0ZXMgZm91ciBkaXN0aW5jdCBsaW5lcyBoZXJlLlxuICAgKiBgY2F1c2VgIHNheXMgd2hpY2g7IGBlcnJvcmAgYW5kIGBzdGF0dXNgIGNhcnJ5IHdoYXQgdGhlIGxpbmUgbmVlZHMuXG4gICAqL1xuICBvbkRpc2Nvbm5lY3Q/OiAoaW5mbzoge1xuICAgIGNhdXNlOiBcImNvbm5lY3QtZmFpbGVkXCIgfCBcImh0dHBcIiB8IFwibm8tYm9keVwiIHwgXCJzdHJlYW0tZXJyb3JcIiB8IFwic3RyZWFtLWVuZFwiO1xuICAgIGVycm9yPzogdW5rbm93bjtcbiAgICBzdGF0dXM/OiBudW1iZXI7XG4gIH0pID0+IHN0cmluZyB8IG51bGw7XG5cbiAgLy8g4pSA4pSAIFBMVU1CSU5HIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuICAvKiogV2hlcmUgREFUQSBnb2VzLiBEZWZhdWx0IGBwcm9jZXNzLnN0ZG91dGAuICovXG4gIG91dD86IFNpbms7XG4gIC8qKiBXaGVyZSBESUFHTk9TVElDUyBnbyDigJQga2VlcGFsaXZlIHNlbnRpbmVscywgZGlzY29ubmVjdCBub3RlcywgdW5wYXJzZWFibGVcbiAgICogIGZyYW1lcy4gRGVmYXVsdCBgcHJvY2Vzcy5zdGRlcnJgLiBOZXZlciBtaXhlZCB3aXRoIGBvdXRgOiBhIGNhbGxlciByZWFkaW5nXG4gICAqICBvdXIgc3Rkb3V0IHdpdGggYSBsaW5lLWRlbGltaXRlZCBwYXJzZXIgbXVzdCBuZXZlciBtZWV0IGEgbm90ZS4gKi9cbiAgZXJyPzogU2luaztcbiAgLyoqIENhbGxlci1vd25lZCBhYm9ydC4gQWJvcnRpbmcgZW5kcyB0aGUgdGFpbCBhdCBleGl0IGNvZGUgMC4gKi9cbiAgc2lnbmFsPzogQWJvcnRTaWduYWw7XG4gIC8qKlxuICAgKiBJbnN0YWxsIFNJR0lOVC9TSUdURVJNIGhhbmRsZXJzIHRoYXQgZW5kIHRoZSB0YWlsIGNsZWFubHkgKGRlZmF1bHQgdHJ1ZSkuXG4gICAqIOKblCBUaGV5IGVuZCBpdCBieSBSRVRVUk5JTkcsIG5vdCBieSBleGl0aW5nIOKAlCBzZWUgdGhlIFAwZiBzY2FyOiBhIHNpZ25hbFxuICAgKiBoYW5kbGVyIHRoYXQgY2FsbHMgYHByb2Nlc3MuZXhpdGAgZGlzY2FyZHMgdW5kcmFpbmVkIHN0ZG91dCwgd2hpY2ggaXMgdGhlXG4gICAqIGhhbGYgb2YgdGhlIGZpeCBmaXZlIHNwZWxscyBkaWQgbm90IGFwcGx5LlxuICAgKi9cbiAgc2lnbmFscz86IGJvb2xlYW47XG59O1xuXG5jb25zdCBERUZBVUxUX0lETEVfTVMgPSA0NV8wMDA7XG5jb25zdCBERUZBVUxUX1JFVFJZID0geyBpbml0aWFsTXM6IDI1MCwgbWF4TXM6IDUwMDAgfTtcblxuLyoqXG4gKiBQYXJzZSBhIGNvbXBsZXRlIFNTRSBmcmFtZSBib2R5ICh0aGUgdGV4dCBiZXR3ZWVuIGJsYW5rIGxpbmVzKSBwZXIgdGhlIHNwZWMnc1xuICogXCJJbnRlcnByZXRpbmcgYW4gZXZlbnQgc3RyZWFtXCI6IHNwbGl0IGF0IHRoZSBGSVJTVCBjb2xvbiwgc3RyaXAgQVQgTU9TVCBPTkVcbiAqIGxlYWRpbmcgc3BhY2UgZnJvbSB0aGUgdmFsdWUsIGFjY3VtdWxhdGUgYGRhdGFgIGZpZWxkcyB3aXRoIFwiXFxuXCIuXG4gKlxuICogUmV0dXJucyBudWxsIGZvciBhIGNvbW1lbnQtb25seSBmcmFtZTsgYGNvbW1lbnRzYCBjYXJyaWVzIHRoZWlyIHRleHQgc28gdGhlXG4gKiBjYWxsZXIgY2FuIHN1cmZhY2UgYSBrZWVwYWxpdmUgc2VudGluZWwuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVNzZUZyYW1lKGJsb2NrOiBzdHJpbmcpOiB7IGZyYW1lOiBTc2VGcmFtZSB8IG51bGw7IGNvbW1lbnRzOiBzdHJpbmdbXSB9IHtcbiAgY29uc3QgY29tbWVudHM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IGRhdGFMaW5lczogc3RyaW5nW10gPSBbXTtcbiAgbGV0IGV2ZW50ID0gXCJtZXNzYWdlXCI7XG4gIGxldCBzYXdEYXRhID0gZmFsc2U7XG5cbiAgZm9yIChjb25zdCBsaW5lIG9mIGJsb2NrLnNwbGl0KFwiXFxuXCIpKSB7XG4gICAgaWYgKGxpbmUgPT09IFwiXCIpIGNvbnRpbnVlO1xuICAgIGlmIChsaW5lLnN0YXJ0c1dpdGgoXCI6XCIpKSB7XG4gICAgICBjb21tZW50cy5wdXNoKGxpbmUuc2xpY2UoMSkpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IGNvbG9uID0gbGluZS5pbmRleE9mKFwiOlwiKTtcbiAgICBjb25zdCBmaWVsZCA9IGNvbG9uID09PSAtMSA/IGxpbmUgOiBsaW5lLnNsaWNlKDAsIGNvbG9uKTtcbiAgICBsZXQgdmFsdWUgPSBjb2xvbiA9PT0gLTEgPyBcIlwiIDogbGluZS5zbGljZShjb2xvbiArIDEpO1xuICAgIGlmICh2YWx1ZS5zdGFydHNXaXRoKFwiIFwiKSkgdmFsdWUgPSB2YWx1ZS5zbGljZSgxKTtcbiAgICBpZiAoZmllbGQgPT09IFwiZGF0YVwiKSB7XG4gICAgICBkYXRhTGluZXMucHVzaCh2YWx1ZSk7XG4gICAgICBzYXdEYXRhID0gdHJ1ZTtcbiAgICB9IGVsc2UgaWYgKGZpZWxkID09PSBcImV2ZW50XCIpIHtcbiAgICAgIGV2ZW50ID0gdmFsdWU7XG4gICAgfVxuICAgIC8vIGBpZDpgIGFuZCBgcmV0cnk6YCBhcmUgZGVsaWJlcmF0ZWx5IGlnbm9yZWQg4oCUIHNlZSB0aGUgaGVhZGVyLlxuICB9XG5cbiAgaWYgKCFzYXdEYXRhKSByZXR1cm4geyBmcmFtZTogbnVsbCwgY29tbWVudHMgfTtcbiAgcmV0dXJuIHsgZnJhbWU6IHsgZXZlbnQsIGRhdGE6IGRhdGFMaW5lcy5qb2luKFwiXFxuXCIpIH0sIGNvbW1lbnRzIH07XG59XG5cbi8qKlxuICogUnVuIGEgc3RhbmRpbmcgU1NFIHRhaWwgdW50aWwgaXQgZW5kcywgYW5kIHJldHVybiB0aGUgcHJvY2VzcyBleGl0IGNvZGUuXG4gKlxuICog4puUIElUIE5FVkVSIENBTExTIGBwcm9jZXNzLmV4aXRgLiBUaGUgY2FsbGVyIGRvZXMgYHByb2Nlc3MuZXhpdENvZGUgPSBhd2FpdFxuICogdGFpbEV2ZW50cyguLi4pYCBhbmQgcmV0dXJucyBuYXR1cmFsbHkuIFNlZSB0aGUgUDBmIHNjYXIgaW4gdGhpcyBmaWxlJ3NcbiAqIGhlYWRlciBmb3Igd2h5IHRoYXQgaXMgdGhlIHdob2xlIGRlc2lnbiBhbmQgbm90IGEgc3R5bGUgcHJlZmVyZW5jZS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHRhaWxFdmVudHM8RXY+KG9wdHM6IFRhaWxPcHRpb25zPEV2Pik6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IG91dCA9IG9wdHMub3V0ID8/IHByb2Nlc3Muc3Rkb3V0O1xuICBjb25zdCBlcnIgPSBvcHRzLmVyciA/PyBwcm9jZXNzLnN0ZGVycjtcbiAgY29uc3QgaWRsZU1zID0gb3B0cy5pZGxlTXMgPz8gREVGQVVMVF9JRExFX01TO1xuICBjb25zdCByZXRyeSA9IG9wdHMucmV0cnkgPz8gREVGQVVMVF9SRVRSWTtcbiAgY29uc3QgY3Vyc29yUG9saWN5ID0gb3B0cy5jdXJzb3JQb2xpY3kgPz8gXCJtb25vdG9uaWNcIjtcblxuICBsZXQgY3Vyc29yID0gb3B0cy5zaW5jZTtcbiAgbGV0IGVwb2NoOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgbGV0IGV2ZXJSZXNvbHZlZCA9IGZhbHNlO1xuICBsZXQgZXZlckNvbm5lY3RlZCA9IGZhbHNlO1xuICBsZXQgZmlyc3RDb25uZWN0ID0gdHJ1ZTtcbiAgbGV0IGRlbGF5ID0gcmV0cnkuaW5pdGlhbE1zO1xuICBsZXQgY29kZSA9IDA7XG5cbiAgLy8gT25lIHN0b3Agc3dpdGNoIGZvciBldmVyeSB3YXkgdGhpcyBsb29wIGNhbiBlbmQ6IGEgc2lnbmFsLCBhIGNhbGxlcidzXG4gIC8vIGFib3J0LCBhIGRvd25zdHJlYW0gcmVhZGVyIGNsb3Npbmcgb3VyIHN0ZG91dC4gRWFjaCBzZXRzIGl0LCBhYm9ydHMgdGhlXG4gIC8vIGluLWZsaWdodCBhdHRlbXB0IEFORCBXQUtFUyBUSEUgQkFDS09GRjsgdGhlIGxvb3AgdGhlbiBmYWxscyBvdXQgYW5kXG4gIC8vIFJFVFVSTlMuXG4gIC8vXG4gIC8vIOKblCBXQUtJTkcgVEhFIEJBQ0tPRkYgSVMgTk9UIEEgREVUQUlMIOKAlCBJVCBJUyBUSEUgQ3RybC1DIFBBVEguIEluc3RhbGxpbmcgYVxuICAvLyBTSUdJTlQgbGlzdGVuZXIgU1VQUFJFU1NFUyB0aGUgcnVudGltZSdzIGRlZmF1bHQgdGVybWluYXRlLCBzbyB3aGF0ZXZlclxuICAvLyB0aGlzIGNsaWVudCBkb2VzIG9uIGEgc2lnbmFsIGlzIG5vdyB0aGUgd2hvbGUgb2Ygd2hhdCBoYXBwZW5zLiBBIGZpcnN0XG4gIC8vIHZlcnNpb24gYWJvcnRlZCB0aGUgYXR0ZW1wdCBhbmQgbGVmdCB0aGUgcmVjb25uZWN0IHNsZWVwaW5nIG9uIGEgYmFyZVxuICAvLyB0aW1lcjogQ3RybC1DIGR1cmluZyBiYWNrb2ZmIHRvb2sgdXAgdG8gYHJldHJ5Lm1heE1zYCBpbnN0ZWFkIG9mIGVuZGluZyBhdFxuICAvLyBvbmNlLCBtZWFzdXJlZCBhdCAyLjgwcyBhZ2FpbnN0IGEgZGVhZCBwb3J0IHdoZXJlIHRoZSBoYW5kLXdyaXR0ZW4gbG9vcFxuICAvLyB0b29rIDAuMTNzIOKAlCBhbmQgaGFtbWVyaW5nIEN0cmwtQyBkaWQgbm90IGhlbHAsIGJlY2F1c2UgZXZlcnkgcmVwZWF0IGhpdFxuICAvLyB0aGUgc2FtZSBzbGVlcGluZyB0aW1lci4gQSB0YWlsIHNwZW5kcyBtb3N0IG9mIGEgZGVhZCBkYWVtb24ncyBsaWZldGltZVxuICAvLyBpbnNpZGUgdGhpcyBzbGVlcCwgc28gdGhhdCBpcyB0aGUgc3RhdGUgYSBodW1hbiBpbnRlcnJ1cHRzLlxuICBsZXQgc3RvcHBlZCA9IGZhbHNlO1xuICBsZXQgYXR0ZW1wdDogQWJvcnRDb250cm9sbGVyIHwgbnVsbCA9IG51bGw7XG4gIGxldCB3YWtlQmFja29mZjogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG4gIGNvbnN0IHN0b3AgPSAoZXhpdENvZGU6IG51bWJlcikgPT4ge1xuICAgIHN0b3BwZWQgPSB0cnVlO1xuICAgIGNvZGUgPSBleGl0Q29kZTtcbiAgICBhdHRlbXB0Py5hYm9ydCgpO1xuICAgIHdha2VCYWNrb2ZmPy4oKTtcbiAgfTtcblxuICAvKiogU2xlZXAsIGJ1dCByZXR1cm4gQVQgT05DRSBpZiB0aGUgdGFpbCBpcyBzdG9wcGVkIG1lYW53aGlsZS4gKi9cbiAgY29uc3QgYmFja29mZiA9IChtczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiA9PlxuICAgIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlU2xlZXApID0+IHtcbiAgICAgIGlmIChzdG9wcGVkKSByZXR1cm4gcmVzb2x2ZVNsZWVwKCk7XG4gICAgICBjb25zdCBmaW5pc2ggPSAoKSA9PiB7XG4gICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgIHdha2VCYWNrb2ZmID0gbnVsbDtcbiAgICAgICAgcmVzb2x2ZVNsZWVwKCk7XG4gICAgICB9O1xuICAgICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KGZpbmlzaCwgbXMpO1xuICAgICAgd2FrZUJhY2tvZmYgPSBmaW5pc2g7XG4gICAgfSk7XG5cbiAgY29uc3Qgb25TaWduYWwgPSAoKSA9PiBzdG9wKDApO1xuICBjb25zdCB1c2VTaWduYWxzID0gb3B0cy5zaWduYWxzICE9PSBmYWxzZTtcbiAgaWYgKHVzZVNpZ25hbHMpIHtcbiAgICBwcm9jZXNzLm9uKFwiU0lHSU5UXCIsIG9uU2lnbmFsKTtcbiAgICBwcm9jZXNzLm9uKFwiU0lHVEVSTVwiLCBvblNpZ25hbCk7XG4gIH1cblxuICAvLyBBIGRvd25zdHJlYW0gYGhlYWRgL3JlYWRlciBjbG9zaW5nIG91ciBzdGRvdXQgaXMgYSBjb21wbGV0ZWQgcmVhZCwgbm90IGFcbiAgLy8gY3Jhc2g6IGVuZCBhdCAwIGluc3RlYWQgb2YgZHlpbmcgb24gRVBJUEUuXG4gIGNvbnN0IG9uT3V0RXJyb3IgPSAoZTogdW5rbm93bikgPT4ge1xuICAgIGlmICgoZSBhcyBOb2RlSlMuRXJybm9FeGNlcHRpb24gfCB1bmRlZmluZWQpPy5jb2RlID09PSBcIkVQSVBFXCIpIHN0b3AoMCk7XG4gIH07XG4gIGNvbnN0IG91dEVtaXR0ZXIgPSBvdXQgYXMgdW5rbm93biBhcyB7XG4gICAgb24/OiAoZXY6IHN0cmluZywgZm46IChlOiB1bmtub3duKSA9PiB2b2lkKSA9PiB2b2lkO1xuICAgIG9mZj86IChldjogc3RyaW5nLCBmbjogKGU6IHVua25vd24pID0+IHZvaWQpID0+IHZvaWQ7XG4gIH07XG4gIG91dEVtaXR0ZXIub24/LihcImVycm9yXCIsIG9uT3V0RXJyb3IpO1xuXG4gIGNvbnN0IG9uQ2FsbGVyQWJvcnQgPSAoKSA9PiBzdG9wKDApO1xuICBvcHRzLnNpZ25hbD8uYWRkRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQ2FsbGVyQWJvcnQpO1xuICBpZiAob3B0cy5zaWduYWw/LmFib3J0ZWQpIHN0b3AoMCk7XG5cbiAgY29uc3QgZW1pdCA9IChsaW5lOiBzdHJpbmcpID0+IHtcbiAgICBvdXQud3JpdGUoYCR7bGluZX1cXG5gKTtcbiAgfTtcbiAgLyoqIEV2ZXJ5IGRpYWdub3N0aWMgdGhlIGNsaWVudCBwcm9kdWNlcyBnb2VzIGhlcmUgYW5kIE5PV0hFUkUgZWxzZSwgc28gYVxuICAgKiAgY2FsbGVyIHBhcnNpbmcgb3VyIHN0ZG91dCBuZXZlciBtZWV0cyBhIG5vdGUgYWJvdXQgb3VyIHN0ZG91dC4gKi9cbiAgY29uc3Qgbm90ZSA9IChsaW5lOiBzdHJpbmcgfCBudWxsIHwgdW5kZWZpbmVkKSA9PiB7XG4gICAgaWYgKGxpbmUgIT09IG51bGwgJiYgbGluZSAhPT0gdW5kZWZpbmVkKSBlcnIud3JpdGUoYCR7bGluZX1cXG5gKTtcbiAgfTtcblxuICB0cnkge1xuICAgIHdoaWxlICghc3RvcHBlZCkge1xuICAgICAgLy8g4pqgIERFTElCRVJBVEVMWSBVTkdVQVJERUQuIGByZXNvbHZlYCBtYXkgc3Bhd24sIHByb2JlLCBvciByYWlzZSBhXG4gICAgICAvLyB0YXhvbm9teSBmYWlsdXJlLCBhbmQgdGhhdCB0aHJvdyBpcyB0aGUgQ0FMTEVSJ3MgdG8gYW5zd2VyIOKAlCB3aGljaCBpc1xuICAgICAgLy8gc3RyaWN0bHkgYmV0dGVyIHRoYW4gdGhlIGNvcGllcycgc2hhcGUsIHdoZXJlIGEgYGRpZWAgd2FzIHJlYWNoYWJsZVxuICAgICAgLy8gZnJvbSBpbnNpZGUgYSByZWNvbm5lY3QgbG9vcCBhbmQgZW5kZWQgdGhlIHByb2Nlc3MgZnJvbSB0aHJlZSBmcmFtZXNcbiAgICAgIC8vIGRvd24uXG4gICAgICBjb25zdCBiYXNlID0gYXdhaXQgb3B0cy5yZXNvbHZlKCk7XG4gICAgICBpZiAoYmFzZSA9PT0gbnVsbCkge1xuICAgICAgICBjb25zdCB2ZXJkaWN0ID0gb3B0cy5vblVucmVzb2x2ZWQ/Lih7IGV2ZXJSZXNvbHZlZCwgZXZlckNvbm5lY3RlZCB9KSA/PyBcInJldHJ5XCI7XG4gICAgICAgIGlmICh2ZXJkaWN0ID09PSBcInN0b3BcIikgcmV0dXJuIGNvZGU7XG4gICAgICAgIGF3YWl0IGJhY2tvZmYoZGVsYXkpO1xuICAgICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGV2ZXJSZXNvbHZlZCA9IHRydWU7XG5cbiAgICAgIGNvbnN0IHBhcmFtcyA9IG9wdHMucXVlcnk/LihjdXJzb3IsIGZpcnN0Q29ubmVjdCkgPz8geyBzaW5jZTogU3RyaW5nKGN1cnNvcikgfTtcbiAgICAgIGNvbnN0IHFzID0gbmV3IFVSTFNlYXJjaFBhcmFtcyhwYXJhbXMpLnRvU3RyaW5nKCk7XG4gICAgICBjb25zdCB1cmwgPSBgJHtiYXNlfSR7b3B0cy5wYXRofSR7cXMgPyBgPyR7cXN9YCA6IFwiXCJ9YDtcblxuICAgICAgYXR0ZW1wdCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgICAgIGNvbnN0IGNvbnRyb2xsZXIgPSBhdHRlbXB0O1xuICAgICAgbGV0IHdhdGNoZG9nOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xuICAgICAgY29uc3QgcmVzZXRXYXRjaGRvZyA9ICgpID0+IHtcbiAgICAgICAgaWYgKGlkbGVNcyA8PSAwKSByZXR1cm47XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgd2F0Y2hkb2cgPSBzZXRUaW1lb3V0KCgpID0+IGNvbnRyb2xsZXIuYWJvcnQoKSwgaWRsZU1zKTtcbiAgICAgIH07XG5cbiAgICAgIC8vIOKblCBUSEUgVFJZIElTIEFST1VORCBUSEUgVFJBTlNQT1JUIENBTExTIE9OTFkg4oCUIGBmZXRjaGAgYW5kXG4gICAgICAvLyBgcmVhZGVyLnJlYWQoKWAg4oCUIGFuZCBORVZFUiBhcm91bmQgdGhlIGNhbGxlcidzIGhvb2tzLiBBIGJsYW5rZXRcbiAgICAgIC8vIHRyeS9jYXRjaCBoZXJlIHJlYWRzIGEgaG9vaydzIHRocm93IGFzIGEgZHJvcHBlZCBjb25uZWN0aW9uIGFuZFxuICAgICAgLy8gcmVjb25uZWN0cyBmb3JldmVyOiB0aGUgdGFpbCBzcGlucyBzaWxlbnRseSBvbiBhbiBlcnJvciBub2JvZHkgY2FuXG4gICAgICAvLyBzZWUsIHdoaWNoIGlzIHRoZSBleGFjdCBmYWlsdXJlIHRoaXMgY2xpZW50IGV4aXN0cyB0byBtYWtlXG4gICAgICAvLyB1bnJlYWNoYWJsZS4gKENhdWdodCBieSBpdHMgb3duIHRlc3Q6IGEgcmVmdXNhbCBob29rIHRoYXQgdGhyb3dzIGh1bmdcbiAgICAgIC8vIHRoZSBzdWl0ZSB1bnRpbCB0aGUgY2F0Y2ggd2FzIG5hcnJvd2VkLilcbiAgICAgIGxldCByZXM6IFJlc3BvbnNlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmVzID0gYXdhaXQgZmV0Y2godXJsLCB7IHNpZ25hbDogY29udHJvbGxlci5zaWduYWwgfSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgYXR0ZW1wdCA9IG51bGw7XG4gICAgICAgIGlmIChzdG9wcGVkKSBicmVhaztcbiAgICAgICAgbm90ZShvcHRzLm9uRGlzY29ubmVjdD8uKHsgY2F1c2U6IFwiY29ubmVjdC1mYWlsZWRcIiwgZXJyb3I6IGUgfSkpO1xuICAgICAgICBhd2FpdCBiYWNrb2ZmKGRlbGF5KTtcbiAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIGlmICghcmVzLm9rKSB7XG4gICAgICAgICAgLy8gTWF5IHRocm93IOKAlCBhIHR5cGVkIHJlZnVzYWwgaXMgYSB1c2FnZSBlcnJvciwgbm90IGEgYmxpcC5cbiAgICAgICAgICBhd2FpdCBvcHRzLm9uSHR0cEVycm9yPy4ocmVzKTtcbiAgICAgICAgICAvLyDim5QgQ0FOQ0VMIFRIRSBCT0RZIEJFRk9SRSBMT09QSU5HLiBBbiB1bnJlYWQgcmVzcG9uc2UgYm9keSBob2xkcyBhXG4gICAgICAgICAgLy8gc3RyZWFtIG9wZW4sIGFuZCB0aGlzIGJyYW5jaCBydW5zIG9uY2UgcGVyIGZhaWxlZCBhdHRlbXB0IGZvciBhc1xuICAgICAgICAgIC8vIGxvbmcgYXMgdGhlIGRhZW1vbiBpcyB1bmhhcHB5IOKAlCB3aGljaCBpcyBleGFjdGx5IHRoZSBsb25nLXJ1bm5pbmdcbiAgICAgICAgICAvLyBjYXNlLiBUaGUgaG9vayBtYXkgYWxyZWFkeSBoYXZlIHJlYWQgaXQ7IGNhbmNlbCBpcyBhIG5vLW9wIHRoZW4uXG4gICAgICAgICAgYXdhaXQgcmVzLmJvZHk/LmNhbmNlbCgpLmNhdGNoKCgpID0+IHt9KTtcbiAgICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJodHRwXCIsIHN0YXR1czogcmVzLnN0YXR1cyB9KSk7XG4gICAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXJlcy5ib2R5KSB7XG4gICAgICAgICAgLy8g4puUIEEgMjAwIFdJVEggTk8gQk9EWSBNVVNUIEdST1cgVEhFIEJBQ0tPRkYgbGlrZSBldmVyeSBvdGhlciBmYWlsZWRcbiAgICAgICAgICAvLyBhdHRlbXB0LiBPbmUgc3BlbGwgc3BsaXQgdGhpcyBndWFyZCBmcm9tIGl0cyBzaWJsaW5nIGFuZCB0aGUgc2Vjb25kXG4gICAgICAgICAgLy8gaGFsZiBsb3N0IHRoZSBncm93dGggbGluZSDigJQgYSByZWNvbm5lY3Qgc3Rvcm0gYXQgYSBjb25zdGFudCAyNTBtcy5cbiAgICAgICAgICBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJuby1ib2R5XCIsIHN0YXR1czogcmVzLnN0YXR1cyB9KSk7XG4gICAgICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICAgICAgZGVsYXkgPSBNYXRoLm1pbihkZWxheSAqIDIsIHJldHJ5Lm1heE1zKTtcbiAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGV2ZXJDb25uZWN0ZWQgPSB0cnVlO1xuICAgICAgICBmaXJzdENvbm5lY3QgPSBmYWxzZTtcbiAgICAgICAgcmVzZXRXYXRjaGRvZygpO1xuXG4gICAgICAgIGNvbnN0IHJlYWRlciA9IHJlcy5ib2R5LmdldFJlYWRlcigpO1xuICAgICAgICBjb25zdCBkZWNvZGVyID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgICAgIGxldCBidWYgPSBcIlwiO1xuXG4gICAgICAgIHdoaWxlICghc3RvcHBlZCkge1xuICAgICAgICAgIGxldCBjaHVuazogQXdhaXRlZDxSZXR1cm5UeXBlPHR5cGVvZiByZWFkZXIucmVhZD4+O1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjaHVuayA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgLy8gV2F0Y2hkb2cgYWJvcnQsIGNhbGxlciBhYm9ydCwgb3IgYSBkcm9wcGVkIGNvbm5lY3Rpb24uIEFsbCB0aHJlZVxuICAgICAgICAgICAgLy8gbWVhbiB0aGUgc2FtZSB0aGluZyBoZXJlOiB0aGlzIGF0dGVtcHQgaXMgb3ZlciwgcmVjb25uZWN0IGJlbG93LlxuICAgICAgICAgICAgaWYgKCFzdG9wcGVkKSBub3RlKG9wdHMub25EaXNjb25uZWN0Py4oeyBjYXVzZTogXCJzdHJlYW0tZXJyb3JcIiwgZXJyb3I6IGUgfSkpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChjaHVuay5kb25lKSB7XG4gICAgICAgICAgICBpZiAoIXN0b3BwZWQpIG5vdGUob3B0cy5vbkRpc2Nvbm5lY3Q/Lih7IGNhdXNlOiBcInN0cmVhbS1lbmRcIiB9KSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8g4puUIFRIRSBCQUNLT0ZGIFJFU0VUUyBPTiBUSEUgRklSU1QgQllURSwgTk9UIE9OIEEgU1VDQ0VTU0ZVTCBPUEVOIOKAlFxuICAgICAgICAgIC8vIGFuZCB0aGF0IGlzIFdJREVSIHRoYW4gdGhlIGRlZmVjdCBpdCB3YXMgd3JpdHRlbiBmb3IuIEI1IGlzXG4gICAgICAgICAgLy8gcmVjb3JkZWQgYXMgXCJhIDIwMCB3aXRoIG5vIGJvZHkgc2xlZXBzIHdpdGhvdXQgZ3Jvd2luZyB0aGVcbiAgICAgICAgICAvLyBiYWNrb2ZmXCI7IHJlc2V0dGluZyBhdCB0aGUgb3BlbiBoYXMgdGhlIHNhbWUgc2hhcGUgZm9yIEFOWVxuICAgICAgICAgIC8vIGNvbm5lY3Rpb24gdGhhdCBpcyBhY2NlcHRlZCBhbmQgdGhlbiB5aWVsZHMgbm90aGluZywgd2hpY2ggaXMgd2hhdFxuICAgICAgICAgIC8vIGEgZGFlbW9uIG1pZC1yZXN0YXJ0IGRvZXMuIERyaXZlbjogcmVzZXQtYXQtb3BlbiBnaXZlcyBhIGNvbnN0YW50XG4gICAgICAgICAgLy8gNDFtcyByZWNvbm5lY3QgYWdhaW5zdCBhIHNlcnZlciB0aGF0IGFjY2VwdHMgYW5kIGNsb3NlczsgcmVzZXQtYXQtXG4gICAgICAgICAgLy8gZmlyc3QtYnl0ZSBnaXZlcyA0MCwgODAsIDE2MC4gQSBieXRlIGlzIHRoZSBvbmx5IGV2aWRlbmNlIHRoZVxuICAgICAgICAgIC8vIGRhZW1vbiBpcyBhY3R1YWxseSB0YWxraW5nIHRvIHVzLlxuICAgICAgICAgIGRlbGF5ID0gcmV0cnkuaW5pdGlhbE1zO1xuICAgICAgICAgIC8vIOKblCBCRUZPUkUgRlJBTUUgUEFSU0lORy4gQSBrZWVwYWxpdmUgY29tbWVudCBjYXJyaWVzIG5vIGRhdGEgYW5kIGlzXG4gICAgICAgICAgLy8gZGlzY2FyZGVkIHdoZW4gZGF0YSBmcmFtZXMgYXJlIHNlbGVjdGVkIGJlbG93LCBidXQgaXQgaXMgdGhlIHByb29mIHRoZSBzb2NrZXQgaXNcbiAgICAgICAgICAvLyBhbGl2ZSDigJQgZmVlZGluZyB0aGUgd2F0Y2hkb2cgb25seSBvbiBEQVRBIGFib3J0cyBldmVyeSBoZWFsdGh5IGJ1dFxuICAgICAgICAgIC8vIHF1aWV0IGNvbm5lY3Rpb24uXG4gICAgICAgICAgcmVzZXRXYXRjaGRvZygpO1xuICAgICAgICAgIGJ1ZiArPSBkZWNvZGVyLmRlY29kZShjaHVuay52YWx1ZSwgeyBzdHJlYW06IHRydWUgfSk7XG5cbiAgICAgICAgICBmb3IgKGxldCBzZXAgPSBidWYuaW5kZXhPZihcIlxcblxcblwiKTsgc2VwID49IDA7IHNlcCA9IGJ1Zi5pbmRleE9mKFwiXFxuXFxuXCIpKSB7XG4gICAgICAgICAgICBjb25zdCBibG9jayA9IGJ1Zi5zbGljZSgwLCBzZXApO1xuICAgICAgICAgICAgYnVmID0gYnVmLnNsaWNlKHNlcCArIDIpO1xuICAgICAgICAgICAgY29uc3QgeyBmcmFtZSwgY29tbWVudHMgfSA9IHBhcnNlU3NlRnJhbWUoYmxvY2spO1xuICAgICAgICAgICAgZm9yIChjb25zdCB0ZXh0IG9mIGNvbW1lbnRzKSBub3RlKG9wdHMub25Db21tZW50Py4odGV4dCkpO1xuICAgICAgICAgICAgaWYgKCFmcmFtZSkgY29udGludWU7XG5cbiAgICAgICAgICAgIGxldCBldjogRXY7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBldiA9IEpTT04ucGFyc2UoZnJhbWUuZGF0YSkgYXMgRXY7XG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgIG5vdGUob3B0cy5vbk1hbGZvcm1lZD8uKGZyYW1lLCBlKSk7XG4gICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAob3B0cy5lcG9jaE9mKSB7XG4gICAgICAgICAgICAgIGNvbnN0IG5leHQgPSBvcHRzLmVwb2NoT2YoZXYpO1xuICAgICAgICAgICAgICBpZiAodHlwZW9mIG5leHQgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgICAgICAgICBpZiAoZXBvY2ggIT09IG51bGwgJiYgbmV4dCAhPT0gZXBvY2gpIHtcbiAgICAgICAgICAgICAgICAgIGN1cnNvciA9IDA7XG4gICAgICAgICAgICAgICAgICBjb25zdCBsaW5lID0gb3B0cy5vbkVwb2NoQ2hhbmdlPy4obmV4dCkgPz8gbnVsbDtcbiAgICAgICAgICAgICAgICAgIGlmIChsaW5lICE9PSBudWxsKSBlbWl0KGxpbmUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBlcG9jaCA9IG5leHQ7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8g4puUIFRIRSBDVVJTT1IgQURWQU5DRVMgT04gRVZFUlkgRVZFTlQsIElOQ0xVRElORyBBIEZJTFRFUkVEIE9ORS5cbiAgICAgICAgICAgIC8vIEEgc2NvcGUgcHJlZGljYXRlIGlzIGFib3V0IHdoYXQgdGhlIENBTExFUiByZWFkcywgbmV2ZXIgYWJvdXQgd2hhdFxuICAgICAgICAgICAgLy8gdGhlIGRhZW1vbiBoYXMgZGVsaXZlcmVkOyBhZHZhbmNpbmcgb25seSBvbiBlbWl0dGVkIGV2ZW50cyBtYWtlc1xuICAgICAgICAgICAgLy8gZXZlcnkgcmVjb25uZWN0IHJlLXJlcXVlc3QgdGhlIGZpbHRlcmVkIG9uZXMgZm9yZXZlci5cbiAgICAgICAgICAgIGNvbnN0IG4gPSBvcHRzLmN1cnNvck9mPy4oZXYpO1xuICAgICAgICAgICAgaWYgKHR5cGVvZiBuID09PSBcIm51bWJlclwiICYmIE51bWJlci5pc0Zpbml0ZShuKSkge1xuICAgICAgICAgICAgICBjdXJzb3IgPSBjdXJzb3JQb2xpY3kgPT09IFwiYXNzaWduXCIgPyBuIDogTWF0aC5tYXgoY3Vyc29yLCBuKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29uc3QgYWNjZXB0ZWQgPSBvcHRzLmFjY2VwdD8uKGV2LCBmcmFtZSkgPz8gdHJ1ZTtcbiAgICAgICAgICAgIGNvbnN0IGlzVGVybWluYWwgPSBvcHRzLnRlcm1pbmFsPy4oZXYpID8/IGZhbHNlO1xuXG4gICAgICAgICAgICBpZiAoYWNjZXB0ZWQgfHwgKGlzVGVybWluYWwgJiYgb3B0cy50ZXJtaW5hbEVtaXRzRmlsdGVyZWQgPT09IHRydWUpKSB7XG4gICAgICAgICAgICAgIGNvbnN0IGxpbmUgPSBvcHRzLnJlbmRlciA/IG9wdHMucmVuZGVyKGV2LCBmcmFtZSkgOiBmcmFtZS5kYXRhO1xuICAgICAgICAgICAgICBpZiAobGluZSAhPT0gbnVsbCkgZW1pdChsaW5lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChpc1Rlcm1pbmFsKSByZXR1cm4gY29kZTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0gZmluYWxseSB7XG4gICAgICAgIGlmICh3YXRjaGRvZyAhPT0gbnVsbCkgY2xlYXJUaW1lb3V0KHdhdGNoZG9nKTtcbiAgICAgICAgYXR0ZW1wdCA9IG51bGw7XG4gICAgICB9XG5cbiAgICAgIGlmIChzdG9wcGVkKSBicmVhaztcbiAgICAgIC8vIOKblCBBTkQgVEhFIEdST1dUSCBMSU5FIEJFTE9OR1MgSEVSRSBUT08uIEV2ZXJ5IGBjb250aW51ZWAgYWJvdmUgZ3Jvd3NcbiAgICAgIC8vIHRoZSBkZWxheTsgdGhlIHBhdGggdGhhdCBmYWxscyB0aHJvdWdoIOKAlCBhIGNvbm5lY3Rpb24gdGhhdCBPUEVORUQgYW5kXG4gICAgICAvLyB0aGVuIGVuZGVkIOKAlCBkaWQgbm90LCBpbiBhbnkgb2YgdGhlIHNldmVuIGhhbmQtd3JpdHRlbiBsb29wcy4gQWdhaW5zdCBhXG4gICAgICAvLyBkYWVtb24gdGhhdCBhY2NlcHRzIGFuZCBpbW1lZGlhdGVseSBjbG9zZXMsIHRoYXQgaXMgYSByZWNvbm5lY3QgYXQgYVxuICAgICAgLy8gY29uc3RhbnQgMjUwbXMgZm9yIGFzIGxvbmcgYXMgaXQgc3RheXMgc2ljaywgd2hpY2ggaXMgQjUncyBzaGFwZVxuICAgICAgLy8gcmVhY2hlZCBieSBhIGRpZmZlcmVudCBkb29yLiBUaGUgcmVzZXQgb24gdGhlIGZpcnN0IGJ5dGUgKGFib3ZlKSBpc1xuICAgICAgLy8gd2hhdCBrZWVwcyB0aGlzIGZyb20gc2xvd2luZyBhIGhlYWx0aHkgdGFpbCBkb3duLlxuICAgICAgYXdhaXQgYmFja29mZihkZWxheSk7XG4gICAgICBkZWxheSA9IE1hdGgubWluKGRlbGF5ICogMiwgcmV0cnkubWF4TXMpO1xuICAgIH1cbiAgICByZXR1cm4gY29kZTtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAodXNlU2lnbmFscykge1xuICAgICAgcHJvY2Vzcy5vZmYoXCJTSUdJTlRcIiwgb25TaWduYWwpO1xuICAgICAgcHJvY2Vzcy5vZmYoXCJTSUdURVJNXCIsIG9uU2lnbmFsKTtcbiAgICB9XG4gICAgb3V0RW1pdHRlci5vZmY/LihcImVycm9yXCIsIG9uT3V0RXJyb3IpO1xuICAgIG9wdHMuc2lnbmFsPy5yZW1vdmVFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25DYWxsZXJBYm9ydCk7XG4g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LE1BQU0sUUFBUSxTQUFTO0FBQUEsUUFDckIsTUFBTTtBQUFBLFFBQ04sTUFBTSxJQUFJLE9BQU87QUFBQSxRQUNqQixNQUFNLElBQUksTUFBTSxDQUFDLEVBQUUsS0FBSyxHQUFHO0FBQUEsTUFDN0IsQ0FBQztBQUFBLE1BQ0Q7QUFBQSxTQUNHO0FBQUEsTUFDSCxJQUFJLENBQUMsSUFBSTtBQUFBLFFBQVEsSUFBSSwyQkFBMkI7QUFBQSxNQUNoRCxNQUFNLFVBQVUsU0FBUyxJQUFJLEVBQUU7QUFBQSxNQUMvQjtBQUFBLFNBQ0c7QUFBQSxNQUNILE1BQU0sWUFBWSxPQUFPO0FBQUEsTUFDekI7QUFBQSxTQUNHO0FBQUEsTUFDSCxNQUFNLFdBQVcsU0FBUyxLQUFLO0FBQUEsTUFDL0I7QUFBQSxTQUNHO0FBQUEsTUFDSCxNQUFNLFVBQVUsU0FBUyxLQUFLO0FBQUEsTUFDOUI7QUFBQSxTQUNHO0FBQUEsTUFDSCxNQUFNLGNBQWMsU0FBUyxLQUFLO0FBQUEsTUFDbEM7QUFBQSxTQUNHO0FBQUEsTUFDSCxJQUFJLENBQUMsSUFBSTtBQUFBLFFBQVEsSUFBSSw0QkFBNEI7QUFBQSxNQUNqRCxNQUFNLFFBQVEsU0FBUyxFQUFFLE1BQU0sa0JBQWtCLElBQUksSUFBSSxHQUFHLENBQUM7QUFBQSxNQUM3RDtBQUFBLFNBQ0csT0FBTztBQUFBLE1BR1YsTUFBTSxNQUFNLE1BQU0sVUFBVSxPQUFPLE1BQU0sVUFBVSxJQUFJLElBQUksS0FBSyxHQUFHO0FBQUEsTUFDbkUsSUFBSSxDQUFDO0FBQUEsUUFBSyxJQUFJLHFEQUFxRDtBQUFBLE1BQ25FLElBQUk7QUFBQSxNQUNKLElBQUk7QUFBQSxRQUNGLE9BQU8sS0FBSyxNQUFNLEdBQUc7QUFBQSxRQUNyQixNQUFNO0FBQUEsUUFDTixJQUFJLDZCQUE2QjtBQUFBO0FBQUEsTUFFbkMsTUFBTSxRQUFRLFNBQVMsSUFBSTtBQUFBLE1BQzNCO0FBQUEsSUFDRjtBQUFBLFNBQ0s7QUFBQSxNQUNILE1BQU0sUUFBUSxTQUFTLEVBQUUsTUFBTSxRQUFRLENBQUM7QUFBQSxNQUN4QztBQUFBLFNBQ0c7QUFBQSxNQUNILFFBQVEsT0FBTztBQUFBLE1BQ2Y7QUFBQSxTQUNHO0FBQUEsTUFDSCxZQUFZO0FBQUEsTUFDWjtBQUFBLFNBQ0c7QUFBQSxNQUNILFFBQVEsT0FBTyxNQUFNLEdBQUc7QUFBQSxDQUFRO0FBQUEsTUFDaEM7QUFBQTtBQUFBLE1BT0EsSUFBSSx3QkFBd0IsU0FBUyxVQUFVO0FBQUE7QUFBQSxFQUduRCxPQUFPO0FBQUE7QUFHVCxJQUFJLGtCQUFrQjtBQUFBLEVBUXBCLFFBQVEsV0FBVyxNQUFNLEtBQUssUUFBUSxLQUFLLE1BQU0sQ0FBQyxDQUFDO0FBQ3JEO0FBaUJBLGVBQXNCLEdBQUcsR0FBb0I7QUFBQSxFQUMzQyxPQUFPLE1BQU0sS0FBSyxRQUFRLEtBQUssTUFBTSxDQUFDLENBQUM7QUFBQTsiLAogICJkZWJ1Z0lkIjogIkRDQ0U5RjhCQzg0NEEzMkY2NDc1NkUyMTY0NzU2RTIxIiwKICAibmFtZXMiOiBbXQp9
