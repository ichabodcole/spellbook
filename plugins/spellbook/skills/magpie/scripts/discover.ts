#!/usr/bin/env bun
// magpie — discover phase. The canonical element-discovery implementation.
//
// Calls Gemini 3.5 Flash via OpenRouter on a moodboard / branding board image,
// asks the model to identify every distinct extractable visual element, and
// returns a manifest (name + type + source-pixel bbox per element, + cost/tokens).
// A plain function module the daemon/cli call; a small CLI entry lives at the
// bottom. (Ported from an earlier Python original, since removed.)

import { dirname, extname, join, resolve } from "node:path";
import type { Bbox, ElementType } from "../surface/state/types";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export const DEFAULT_MODEL = "google/gemini-3.5-flash";

// Copied verbatim from the Python original's PROMPT (the discovery instruction).
export const PROMPT = `Identify every distinct extractable visual element in this image. "Distinct extractable" means: a single visually-coherent asset a designer would want to pull out as its own file — a logo, an icon, a sticker, a color swatch row, a piece of cover art, a UI screenshot. Do NOT include background, texture, or surrounding canvas.

For each element, return a bounding box using Google's normalized coordinate system (image is [0, 1000] on both axes, 0,0 top-left) in the documented order: [y_min, x_min, y_max, x_max].

Return ONLY a JSON array, no prose, in this exact shape:
[
  {"name": "<short_snake_case_name>", "type": "<one of: wordmark, tagline, icon, illustration, sticker, palette, typography, screenshot, other>", "box_2d": [y_min, x_min, y_max, x_max]}
]

Naming rules:
- Use distinctive snake_case names; if there are multiple of the same kind, differentiate descriptively (icon_mammoth, icon_gear, sticker_coffee, sticker_skateboard).
- The \`type\` field is critical — the extract step uses it to decide whether to run background removal.
`;

// OpenRouter vision endpoints reject very large payloads with a non-actionable
// 4xx; bail with a clearer error first (matches the Python original).
export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
export const WARN_IMAGE_BYTES = 15 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

// ── manifest schema (mirrors the Python manifest) ──
export type ManifestElement = {
  name: string;
  type: ElementType;
  box_2d: number[]; // Gemini's normalized [y_min, x_min, y_max, x_max], 0..1000
  bbox_pixel: Bbox; // [x1, y1, x2, y2] in source pixels (used by extract)
};
export type Manifest = {
  source: string;
  source_size: [number, number];
  source_sha256_16: string;
  model: string;
  cost_usd: number;
  tokens: { prompt: number; completion: number; reasoning: number };
  elements: ManifestElement[];
};

// Raised for actionable user-facing failures (bad image size, missing key, HTTP
// error). The CLI entry maps it to a clean stderr line + exit code.
export class DiscoverError extends Error {}

// ── pure helpers (unit-tested; no network/disk) ──

// Strip optional ```json fences and parse the JSON array. Mirrors
// the Python original's parse_bboxes.
export function parseBboxes(content: string): unknown[] {
  let s = content.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(s);
  if (fence) s = fence[1];
  return JSON.parse(s);
}

// Convert Gemini's [y_min, x_min, y_max, x_max] (0..1000) to source pixels
// [x1, y1, x2, y2], clamped to image bounds. Replicates the Python original's
// normalized_to_pixel formula exactly.
export function normalizedToPixel(box: number[], width: number, height: number): Bbox {
  const [y1, x1, y2, x2] = box;
  const px1 = Math.max(0, Math.round((x1 / 1000) * width));
  const py1 = Math.max(0, Math.round((y1 / 1000) * height));
  const px2 = Math.min(width, Math.round((x2 / 1000) * width));
  const py2 = Math.min(height, Math.round((y2 / 1000) * height));
  return [px1, py1, px2, py2];
}

// Build the manifest `elements[]` from the model's parsed array + image size.
// Skips entries missing a name or box (matches the Python original's filter).
export function elementsFromRaw(raw: unknown[], width: number, height: number): ManifestElement[] {
  const elements: ManifestElement[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const name = e.name;
    const kind = (typeof e.type === "string" ? e.type : "other") as ElementType;
    const box = e.box_2d;
    if (!name || typeof name !== "string" || !Array.isArray(box)) continue;
    elements.push({
      name,
      type: kind,
      box_2d: box as number[],
      bbox_pixel: normalizedToPixel(box as number[], width, height),
    });
  }
  return elements;
}

// ── image read + encode ──

export function mimeForPath(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? "image/png";
}

// Read an image file → a base64 data URL, enforcing the size guard. Throws
// DiscoverError above MAX_IMAGE_BYTES; warns (stderr) above WARN_IMAGE_BYTES.
export async function encodeImageDataUrl(path: string): Promise<string> {
  const file = Bun.file(path);
  const size = file.size;
  if (size > MAX_IMAGE_BYTES) {
    const mb = (size / 1_048_576).toFixed(1);
    const limit = Math.floor(MAX_IMAGE_BYTES / 1_048_576);
    throw new DiscoverError(
      `${path} is ${mb} MB, above the ${limit} MB limit. Resize before retrying ` +
        `(e.g. ImageMagick: \`magick in.png -resize 2000x2000\\> out.png\`).`,
    );
  }
  if (size > WARN_IMAGE_BYTES) {
    process.stderr.write(
      `WARN: ${path} is ${(size / 1_048_576).toFixed(1)} MB; large requests sometimes hit OpenRouter's payload limits.\n`,
    );
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const b64 = Buffer.from(bytes).toString("base64");
  return `data:${mimeForPath(path)};base64,${b64}`;
}

// Image pixel size via Bun.Image metadata (replaces the Python original's Pillow read).
export async function imageSize(path: string): Promise<[number, number]> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const meta = await new Bun.Image(bytes).metadata();
  return [meta.width ?? 0, meta.height ?? 0];
}

// First 16 chars of the file's sha256 (matches the Python original).
export async function sourceSha256_16(path: string): Promise<string> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 16);
}

// ── OpenRouter call ──

export async function callOpenRouter(
  apiKey: string,
  model: string,
  imageDataUrl: string,
  prompt: string,
): Promise<Record<string, unknown>> {
  const body = {
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ],
    temperature: 0,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180_000);
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/ichabodcole/spellbook",
        "X-Title": "magpie",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new DiscoverError(`OpenRouter HTTP ${res.status}: ${text}`);
    }
    return (await res.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

// ── orchestration ──

export type DiscoverOptions = { model?: string; apiKey?: string };

// Full discover: read image, call the model, parse, build the manifest. Throws
// DiscoverError on actionable failures (missing key, oversized image, HTTP /
// parse errors). The OPENROUTER_API_KEY must be in the environment — we never
// install a key.
export async function discover(imagePath: string, opts: DiscoverOptions = {}): Promise<Manifest> {
  const model = opts.model ?? DEFAULT_MODEL;
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new DiscoverError("OPENROUTER_API_KEY env var not set");
  }
  if (!(await Bun.file(imagePath).exists())) {
    throw new DiscoverError(`image not found: ${imagePath}`);
  }

  const [size, dataUrl, sha] = await Promise.all([
    imageSize(imagePath),
    encodeImageDataUrl(imagePath),
    sourceSha256_16(imagePath),
  ]);
  const [width, height] = size;

  const resp = await callOpenRouter(apiKey, model, dataUrl, PROMPT);

  const choices = resp.choices as Array<{ message?: { content?: unknown } }> | undefined;
  const content = choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new DiscoverError(
      `unexpected response shape from OpenRouter (no choices[0].message.content):\n${JSON.stringify(resp).slice(0, 2000)}`,
    );
  }

  const usage = (resp.usage as Record<string, unknown>) ?? {};
  const cost = typeof usage.cost === "number" ? usage.cost : 0;
  const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const completionTokens =
    typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  const details = (usage.completion_tokens_details as Record<string, unknown>) ?? {};
  const reasoningTokens =
    typeof details.reasoning_tokens === "number" ? details.reasoning_tokens : 0;

  let raw: unknown[];
  try {
    raw = parseBboxes(content);
  } catch (ex) {
    throw new DiscoverError(
      `model returned non-JSON output:\n${content}\n\nParse error: ${ex instanceof Error ? ex.message : String(ex)}`,
    );
  }

  return {
    source: resolve(imagePath),
    source_size: [width, height],
    source_sha256_16: sha,
    model,
    cost_usd: cost,
    tokens: { prompt: promptTokens, completion: completionTokens, reasoning: reasoningTokens },
    elements: elementsFromRaw(raw, width, height),
  };
}

// ── CLI entry (parity with the Python original) ──
async function main(argv: string[]): Promise<number> {
  const { parseArgs } = await import("node:util");
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        out: { type: "string" },
        model: { type: "string", default: DEFAULT_MODEL },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  const imagePath = parsed.positionals[0];
  if (!imagePath) {
    process.stderr.write("usage: discover.ts <image> [--out <manifest.json>] [--model <model>]\n");
    return 2;
  }
  try {
    const manifest = await discover(imagePath, { model: parsed.values.model as string });
    const out =
      (parsed.values.out as string | undefined) ??
      join(dirname(resolve(imagePath)), `${baseStem(imagePath)}-manifest.json`);
    await Bun.write(out, JSON.stringify(manifest, null, 2));
    process.stdout.write(
      `Discovered ${manifest.elements.length} element(s) — cost $${manifest.cost_usd.toFixed(4)}\n`,
    );
    for (const e of manifest.elements) {
      const [x1, y1, x2, y2] = e.bbox_pixel;
      process.stdout.write(`  ${e.type}  ${e.name}  src=(${x1},${y1},${x2},${y2})\n`);
    }
    process.stdout.write(`Manifest written: ${out}\n`);
    return 0;
  } catch (e) {
    if (e instanceof DiscoverError) {
      process.stderr.write(`ERROR: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

function baseStem(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
