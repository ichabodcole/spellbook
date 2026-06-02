#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
/**
 * glamour model-test harness.
 *
 * Generates one shared brief across a roster of models via the `media-forge`
 * CLI, downloads every output, and writes a manifest. Lets us compare models
 * apples-to-apples for a given image content-type (text, mascot, board, …).
 *
 * Usage:
 *   bun run.ts <round-name>            # runs the round defined below
 *   OUTDIR=/tmp/foo bun run.ts text    # override output dir
 *
 * Outputs land in $OUTDIR (default /tmp/glamour-tests/<round>/) as
 * <model-slug>-<i>.<ext>, plus manifest.json with prompt/model/seed/bytes.
 * Images are NOT committed — only this harness + the round definitions are.
 */
import { $ } from "bun";

type ModelSpec = {
  slug: string; // short filename-safe label
  model: string; // media-forge model id
  n?: number; // num images (default 4; some models forced to 1)
  width?: number;
  height?: number;
  negative?: string;
  prompt?: string; // per-model prompt override (for tailored rounds); falls back to round.brief
  note?: string; // why it's in this round / known caveat
};

// A style is either a `suffix` appended to a shared `subject` (range test —
// same subject across styles) OR a full standalone `prompt` (idiomatic test —
// each style gets subject matter that actually suits it).
type StyleSpec = { slug: string; suffix?: string; prompt?: string };

type Round = {
  name: string;
  brief?: string; // single shared prompt …
  subject?: string; // … OR a base subject + styles matrix (subject + each suffix)
  styles?: StyleSpec[];
  models: ModelSpec[];
};

// ---------------------------------------------------------------------------
// Rounds. Add new ones as the matrix expands; prune models that fail an axis.
// ---------------------------------------------------------------------------

const DIGESTIFY_TEXT_BRIEF = [
  'A clean logo lockup for an app called "Digestify".',
  'The wordmark text reads "Digestify" in a friendly rounded sans-serif, large and centered.',
  'Directly below, a smaller tagline reads "Synthesize. Review. Digestify."',
  "Beside the wordmark sits a tiny adorable baby-cthulhu mascot: a soft round purple",
  "octopus-creature with big friendly eyes and little curling tentacles, cute not scary.",
  "Color palette: deep indigo, amethyst purple, seafoam green, soft lavender.",
  "Small star sparkles and a thin crescent-moon accent.",
  "Cute cozy occult brand identity, flat vector style, clean white background,",
  "high contrast, crisp perfectly-legible lettering, correct spelling.",
].join(" ");

// Model-tailored Digestify brand-board prompts (axis: fairness re-test).
// Same brand, each prompt written the way that model's docs recommend.

// gpt-image-2: 6-part framework + THE TEXT READS verbatim wrapper.
const BOARD_GPT = `A professional brand reference board. Artifact type: brand style guide sheet for a software tool. Aesthetic: playful Lovecraft-inspired, dark fantasy meets productivity, premium indie-game brand guide. Background: deep indigo #1B1530 with thin lighter divider lines separating sections; small uppercase section labels pinned to the top-left of each zone. Palette world: moss green, seafoam green, lavender, deep indigo, muted purple. Motifs: tentacles, scrolls, books, stars. Crisp legible type throughout. No watermarks.
LAYOUT: 3 rows, 6 labeled zones.
ROW 1 (two columns, left 55% / right 45%):
Zone 1 | THE TEXT READS: "PRIMARY LOGO" — a large lockup: a cute baby-Cthulhu mascot (round, soft, big friendly eyes, little curling tentacles) beside a bold rounded wordmark THE TEXT READS: "Digestify" in seafoam green; beneath it the tagline THE TEXT READS: "Synthesize. Review. Digestify."
Zone 2 | THE TEXT READS: "MASCOT EXPRESSIONS" — five circular portraits of the same mascot with different expressions, each captioned below: THE TEXT READS: "CURIOUS", "STUDIOUS", "DELIGHTED", "FOCUSED", "SLEEPY".
ROW 2 (two columns, 50/50):
Zone 3 | THE TEXT READS: "STICKER PACK" — four die-cut sticker illustrations of the mascot with books, scrolls and stars, white sticker borders.
Zone 4 | THE TEXT READS: "COLOR PALETTE" — five swatches in a row; below each, name + hex in small mono: THE TEXT READS: "MOSS #6A7E5A", "SEAFOAM #A7DCC1", "LAVENDER #B7A6E0", "INDIGO #1B1530", "PLUM #6C4A8E".
ROW 3 (two columns, left 40% / right 60%):
Zone 5 | THE TEXT READS: "ICON SYSTEM" — a row of five simple line icons: book, scroll, eye, star, tentacle.
Zone 6 | THE TEXT READS: "REVIEW UI MOCKUP" — a flat app card titled THE TEXT READS: "Review" with a short summary block, three key-point lines, a star rating, and a button THE TEXT READS: "Mark as Digested".
All text rendered verbatim. Exact hex colors. No element overlap. Generous padding inside each zone.`;

// nano-banana-2: zone-enumerated layout + quoted per-section text.
const BOARD_NANO = `A professional brand board design sheet for a software tool called "Digestify", on a deep-indigo background with thin lighter divider lines separating clearly labeled zones. Aesthetic: playful Lovecraft-inspired, dark fantasy meets cozy productivity, premium indie-game brand guide. Palette: moss green, seafoam green, lavender, deep indigo, muted purple. Motifs: tentacles, scrolls, books, stars. The mascot is a cute baby Cthulhu (round, soft, big friendly eyes, little curling tentacles) — the same character throughout. Layout: 3 rows.
ROW 1, left zone labeled "PRIMARY LOGO": a large logo lockup with the mascot beside a bold rounded wordmark reading "Digestify" in seafoam green, and the tagline "Synthesize. Review. Digestify." beneath it.
ROW 1, right zone labeled "MASCOT EXPRESSIONS": five small circular portraits of the same mascot with different expressions, captioned "Curious", "Studious", "Delighted", "Focused", "Sleepy".
ROW 2, left zone labeled "STICKER PACK": four die-cut stickers of the mascot with books, scrolls and stars, white sticker borders.
ROW 2, right zone labeled "COLOR PALETTE": five color swatches; under each, its name and hex in small text — "Moss #6A7E5A", "Seafoam #A7DCC1", "Lavender #B7A6E0", "Indigo #1B1530", "Plum #6C4A8E".
ROW 3, left zone labeled "ICON SYSTEM": a row of five simple line icons (book, scroll, eye, star, tentacle).
ROW 3, right zone labeled "REVIEW UI MOCKUP": a clean flat app card titled "Review" with a short summary, three key points, a star rating, and a "Mark as Digested" button.
Render all labels and text crisply and verbatim. Clean typographic hierarchy. Generous white gutters between zones.`;

// flux.2-flex / pro: JSON-structured prompt passed as a string.
const BOARD_FLUX_JSON = JSON.stringify({
  scene:
    "Brand identity reference board for a software tool called Digestify, six-panel grid layout, two columns of three rows, thin gray divider lines and gutters between panels, premium indie-game brand guide, playful Lovecraft-inspired dark-fantasy aesthetic",
  composition:
    "top-left panel: large logo lockup with a cute baby-Cthulhu mascot beside the wordmark 'Digestify' and tagline 'Synthesize. Review. Digestify.'; top-right panel: a row of five circular mascot expression portraits; middle-left panel: a sticker pack of four die-cut mascot stickers with white borders; middle-right panel: a color palette of five swatches each with a hex label below; bottom-left panel: an icon grid of five simple line icons (book, scroll, eye, star, tentacle); bottom-right panel: a small flat review-UI mockup card. A small uppercase label sits at the top-left of each panel: 'PRIMARY LOGO', 'MASCOT EXPRESSIONS', 'STICKER PACK', 'COLOR PALETTE', 'ICON SYSTEM', 'REVIEW UI'",
  subjects: [
    {
      type: "mascot",
      description:
        "a cute baby Cthulhu — round, soft, big friendly eyes, little curling tentacles, not scary",
      details: "same character across all panels",
    },
    {
      type: "wordmark",
      description: "bold rounded sans-serif reading 'Digestify' in seafoam green",
    },
    {
      type: "color palette",
      description:
        "five vertical swatches with hex labels: Moss #6A7E5A, Seafoam #A7DCC1, Lavender #B7A6E0, Indigo #1B1530, Plum #6C4A8E",
    },
  ],
  brand_colors: {
    moss: "#6A7E5A",
    seafoam: "#A7DCC1",
    lavender: "#B7A6E0",
    indigo: "#1B1530",
    plum: "#6C4A8E",
  },
  style:
    "clean flat illustrated brand identity sheet, professional editorial layout, consistent visual language, premium indie-game brand guide",
  background: "deep indigo #1B1530 with thin gray panel gutters",
  mood: "playful, cozy, eldritch, professional",
});

const ROUNDS: Record<string, Round> = {
  // Axis 1 — TEXT. Who can spell a wordmark + tagline and keep it coherent?
  // Broad on purpose: we prune models that can't do text from later text-bearing rounds.
  text: {
    name: "text",
    brief: DIGESTIFY_TEXT_BRIEF,
    models: [
      {
        slug: "recraft-v41",
        model: "fal-ai/recraft/v4.1/text-to-image",
        n: 1,
        width: 1024,
        height: 1024,
        note: "vector/brand text specialist; 1/call on fal",
      },
      {
        slug: "nano-banana-2",
        model: "fal-ai/nano-banana-2",
        n: 2,
        width: 2048,
        height: 2048,
        note: "#1 text+instruction; pushed to 2K for legible small text",
      },
      {
        slug: "gpt-image-2",
        model: "openai/gpt-image-2",
        n: 2,
        width: 1024,
        height: 1024,
        note: "instruction-following; quality:high default on fal",
      },
      {
        slug: "flux2-pro",
        model: "black-forest-labs/flux.2-pro",
        n: 2,
        width: 1024,
        height: 1024,
        note: "premium FLUX.2; auto-optimized steps",
      },
      {
        slug: "flux2-flex",
        model: "black-forest-labs/flux.2-flex",
        n: 2,
        width: 1024,
        height: 1024,
        note: "CAVEAT: best text needs 40-50 steps; media-forge can't set steps → default",
      },
      {
        slug: "klein-9b",
        model: "fal-ai/flux-2/klein/9b/lora",
        n: 4,
        width: 1024,
        height: 1024,
        note: "fast baseline; expected weak text",
      },
      {
        slug: "grok-quality",
        model: "xai/grok-imagine-image/quality/text-to-image",
        n: 4,
        width: 1024,
        height: 1024,
        note: "wildcard; claims good text + broad style",
      },
      {
        slug: "wan-27",
        model: "fal-ai/wan/v2.7/text-to-image",
        n: 4,
        width: 1024,
        height: 1024,
        note: "wildcard; text/poster specialist, thinking mode",
      },
      {
        slug: "ernie-turbo",
        model: "fal-ai/ernie-image/turbo",
        n: 4,
        width: 1024,
        height: 1024,
        note: "wildcard; claims dense text + stylized range",
      },
    ],
  },

  // Axis 2 — STYLE RANGE + detail coherence. One rich multi-element scene held
  // constant, rendered in four very different style targets. Exposes which
  // models have range vs. are locked to one aesthetic, and who keeps all the
  // scene details coherent. No text → klein is back in; n=1 per (model,style).
  style: {
    name: "style",
    subject:
      "A cozy occult bookshop interior at night. A small adorable baby-cthulhu creature " +
      "(round, soft, big friendly eyes, little curling tentacles) is curled up in a worn armchair " +
      "reading a glowing open spellbook. Around it: melting candles, floating dust motes catching the light, " +
      "tall shelves crammed with ancient leather tomes, a steaming teacup on a side table, " +
      "and a crescent moon visible through an arched window. Amethyst purple and seafoam green color accents, warm and inviting.",
    styles: [
      {
        slug: "photojourno",
        suffix:
          " Rendered as documentary photojournalism: natural available light, 35mm lens, candid realistic photograph, fine detail, true-to-life.",
      },
      {
        slug: "surreal",
        suffix:
          " Rendered as photorealistic surrealism: hyperreal textures and lighting but a dreamlike, impossible, uncanny atmosphere, like a Beksinski-meets-cozy still.",
      },
      {
        slug: "pixar3d",
        suffix:
          " Rendered as a Pixar-style 3D animated film still: soft global illumination, subsurface scattering, rounded shapes, expressive and charming, high production value.",
      },
      {
        slug: "anime",
        suffix:
          " Rendered as a Studio Ghibli-inspired anime illustration: hand-painted backgrounds, soft cel shading, warm nostalgic lighting, 2D animation look.",
      },
    ],
    models: [
      {
        slug: "klein-9b",
        model: "fal-ai/flux-2/klein/9b/lora",
        n: 1,
        width: 1024,
        height: 1024,
        note: "fast default — does it have range?",
      },
      {
        slug: "nano-banana-2",
        model: "fal-ai/nano-banana-2",
        n: 1,
        width: 1024,
        height: 1024,
        note: "premium instruction-following",
      },
      {
        slug: "gpt-image-2",
        model: "openai/gpt-image-2",
        n: 1,
        width: 1024,
        height: 1024,
        note: "adherence king",
      },
      {
        slug: "flux2-pro",
        model: "black-forest-labs/flux.2-pro",
        n: 1,
        width: 1024,
        height: 1024,
        note: "premium FLUX.2",
      },
      {
        slug: "grok-quality",
        model: "xai/grok-imagine-image/quality/text-to-image",
        n: 1,
        width: 1024,
        height: 1024,
        note: "claims broadest style range — the model to validate here",
      },
      {
        slug: "ernie-turbo",
        model: "fal-ai/ernie-image/turbo",
        n: 1,
        width: 1024,
        height: 1024,
        note: "claims stylized range",
      },
      {
        slug: "recraft-v41",
        model: "fal-ai/recraft/v4.1/text-to-image",
        n: 1,
        width: 1024,
        height: 1024,
        note: "expect vector-locked — confirm it can't do photoreal/anime",
      },
      {
        slug: "juggernaut",
        model: "rundiffusion-fal/juggernaut-flux/pro",
        n: 1,
        width: 1024,
        height: 1024,
        note: "expect photoreal-locked — confirm narrow range",
      },
    ],
  },

  // Axis 2b — IDIOMATIC STYLE (best-model-per-style). Unlike axis 2, each style
  // gets its OWN subject matter that genuinely suits it, so we judge peak quality
  // per style (incl. portraiture + hands for realism) rather than range. Tells us
  // "route HERE when the user wants anime / documentary realism / a Pixar look."
  idiomatic: {
    name: "idiomatic",
    styles: [
      {
        slug: "photojourno",
        // Portraiture + hands stress test (per user): visible weathered hands + face.
        prompt:
          "A candid documentary photograph: a close three-quarter portrait of an elderly fisherman mending a net on a weathered harbor dock at dawn. " +
          "His weathered hands are clearly visible working the rope — deep wrinkles, calloused fingers, salt-stained wool sweater, calm tired eyes, grey stubble. " +
          "Soft overcast morning light, shallow depth of field, 35mm reportage, photojournalism, true-to-life skin texture and pores, natural color, unretouched.",
      },
      {
        slug: "surreal",
        prompt:
          "Photorealistic surrealism: an enormous goldfish drifting calmly through the air inside a sunlit living room that is knee-deep in still, glassy water. " +
          "Golden-hour light streams through tall windows, reflections rippling across the ceiling, a floating armchair, hyperreal textures, " +
          "dreamlike and uncanny, in the spirit of Magritte rendered as a high-end photograph.",
      },
      {
        slug: "pixar3d",
        prompt:
          "A Pixar-style 3D animated film still: a small round rusty robot with one big expressive glowing eye discovering a single delicate glowing flower " +
          "growing in a moonlit junkyard. Warm rim light against cool blue shadows, soft global illumination, subsurface scattering, tactile worn materials, " +
          "wide-eyed wonder, heart-warming and cinematic, high production value.",
      },
      {
        slug: "anime",
        prompt:
          "A Studio Ghibli-inspired anime film still: a teenage girl in a school uniform standing alone on a quiet rural train platform at sunset, " +
          "cherry-blossom petals drifting on the breeze, distant blue mountains, a single crow on a wire. Hand-painted background, soft cel shading, " +
          "warm nostalgic golden light, wistful slice-of-life mood, 2D traditional animation look.",
      },
    ],
    models: [
      {
        slug: "nano-banana-2",
        model: "fal-ai/nano-banana-2",
        n: 1,
        width: 1024,
        height: 1024,
        note: "range champ",
      },
      {
        slug: "grok-quality",
        model: "xai/grok-imagine-image/quality/text-to-image",
        n: 1,
        width: 1024,
        height: 1024,
        note: "range champ",
      },
      {
        slug: "gpt-image-2",
        model: "openai/gpt-image-2",
        n: 1,
        width: 1024,
        height: 1024,
        note: "rich detail / adherence",
      },
      {
        slug: "flux2-pro",
        model: "black-forest-labs/flux.2-pro",
        n: 1,
        width: 1024,
        height: 1024,
        note: "premium FLUX.2",
      },
      {
        slug: "klein-9b",
        model: "fal-ai/flux-2/klein/9b/lora",
        n: 1,
        width: 1024,
        height: 1024,
        note: "fast default",
      },
      {
        slug: "ernie-turbo",
        model: "fal-ai/ernie-image/turbo",
        n: 1,
        width: 1024,
        height: 1024,
        note: "atmospheric",
      },
      {
        slug: "juggernaut",
        model: "rundiffusion-fal/juggernaut-flux/pro",
        n: 1,
        width: 1024,
        height: 1024,
        note: "PHOTOREAL specialist — the photojourno/portrait/hands cell is its moment",
      },
      {
        slug: "z-image",
        model: "fal-ai/z-image/turbo",
        n: 1,
        width: 1024,
        height: 1024,
        note: "photoreal/portrait specialist — back in for the realism cell",
      },
      {
        slug: "recraft-v41",
        model: "fal-ai/recraft/v4.1/text-to-image",
        n: 1,
        width: 1024,
        height: 1024,
        note: "illustration range — anime cell",
      },
    ],
  },

  // Axis 3+5 — COMPOSITE BRAND BOARD (also the hardest multi-element adherence
  // test). Uses the REAL original ChatGPT brandboard brief for Digestify, so we
  // can judge "can media-forge models reproduce/beat the original boards?".
  // Larger canvases (boards need legible sub-elements). Expect instruction-
  // following models (nano-banana-2, gpt-image-2) to dominate; diffusion to
  // struggle with the multi-panel layout + many text labels.
  board: {
    name: "board",
    brief:
      'Create a playful Lovecraft-inspired branding board for a software tool called "Digestify". ' +
      "The mascot is a baby Cthulhu — cute and lovable, NOT horror, not scary, not violent; " +
      "a tiny eldritch librarian / adorable cosmic archivist / baby octopus scholar. " +
      "Style: dark fantasy meets productivity software, premium indie-game brand guide. " +
      "Colors: moss green, seafoam green, lavender, deep indigo, muted purple. " +
      "Visual motifs: tentacles, scrolls, books, stars, magical symbols, ancient knowledge. " +
      "Lay the board out with clearly separated, labeled sections: a large primary logo lockup, " +
      "a row of mascot expressions, a sticker pack, a color palette with swatches, an icon system, " +
      'and a small review-UI mockup. Include the tagline "Synthesize. Review. Digestify." ' +
      "Clean professional layout, crisp legible labels.",
    models: [
      {
        slug: "nano-banana-2",
        model: "fal-ai/nano-banana-2",
        n: 2,
        width: 2048,
        height: 2048,
        note: "hypothesized board champ — 2K for legible labels",
      },
      {
        slug: "gpt-image-2",
        model: "openai/gpt-image-2",
        n: 2,
        width: 1536,
        height: 1536,
        note: "the family the ORIGINAL boards were made with",
      },
      {
        slug: "grok-quality",
        model: "xai/grok-imagine-image/quality/text-to-image",
        n: 1,
        width: 1024,
        height: 1536,
        note: "wildcard — strong text + range",
      },
      {
        slug: "flux2-pro",
        model: "black-forest-labs/flux.2-pro",
        n: 1,
        width: 1024,
        height: 1536,
        note: "best diffusion shot at a board",
      },
      {
        slug: "recraft-v41",
        model: "fal-ai/recraft/v4.1/text-to-image",
        n: 1,
        width: 1024,
        height: 1536,
        note: "brand/vector specialist — can it do a full board?",
      },
      {
        slug: "ernie-turbo",
        model: "fal-ai/ernie-image/turbo",
        n: 1,
        width: 1024,
        height: 1536,
        note: "cheap workhorse — can it hold a multi-section board?",
      },
      {
        slug: "klein-9b",
        model: "fal-ai/flux-2/klein/9b/lora",
        n: 1,
        width: 1024,
        height: 1536,
        note: "fast default diffusion — board attempt",
      },
    ],
  },

  // Axis — BOARD FAIRNESS RE-TEST. Same Digestify brand, each model prompted the
  // way ITS docs recommend (vs. the single ChatGPT-shaped brief used in `board`).
  // Answers: is gpt-image-2 genuinely best, or just prompt-advantaged? And does
  // the JSON-structured prompt tighten FLUX.2's collage?
  // Caveat: media-forge can't set flux.2-flex steps (40-50) or Gemini thinking/
  // resolution tier — so those models run below their documented best.
  "board-tailored": {
    name: "board-tailored",
    models: [
      {
        slug: "gpt-image-2",
        model: "openai/gpt-image-2",
        n: 1,
        width: 1536,
        height: 1536,
        prompt: BOARD_GPT,
        note: "home turf: THE TEXT READS framework",
      },
      {
        slug: "nano-banana-2",
        model: "fal-ai/nano-banana-2",
        n: 1,
        width: 2048,
        height: 2048,
        prompt: BOARD_NANO,
        note: "zone-enumerated + pushed to 2K",
      },
      {
        slug: "flux2-flex",
        model: "black-forest-labs/flux.2-flex",
        n: 2,
        width: 1536,
        height: 1536,
        prompt: BOARD_FLUX_JSON,
        note: "JSON-structured; default steps (CLI can't set 40-50)",
      },
      {
        slug: "flux2-pro",
        model: "black-forest-labs/flux.2-pro",
        n: 2,
        width: 1536,
        height: 1536,
        prompt: BOARD_FLUX_JSON,
        note: "same JSON prompt — pro vs flex on identical input",
      },
    ],
  },
};

// ---------------------------------------------------------------------------

const roundName = process.argv[2] ?? "text";
const round = ROUNDS[roundName];
if (!round) {
  console.error(`Unknown round "${roundName}". Known: ${Object.keys(ROUNDS).join(", ")}`);
  process.exit(2);
}

const outdir = process.env.OUTDIR ?? `/tmp/glamour-tests/${round.name}`;
await mkdir(outdir, { recursive: true });

console.log(`Round: ${round.name}\nOut:   ${outdir}\n`);

type ManifestEntry = {
  slug: string; // model slug
  label: string; // filename base (model slug, or model-style)
  style?: string;
  model: string;
  prompt?: string;
  file?: string;
  presignedUrl?: string;
  seed?: number | string;
  serviceJobId?: string; // for cost lookup via `media-forge jobs get`
  jobN?: number; // images produced by this job (cost is per-job → divide)
  sizeBytes?: number;
  mimeType?: string;
  error?: string;
  note?: string;
};

type Job = { spec: ModelSpec; prompt: string; label: string; style?: string };

const manifest: ManifestEntry[] = [];

async function runJob(job: Job) {
  const { spec, prompt, label, style } = job;
  const n = spec.n ?? 4;
  const args = [
    "generate",
    "image",
    `--prompt=${prompt}`,
    `--model=${spec.model}`,
    `--n=${n}`,
    `--format=json`,
    `--timeout=${process.env.TIMEOUT ?? 300}`,
  ];
  if (spec.width) args.push(`--width=${spec.width}`);
  if (spec.height) args.push(`--height=${spec.height}`);
  if (spec.negative) args.push(`--negative-prompt=${spec.negative}`);

  console.log(`→ ${label} (${spec.model}) n=${n}…`);
  try {
    const res = await $`media-forge ${args}`.quiet();
    const json = JSON.parse(res.stdout.toString());
    if (!json.ok) throw new Error(JSON.stringify(json.error ?? json));
    const outputs = json.data?.outputs ?? [];
    if (!outputs.length) throw new Error("no outputs");
    let i = 0;
    for (const out of outputs) {
      const url = out.presignedUrl ?? out.url;
      const mime = out.mimeType ?? "image/png";
      const ext = mime.split("/")[1]?.split("+")[0] ?? "png";
      const file = n > 1 ? `${label}-${i}.${ext}` : `${label}.${ext}`;
      const dl = await fetch(url);
      const buf = Buffer.from(await dl.arrayBuffer());
      await writeFile(`${outdir}/${file}`, buf);
      manifest.push({
        slug: spec.slug,
        label,
        style,
        model: spec.model,
        prompt,
        file,
        presignedUrl: url,
        seed: out.seed ?? json.data?.seed,
        serviceJobId: json.data?.serviceJobId,
        jobN: outputs.length,
        sizeBytes: buf.length,
        mimeType: mime,
        note: spec.note,
      });
      console.log(`   ✓ ${file} (${(buf.length / 1024).toFixed(0)} KB)`);
      i++;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    manifest.push({
      slug: spec.slug,
      label,
      style,
      model: spec.model,
      error: msg,
      note: spec.note,
    });
    console.log(`   ✗ ${label}: ${msg.slice(0, 200)}`);
  }
}

// Optional slug filter (MODELS=klein-9b,recraft-v41) and concurrency pool.
// fal caps concurrent jobs per account, so a too-wide fan-out leaves jobs
// queued until they hit --timeout (exit 124). Keep the pool small.
const only = (process.env.MODELS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const pool = Number(process.env.CONCURRENCY ?? 3);
const models = round.models.filter((m) => only.length === 0 || only.includes(m.slug));

// Optional style filter (STYLES=photojourno,anime) for targeted re-runs.
const onlyStyles = (process.env.STYLES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Expand models × (styles or single brief) into a flat job list.
const jobs: Job[] = [];
for (const spec of models) {
  if (round.styles) {
    for (const st of round.styles) {
      if (onlyStyles.length && !onlyStyles.includes(st.slug)) continue;
      // Standalone per-style prompt (idiomatic test), or subject+suffix (range test).
      const prompt = st.prompt ?? `${round.subject ?? ""}${st.suffix ?? ""}`;
      jobs.push({ spec, prompt, label: `${spec.slug}-${st.slug}`, style: st.slug });
    }
  } else {
    jobs.push({ spec, prompt: spec.prompt ?? round.brief ?? "", label: spec.slug });
  }
}

let cursor = 0;
async function worker() {
  while (cursor < jobs.length) {
    const job = jobs[cursor++];
    if (job) await runJob(job);
  }
}
await Promise.all(Array.from({ length: Math.min(pool, jobs.length) }, worker));

// Merge with any prior manifest, replacing only the (model,style) labels we
// just (re)ran — so a targeted re-run never clobbers earlier successes.
let prior: ManifestEntry[] = [];
try {
  const existing = await Bun.file(`${outdir}/manifest.json`).json();
  const ranLabels = new Set(jobs.map((j) => j.label));
  prior = (existing.entries ?? []).filter((e: ManifestEntry) => !ranLabels.has(e.label));
} catch {}
await writeFile(
  `${outdir}/manifest.json`,
  JSON.stringify(
    {
      round: round.name,
      subject: round.subject,
      brief: round.brief,
      generatedFrom: "media-forge",
      entries: [...prior, ...manifest],
    },
    null,
    2,
  ),
);

const ok = manifest.filter((m) => m.file).length;
const failed = manifest.filter((m) => m.error);
console.log(`\nDone. ${ok} images, ${failed.length} model error(s).`);
for (const f of failed) console.log(`  ✗ ${f.slug}: ${f.error?.slice(0, 120)}`);
console.log(`\nmanifest: ${outdir}/manifest.json`);
