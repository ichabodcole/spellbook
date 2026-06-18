// Pure state-merge / projection unit tests for imago's server contract.
//
// These exercise the synchronous, blob-free pieces of server.ts/types.ts with
// no subprocess — fast and deterministic:
//   - defaultState(title) shape (the seeded catalog + flags the surface relies on)
//   - leanState(s) strips the heavy data-url blobs (variant.src, ref.src,
//     style.image) while keeping the on-disk paths + metadata the agent reads
//   - optimizeSrc passes a non-data-url through unchanged

import { expect, test } from "bun:test";
import { leanState, optimizeSrc } from "../scripts/server.ts";
import { defaultState, type ImagoState } from "../surface/state/types";

// ── defaultState shape ─────────────────────────────────────────────────────

test("defaultState carries the title and empty artifact collections", () => {
  const s = defaultState("my session");
  expect(s.title).toBe("my session");
  expect(s.batches).toEqual([]);
  expect(s.focus).toBeNull();
  expect(s.conversation).toEqual([]);
  expect(s.pins).toEqual([]);
  // marksByVariant is the durable per-variant annotation map — empty object,
  // NOT undefined (the surface and server index into it directly).
  expect(s.marksByVariant).toEqual({});
  // layersByVariant is the per-variant layer-container map (container model) —
  // same empty-object invariant; the server/surface index into it directly.
  expect(s.layersByVariant).toEqual({});
  expect(s.analysisCache).toEqual({});
  expect(s.library).toBeInstanceOf(Array);
});

test("defaultState seeds the unified library (prompts + styles) and linked sets", () => {
  const s = defaultState("t");
  const prompts = s.library.filter((e) => e.kind === "prompt");
  const styles = s.library.filter((e) => e.kind === "style");
  expect(prompts.map((p) => p.id)).toEqual(["describe", "palette", "lighting"]);
  expect(styles.map((st) => st.name)).toEqual([
    "anime",
    "painterly",
    "photoreal",
    "3d",
    "watercolor",
    "line art",
  ]);
  // deterministic, reproducible style ids
  expect(styles.map((st) => st.id)).toEqual([
    "style-anime",
    "style-painterly",
    "style-photoreal",
    "style-3d",
    "style-watercolor",
    "style-line-art",
  ]);
  // all 3 prompts are surfaced in the composer; no styles active by default
  expect(s.quickPromptIds).toEqual(["describe", "palette", "lighting"]);
  expect(s.activeContextIds).toEqual([]);
});

test("defaultState seeds the situational/derived flags the toolbar reads", () => {
  const s = defaultState("t");
  expect(s.history).toEqual({ canUndo: false, canRedo: false });
  expect(s.marksUnseen).toBe(false);
  expect(s.status).toEqual({ busy: false, text: "" });
  expect(s.cost).toBe("");
  expect(s.handoff).toBe("");
  expect(s.aspect).toBe("1:1");
  expect(s.size).toBe("1K");
});

test("defaultState returns fresh (non-shared) library per call", () => {
  const a = defaultState("a");
  const b = defaultState("b");
  a.library[0].name = "mutated";
  a.quickPromptIds.push("x");
  expect(b.library[0].name).not.toBe("mutated");
  expect(b.quickPromptIds).toEqual(["describe", "palette", "lighting"]);
});

// ── leanState projection ────────────────────────────────────────────────────

// A fixture state with every blob the lean projection is supposed to strip:
// a variant src, a ref src, and a captured style image — plus the non-blob
// fields that MUST survive (paths, descriptions, prompts, marksByVariant).
function fixtureWithBlobs(): ImagoState {
  const s = defaultState("blobby");
  s.batches = [
    {
      id: "b1",
      kind: "generate",
      prompt: "a fox under an oak",
      tag: "fox",
      variants: [
        {
          id: "v1",
          src: "data:image/webp;base64,VARIANTBLOB",
          path: "/tmp/files/v1.webp",
          liked: true,
          analysis: "warm dusk light",
          seed: 42,
          model: "nano-banana",
        },
      ],
    },
  ];
  // a reference is now a Variant (in an import batch) flagged refSelected
  s.batches.push({
    id: "bref",
    kind: "import",
    prompt: "",
    tag: "references",
    variants: [
      {
        id: "ref1",
        src: "data:image/webp;base64,REFBLOB",
        path: "/tmp/files/ref1.webp",
        liked: false,
        analysis: "muted greens",
        name: "mood board",
        refSelected: true,
        hash: "deadbeef",
      },
    ],
  });
  s.library.push({
    id: "ctx-ghibli",
    kind: "style",
    name: "ghibli",
    content: "soft painterly anime",
    image: "data:image/webp;base64,STYLEBLOB",
    imagePath: "/tmp/files/style-ghibli.webp",
    captured: true,
  });
  s.marksByVariant = {
    v1: [{ id: "m1", tool: "pin", x: 0.5, y: 0.5, zOrder: 0 }],
  };
  return s;
}

test("leanState strips variant.src but keeps path + metadata", () => {
  const lean = leanState(fixtureWithBlobs());
  const v = lean.batches[0].variants[0] as Record<string, unknown>;
  expect(v.src).toBeUndefined();
  expect(v.path).toBe("/tmp/files/v1.webp");
  expect(v.analysis).toBe("warm dusk light");
  expect(v.liked).toBe(true);
  expect(v.seed).toBe(42);
  expect(v.model).toBe("nano-banana");
  // Batch-level provenance survives intact.
  expect(lean.batches[0].prompt).toBe("a fox under an oak");
  expect(lean.batches[0].tag).toBe("fox");
});

test("leanState strips a ref variant's src but keeps refSelected/name/hash/analysis", () => {
  const lean = leanState(fixtureWithBlobs());
  const r = lean.batches
    .flatMap((b) => b.variants)
    .find((v) => (v as Record<string, unknown>).id === "ref1") as Record<string, unknown>;
  expect(r.src).toBeUndefined();
  expect(r.path).toBe("/tmp/files/ref1.webp");
  expect(r.name).toBe("mood board");
  expect(r.analysis).toBe("muted greens");
  expect(r.hash).toBe("deadbeef");
  expect(r.refSelected).toBe(true); // the agent reads refs as variants where refSelected
});

test("leanState strips a library entry's image but keeps imagePath + content", () => {
  const lean = leanState(fixtureWithBlobs());
  const g = lean.library.find((e) => e.id === "ctx-ghibli") as Record<string, unknown>;
  expect(g.image).toBeUndefined();
  expect(g.imagePath).toBe("/tmp/files/style-ghibli.webp");
  expect(g.content).toBe("soft painterly anime");
  expect(g.captured).toBe(true);
});

test("leanState passes the linked sets through verbatim", () => {
  const src = fixtureWithBlobs();
  src.activeContextIds = ["ctx-ghibli"];
  src.quickPromptIds = ["describe"];
  const lean = leanState(src);
  expect(lean.activeContextIds).toEqual(["ctx-ghibli"]);
  expect(lean.quickPromptIds).toEqual(["describe"]);
});

test("leanState preserves non-image marks verbatim", () => {
  const src = fixtureWithBlobs();
  const lean = leanState(src);
  // fixture marks are a pin (no bitmap) → passed through unchanged
  expect(lean.marksByVariant).toEqual(src.marksByVariant);
});

test("leanState strips the bitmap from image-layer marks (keeps geometry + other marks)", () => {
  const src = fixtureWithBlobs();
  src.marksByVariant = {
    v1: [
      { id: "p1", tool: "pin", x: 0.5, y: 0.5, zOrder: 0, layerId: "L1" },
      {
        id: "i1",
        tool: "image",
        src: "data:image/webp;base64,LAYERBLOB",
        x: 0.1,
        y: 0.1,
        w: 0.3,
        h: 0.3,
        zOrder: 1,
        layerId: "L2",
      },
    ],
  };
  const lean = leanState(src);
  const marks = lean.marksByVariant.v1 as Array<Record<string, unknown>>;
  // the pin passes through verbatim
  expect(marks[0]).toEqual(src.marksByVariant.v1[0]);
  // the image mark loses its src but keeps geometry/tool/layerId
  expect(marks[1].src).toBeUndefined();
  expect(marks[1].tool).toBe("image");
  expect(marks[1].x).toBe(0.1);
  expect(marks[1].layerId).toBe("L2");
  // canonical state untouched (the browser still gets the bitmap)
  expect((src.marksByVariant.v1[1] as Record<string, unknown>).src).toBe(
    "data:image/webp;base64,LAYERBLOB",
  );
});

test("leanState does not mutate the source state (no blob loss in canonical)", () => {
  const src = fixtureWithBlobs();
  leanState(src);
  expect(src.batches[0].variants[0].src).toBe("data:image/webp;base64,VARIANTBLOB");
  expect(src.batches.find((b) => b.id === "bref")?.variants[0].src).toBe(
    "data:image/webp;base64,REFBLOB",
  );
  expect(src.library.find((e) => e.id === "ctx-ghibli")?.image).toBe(
    "data:image/webp;base64,STYLEBLOB",
  );
});

// ── optimizeSrc passthrough ─────────────────────────────────────────────────

test("optimizeSrc passes a non-data-url through unchanged", async () => {
  const http = "https://example.com/cat.png";
  expect(await optimizeSrc(http)).toBe(http);
  expect(await optimizeSrc("")).toBe("");
  // A non-image data url is also left alone (only image/* data urls re-encode).
  const txt = "data:text/plain;base64,aGVsbG8=";
  expect(await optimizeSrc(txt)).toBe(txt);
});
