# media-forge CLI — capability gaps & feature asks

**From:** Spellbook (glamour spell + model-evaluation work) **Status:** Archived
(Partially Implemented — see "Shipped" section; #3 param-passthrough and #4
vector/SVG not pursued). Feedback loop closed; archived 2026-06-27. **Date:**
2026-06-02 **Audience:** the media-forge CLI maintainer/agent — to assess fit
and co-design

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

## Converged design (2026-06-02 session with the media-forge agent)

A live design session over grapevine (`media-forge-design`,
Spellbook=`spellwright` ↔ media-forge=`kestrel`) refined these asks against
media-forge's real architecture and the providers' actual fal schemas. Companion
artifact (the schema side-by-side the registry declarations would build from):
`/Users/colereed/Projects/dreamwood/media-forge/docs/investigations/artifacts/2026-06-02-image-reference-edit-schemas.md`.

Outcomes per ask:

- **#1 Image input — converged shape (not committed).** Reference/edit is a
  separate `/edit` endpoint per model, and the fal wire shape is near-uniform:
  `prompt` + `image_urls: string[]` (URLs). **No structured style-vs-subject
  role field exists on any fal edit endpoint** — role is prompt-expressed (the
  native Gemini object/character distinction is native-API-only, untested, and
  not chased for an MVP). So: `--ref <url|path>` (repeatable) → `image_urls[]` →
  route to the model's `/edit`. **Registry declares per model** (for routing +
  `models list`): `editCapable`, `maxRefs`, `acceptsMask` (gpt-image), recraft's
  `style_id`/`colors`/`style`. **Seam:** CLI/registry own
  `editCapable`/`maxRefs`/ingest; the **agent owns role via prompt**. Ingest is
  two URL-yielding shapes; a generated **presigned output URL is directly usable
  as an input ref** (closes glamour's generate→pick→reuse loop, ~free). _Honesty
  caveat: references were never empirically tested (the eval was text-to-image
  only) — this is schema-grounded, not eval-grounded._
- **#3 Param passthrough — converged.** Not a raw `--param`: **registry-modeled
  optional params** (typed, validated, discoverable via `models list`) as
  primary; a marked experimental escape hatch only for the true tail. The
  needle-movers are finite (~10 across the roster): flux
  `num_inference_steps`/`guidance_scale`; gemini
  `thinking_level`(minimal|high)/`resolution`(0.5K–4K)/`aspect_ratio`/`seed`;
  recraft `style_id`/`colors`; gpt-image `quality`. (Confirmed on the live fal
  gemini schema — `resolution` 2K/4K and `thinking_level` are real fal params,
  not native-only. `limit_generations` exists and defaults true, but a smoke
  test showed it does **not** cap batch at n=2: `num_images:2` returns 2 on both
  nano-banana-2 and gemini-3.1 — so it's a registry param to expose, not a bug.
  An earlier "asked n=2, got 1" claim was retracted: it was never observed in
  the eval — nano-banana-2 returned the full n in every run.)
- **#6 exit-124 concurrency** — media-forge owns the fix (distinguish queued vs
  timeout); implementation timing is Cole's call.
- **#2 transparency — grounded (two mechanisms).** A native per-model flag
  exists but on **`fal-ai/gpt-image-1.5`**
  (`background: auto|transparent|opaque`) — _not_ flux/recraft (recraft's
  `background_color` is set-a-color, not alpha); our `openai/gpt-image-2` entry
  doesn't expose it. The general path is **dedicated background-removal
  endpoints** fal hosts as first-class (`birefnet`, `bria/background/remove`,
  `ideogram/remove-background`, `imageutils/rembg`, …) — the Spellbook
  multi-step workaround as a real endpoint, works on any image. So #2 = a thin
  `supportsTransparency` flag for the few models that have it + bg-removal as a
  separate transform. Low priority (workaround exists).
- **#4 vector — tractable.** Dedicated `recraft/text-to-vector` (v4/v4.1 + pro);
  separate-endpoint pattern like `/edit`; SVG is a distinct output modality
  (mime/storage). For glamour: logos + icon sets. The clearest remaining ask.

**Emergent frame (kestrel's synthesis, worth Cole seeing):** bg-removal (#2),
vectorize (#4), and edit/refs (#1) — plus upscale and outpaint — are all facets
of one **image→image TRANSFORM category**, distinct from text-to-image
generation. The real question may be "does media-forge grow an
_image-operations_ axis" rather than adding `--ref` / `--background` /
`--format svg` one at a time.

Open items: the **OpenRouter-hosted twins** (`google/gemini-*`,
`black-forest-labs/flux.2-*`) are unverified — this is the fal surface only; so
`editCapable`/`maxRefs` (and any transform capability) likely want to be
**per-(model, provider)**, not per-model. Exact `maxRefs` per array endpoint to
be pinned when building entries.

## Shipped (2026-06-03 — verified live against the API)

media-forge built the **image→image transform axis** kestrel synthesized. Verbs
confirmed via `--help` + `models list`:

- **#1 image input / edit — SHIPPED.** `generate image --ref <url|path>`
  (repeatable → edit endpoint). Per-model `operations.edit.maxRefs` now declared
  in `models list`: nano-banana-2 **14**, gemini-3.1-flash (fal) **14**,
  flux-2/turbo **4**, flux-2/klein-9b **4**. Local-file auto-upload + output-URL
  loop-closer both work (consumer-validated last session).
- **#2 transparency — SHIPPED (as bg-removal).**
  `generate bg-remove --model --ref` → transparent PNG. Models
  `fal-ai/bria/background/remove`, `fal-ai/ideogram/remove-background`
  (`operations.bg-remove`, `supportsGenerate:false`). The dedicated-endpoint
  path we recommended over a native flag.
- **inpaint — SHIPPED.** `generate inpaint --model --ref --mask --prompt`
  (WHITE=regen, BLACK=keep; mask matches base dims). Models
  `fal-ai/flux-pro/v1/fill`, `fal-ai/flux-lora/inpainting`
  (`operations.inpaint`). The masked facet of the transform axis.
- **`status` command — SHIPPED.** `media-forge status` → api/postgres/redis/
  worker/queue readiness incl. `queue.{waiting,active}` — partially addresses
  **#6** (lets you distinguish a backed-up queue from a real timeout, even
  though the bare `exit 124` is unchanged).
- **Roster expanded** — new generators: z-image/turbo, wan v2.7, ernie-image
  (turbo + lora), imagineart-2.0, juggernaut-flux/pro, cosmos-3-super,
  grok-imagine, recraft **v4.1**.

**Still open:** **#3** provider param passthrough (no `--param`; steps/guidance/
quality/Gemini thinking+resolution-tier unreachable), **#4** vector/SVG
(recraft's `text-to-vector` not in `models list`; v4.1 declares no vector op),
and the bare **#6** exit-124 (status helps diagnose but the code is still
ambiguous). `gpt-image-2` declares `operations:null` (no edit on our entry) —
worth a note if gpt-image edit is wanted later.

## What `generate image` exposed at time of writing (superseded — see Shipped)

`--prompt --model --n --width --height --seed --negative-prompt --wait --timeout --poll-interval --format`.
Text-to-image only. No way to pass an input image, control
steps/quality/resolution-tier, request transparency, get vector output, or send
provider-specific params. _(#1/#2/inpaint have since shipped — above.)_

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
