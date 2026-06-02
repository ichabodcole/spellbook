# media-forge CLI — capability gaps & feature asks

**From:** Spellbook (glamour spell + model-evaluation work) **Status:** feedback
/ discussion starter — clear asks + high-level design, not a final spec
**Date:** 2026-06-02 **Audience:** the media-forge CLI maintainer/agent — to
assess fit and co-design

## Context

While building **glamour** (a Spellbook spell that composes a visual style /
brand system from influences) we ran a large model-evaluation suite through
`media-forge` v0.3.0 — ~100+ generations across ~15 models and 4 content-type
axes (text, style-range, idiomatic-style, composite brand board). Findings live
in `docs/projects/image-style-spell/model-research.md`.

**media-forge is genuinely good as-is** — `generate`, `models`, `jobs`,
`usage`/cost rollups, presigned outputs, and JSON output all worked cleanly and
made this evaluation possible. The gaps below are the handful of capabilities we
hit a wall on, each of which blocks a specific, real glamour use case. They are
offered as asks + sketches; the actual design is yours, and we'd like to work
through anything with a conflict of interest (we expect few).

## What `generate image` exposes today

`--prompt --model --n --width --height --seed --negative-prompt --wait --timeout --poll-interval --format`.
Text-to-image only. No way to pass an input image, control
steps/quality/resolution-tier, request transparency, get vector output, or send
provider-specific params.

## The gaps (prioritized by glamour value)

### 1. Image input — references / img2img / edit ⭐ highest value

**Gap:** no way to pass an input image. `generate image` is text-to-image only.

**Why we need it:**

- **glamour's core premise** is "drop in influence images → produce work in that
  direction." Without image input we can't feed the user's influences to the
  model at all.
- **Mascot / character consistency** (expression sheets, an asset family that
  reuses one mascot) requires reference-image conditioning — we literally could
  not test this axis.
- **Iterative editing** ("same board, swap the palette", "this mascot, new
  pose") needs an edit/img2img path.

**Provider support exists** — fal FLUX.2 multi-reference (`@image1…`, up to
~10), Gemini up to 14 reference images, gpt-image-2 edit, recraft
style-from-images. The mechanisms differ per provider; the CLI's job is a clean
cross-provider face.

**Sketch:** `--ref <path|url>` (repeatable, for multi-reference) and/or an
`--image <path|url> [--strength 0.0–1.0]` for img2img, and possibly a
`generate edit` subcommand for masked/instructed edits. Map to each provider's
native mechanism under the hood; error clearly when a chosen model has no
reference path.

### 2. Transparency / background control ⭐

**Gap:** no background/transparency control.

**Why we need it:** glamour produces **reusable assets** — stickers, icons,
isolated mascot cutouts — that need transparent backgrounds for compositing.
This is also the one capability that splits the models: fal FLUX endpoints can
do transparency; `gpt-image-2` cannot. Right now we can't request it from any of
them.

**Sketch:** `--background transparent|opaque|auto` (or `--transparent`).
Validate per model; clear error when unsupported (e.g. gpt-image-2 → suggest a
Flux model or a future bg-removal step).

### 3. Generic provider-param passthrough ⭐ highest leverage, lowest surface

**Gap:** no way to send provider-specific parameters, so each model runs at
defaults only. This cost us real quality:

- **`flux.2-flex`** needs `num_inference_steps` 40–50 for its best text — we
  couldn't set it, so its text ceiling went untested.
- **Gemini** resolution tier (1K/2K/4K) and **high-thinking mode** improve board
  text — unreachable (we hacked resolution via `--width/--height`).
- **recraft** `style_id` (brand-style lock), `colors`/`background_color` palette
  params — its marquee brand features, unreachable.
- **gpt-image** `quality`, **flux** `guidance_scale`, `aspect_ratio`,
  `enable_web_search`, etc.

**Sketch:** a single escape hatch — `--param key=value` (repeatable) or
`--extra '<json>'` — forwarded to the provider payload with light type coercion
and an "unknown param for model X" warning. **This one addition unlocks most of
the long tail without a bespoke flag per provider**, and keeps the CLI clean.

### 4. Vector / SVG output

**Gap:** the roster (`models list`) exposes raster endpoints only; recraft's
`v4.1/text-to-vector` (true editable SVG) isn't reachable.

**Why we need it:** clean, scalable **logos and icons** — recraft's standout
strength and exactly what a brand system wants as deliverables.

**Sketch:** surface the vector endpoints in `models list` and allow
`--format svg` (or a `generate vector` subcommand) for models that support it.

### 5. First-class sugar for the common knobs (optional)

Once #3 exists, promote the most-used ones to real flags for ergonomics:
`--steps`, `--guidance`, `--quality`, `--resolution 1k|2k|4k`, `--aspect 1:1`.
Pure convenience over the passthrough.

### 6. Usability — concurrency limit surfaces as opaque timeouts

**Observation (not a model feature):** fanning out >~2 concurrent `generate`
calls left jobs queued past `--timeout`, surfacing as **`exit 124`** that looks
identical to a real timeout. We only diagnosed it by trial (pool of 2 worked, 3
didn't). Asks, any of:

- A distinct exit code / error message for "provider concurrency limit / still
  queued" vs. genuine timeout.
- Optional **client-side queue + backoff** so a large fan-out just works.
- Document the per-tenant concurrency cap.

### 7. Cost ergonomics (minor)

Per-job cost finalizes asynchronously (`jobs get` reads `costStatus: pending`
right after generation). We worked around it by polling `jobs get` later. A
`--wait-for-cost` flag, or a cost _estimate_ in the `generate` response, would
make cost-aware tooling simpler. (The `usage summary` rollup is great for batch
totals.)

## Suggested design philosophy

Favor **a few clean cross-provider flags** (`--ref`, `--background`,
`--format svg`) for the capabilities that are conceptually universal, plus **one
generic passthrough** (`--param`/`--extra`) for the provider-specific long tail
— rather than dozens of per-model flags. That keeps the CLI surface small while
unlocking each model's real power, and it degrades gracefully (warn + skip
unknown params per model). This should fit the current `generate` shape without
disruption.

## Priority for glamour

1. **Image input (#1)** — unblocks glamour's core influence→output loop + mascot
   consistency. The big one.
2. **Transparency (#2)** + **vector (#4)** — clean, reusable brand assets.
3. **Param passthrough (#3)** — squeezes real quality out of every model (esp.
   flux.2-flex text, Gemini boards, recraft brand-lock).
4. Sugar (#5), concurrency clarity (#6), cost ergonomics (#7) — polish.

## Next step

Take this to the media-forge CLI agent to assess fit and co-design — especially
the cross-provider shape of #1 (references/edit) and #3 (passthrough), where the
provider mechanisms differ most. We expect no real conflict of interest; the aim
is a design that serves both projects cleanly.
