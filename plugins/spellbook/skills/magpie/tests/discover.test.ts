// Focused unit tests for the settled discover port. No real API call — the
// network is exercised only through a mocked global fetch. Covers:
//   - normalizedToPixel: Gemini [0..1000] [y,x,y,x] → clamped pixel [x1,y1,x2,y2]
//   - parseBboxes: fenced ```json ``` stripping + plain JSON
//   - elementsFromRaw: name/box filtering + bbox attach
//   - discover(): end-to-end shape over a mocked OpenRouter response

import { afterEach, expect, test } from "bun:test";
import {
  DiscoverError,
  discover,
  elementsFromRaw,
  normalizedToPixel,
  parseBboxes,
} from "../scripts/discover";

// ── normalizedToPixel ────────────────────────────────────────────────────────

test("normalizedToPixel converts [y,x,y,x]/1000 to pixel [x1,y1,x2,y2]", () => {
  // a box spanning the middle of a 1000×500 image
  expect(normalizedToPixel([250, 100, 750, 900], 1000, 500)).toEqual([100, 125, 900, 375]);
});

test("normalizedToPixel clamps to image bounds and rounds", () => {
  // x2/y2 above 1000 clamp to width/height; negatives clamp to 0
  expect(normalizedToPixel([0, 0, 1000, 1000], 1408, 768)).toEqual([0, 0, 1408, 768]);
  // rounding: 43/1000*1408 = 60.5 → 61 ; 675/1000*768 = 518.4 → 518
  expect(normalizedToPixel([675, 43, 789, 101], 1408, 768)).toEqual([61, 518, 142, 606]);
});

// ── parseBboxes (fenced JSON) ────────────────────────────────────────────────

test("parseBboxes parses a plain JSON array", () => {
  const out = parseBboxes('[{"name":"a","type":"icon","box_2d":[0,0,10,10]}]');
  expect(out).toHaveLength(1);
  expect((out[0] as { name: string }).name).toBe("a");
});

test("parseBboxes strips a ```json fence", () => {
  const fenced = '```json\n[{"name":"b","type":"sticker","box_2d":[1,2,3,4]}]\n```';
  const out = parseBboxes(fenced);
  expect((out[0] as { type: string }).type).toBe("sticker");
});

test("parseBboxes strips a bare ``` fence (no language tag)", () => {
  const fenced = '```\n[{"name":"c","type":"other","box_2d":[0,0,1,1]}]\n```';
  expect(parseBboxes(fenced)).toHaveLength(1);
});

test("parseBboxes throws on non-JSON", () => {
  expect(() => parseBboxes("not json at all")).toThrow();
});

// ── elementsFromRaw ──────────────────────────────────────────────────────────

test("elementsFromRaw attaches bbox_pixel and keeps box_2d", () => {
  const raw = [{ name: "icon_mammoth", type: "icon", box_2d: [675, 43, 789, 101] }];
  const els = elementsFromRaw(raw, 1408, 768);
  expect(els).toHaveLength(1);
  expect(els[0]).toEqual({
    name: "icon_mammoth",
    type: "icon",
    box_2d: [675, 43, 789, 101],
    bbox_pixel: [61, 518, 142, 606],
  });
});

test("elementsFromRaw skips entries missing a name or box (matches the Python original)", () => {
  const raw = [
    { type: "icon", box_2d: [0, 0, 1, 1] }, // no name → skip
    { name: "ok", type: "icon", box_2d: [0, 0, 1, 1] },
    { name: "nobox", type: "icon" }, // no box → skip
  ];
  const els = elementsFromRaw(raw, 100, 100);
  expect(els.map((e) => e.name)).toEqual(["ok"]);
});

test("elementsFromRaw defaults a missing type to 'other'", () => {
  const els = elementsFromRaw([{ name: "x", box_2d: [0, 0, 1, 1] }], 10, 10);
  expect(els[0].type).toBe("other");
});

// ── discover() end-to-end over a mocked fetch ────────────────────────────────

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// A tiny 2×2 PNG so Bun.Image can read real metadata (discover measures the
// source itself). 2×2 keeps the pixel math trivial to assert.
const PNG_2x2 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGNk+M+ABzAxMBAAAB0EAQHfQ3UvAAAAAElFTkSuQmCC";

async function writeTempPng(): Promise<string> {
  const path = `${import.meta.dir}/.tmp-discover-${crypto.randomUUID()}.png`;
  await Bun.write(path, Buffer.from(PNG_2x2, "base64"));
  return path;
}

test("discover assembles a manifest from a mocked OpenRouter response", async () => {
  const path = await writeTempPng();
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: '```json\n[{"name":"logo","type":"wordmark","box_2d":[0,0,500,1000]}]\n```',
            },
          },
        ],
        usage: {
          cost: 0.0123,
          prompt_tokens: 100,
          completion_tokens: 50,
          completion_tokens_details: { reasoning_tokens: 20 },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  try {
    const manifest = await discover(path, { apiKey: "test-key" });
    expect(manifest.source_size).toEqual([2, 2]);
    expect(manifest.source_sha256_16).toHaveLength(16);
    expect(manifest.model).toBe("google/gemini-3.5-flash");
    expect(manifest.cost_usd).toBe(0.0123);
    expect(manifest.tokens).toEqual({ prompt: 100, completion: 50, reasoning: 20 });
    expect(manifest.elements).toHaveLength(1);
    // box [0,0,500,1000] on a 2×2 image → x:[0..2], y:[0..1]
    expect(manifest.elements[0].bbox_pixel).toEqual([0, 0, 2, 1]);
  } finally {
    await Bun.file(path)
      .delete()
      .catch(() => {});
  }
});

test("discover fails fast (DiscoverError) when OPENROUTER_API_KEY is unset", async () => {
  const path = await writeTempPng();
  const prev = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    await expect(discover(path)).rejects.toBeInstanceOf(DiscoverError);
  } finally {
    if (prev !== undefined) process.env.OPENROUTER_API_KEY = prev;
    await Bun.file(path)
      .delete()
      .catch(() => {});
  }
});

test("discover surfaces an HTTP error as a DiscoverError", async () => {
  const path = await writeTempPng();
  globalThis.fetch = (async () => new Response("rate limited", { status: 429 })) as typeof fetch;
  try {
    await expect(discover(path, { apiKey: "k" })).rejects.toBeInstanceOf(DiscoverError);
  } finally {
    await Bun.file(path)
      .delete()
      .catch(() => {});
  }
});
