# Model research — image generation for glamour

Pre-generation research (web, mid-2026) into the strengths, weaknesses, and
prompting approaches of the text-to-image models media-forge exposes, so the
**glamour** agent can route a request to the right model for the _kind_ of image
being made. This is the empirical seed; actual generation tests (below) refine
it. Treat this as a living document — the spell's whole premise is that this
understanding deepens with use.

> Sources are the official model docs (BFL, Google DeepMind, OpenAI, Recraft),
> the fal.ai model/prompt pages, and 2025–2026 reviews. Per-model citations live
> in the research transcript; the load-bearing claims are summarized here.

---

## The two paradigms (the thing that actually drives selection)

Every model here is one of two kinds, and they fail in opposite ways:

**Instruction-following / autoregressive** — `gpt-image-2`, the Gemini
"nano-banana" family. These _reason about layout before rendering_. They treat a
prompt like a creative brief: "logo top-right, mascot center, five hex swatches
along the bottom" maps to real spatial output. They render **readable text**
(the single hardest thing for diffusion models) and compose **multi-element
boards**. Prompt them in prose, enumerate panels, quote text strings verbatim.
No negative prompts; describe positively.

**Diffusion** — the whole **Flux** family, Recraft, and the specialized models.
Non-reasoning: they will not connect dots. Be **explicit and spatial** ("two
small curved horns growing out of the top of the cat's head, between its ears"),
name concrete style specifics, front-load the subject. They excel at **single
subjects** and are the **only family that outputs true transparency** — which
matters more than it sounds (see constraints). Text is their weak point.

A one-line heuristic: **if the image contains words or is a laid-out board →
instruction-following model. If it's a single illustrated subject or needs a
transparent cutout → diffusion (Flux). If it's a logo/icon/vector → Recraft.**

---

## Content-type taxonomy

Derived from the original ChatGPT brand-board prompts (in
`artifacts/brandboard-prompts/`). Every `INCLUDE:` line in those prompts is a
distinct image content-type, and models diverge sharply across them:

1. **Hero mascot** — one character, hero pose
2. **Expression / state sheet** — same character, many poses (consistency)
3. **Logotype / wordmark** — renders readable TEXT
4. **Combination mark** — symbol + wordmark together
5. **Sticker pack** — die-cut set (often wants transparency)
6. **Icon system** — consistent multi-icon set
7. **Color palette board** — swatches, often labeled with hex
8. **Typography specimen** — type laid out, multi-weight
9. **UI mockup** — an app screen with real-looking text/layout
10. **Scene / workflow illustration** — narrative composition
11. **Full composite brand board** — many of the above in one image

---

## Cross-cutting constraints (read before routing)

These are the gotchas that override aesthetic preference:

| Constraint                 | Who it affects                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Transparency**           | `gpt-image-2` does **NOT** support transparent backgrounds. For isolated stickers/icons/mascot cutouts → **Flux**, or post-process bg removal.                     |
| **SynthID watermark**      | All **Gemini** outputs carry an invisible, non-disableable SynthID watermark + C2PA credentials. Fine for comps; know it's there.                                  |
| **Small text legibility**  | **Gemini** small/body text is blurry at 1K — generate at **2K or 4K** for any text-critical board.                                                                 |
| **`num_images` on fal**    | Supported (≤4) on flux schnell/dev, flux-2 turbo/klein, gpt-image-2. **NOT** on `recraft/v4.1` (1/call) or most Gemini routes. Recraft sets need N separate calls. |
| **Seed (reproducibility)** | flux family + juggernaut expose `seed`. **gpt-image-2, Gemini, recraft (fal) do NOT** — lock the prompt + (Recraft) a `style_id` instead.                          |
| **Negative prompts**       | Only **`juggernaut-flux/pro`** in this roster. Everyone else: reword positively ("sharp focus" not "no blur").                                                     |
| **Vector / SVG output**    | Only **Recraft** (`recraft/v4.1/text-to-vector`). Everything else is raster.                                                                                       |

---

## Model roster — verdicts

### Instruction-following (text + boards)

- **`openai/gpt-image-2`** — The original Spellbook brand boards were made with
  this family, and it shows: **composite boards, color/type boards, UI mockups,
  any verbatim text** are its home turf (~99% text accuracy, plans layout as a
  reasoning task). Raster-only, **no transparency**, no seed, session quality
  degrades after ~3–5 gens (restart between batches), real-logo geometry drifts.
  `quality: high` for dense text; Thinking Mode for multi-element boards.
- **`fal-ai/nano-banana-2`** = **`fal-ai/gemini-3.1-flash-image-preview`** (same
  model; also on OpenRouter) — **#1 on text-to-image Arena (Feb 2026)** for
  instruction-following and text; 14 reference images, up to 5 consistent
  characters, native 4K, "high-thinking" mode, web-search grounding. **The top
  pick for the full composite brand board** and anything text-heavy — _at 2K+_.
  Caveats: SynthID watermark, no seed, no transparency, small text weak at 1K.
- **`google/gemini-2.5-flash-image`** — the original Nano Banana. Strong
  compositing/consistency but **acknowledged weaker text** — superseded by 3.1
  for our purposes; keep only as a cheaper fallback for non-text scenes.

### Flux — diffusion workhorses

- **`fal-ai/flux-2/klein/9b/lora`** (current quick default) — FLUX.2,
  sub-second, schnell's real successor. Good mascots/icons/stickers/scenes at
  speed; **HEX color control**; up to 3 stacked LoRAs; FLUX.2-era text (better
  than schnell, still "may be distorted"). No CFG/negative on the fal endpoint,
  ~2MP ceiling. **Best exploration-round model.**
- **`fal-ai/flux-2/turbo`** — FLUX.2 fast tier, ~6s, **exposes
  `guidance_scale`** (klein doesn't). Good draft mascots/icons/scenes; text
  needs more than its 8 steps give. Alternative quick model when you want a CFG
  knob.
- **`black-forest-labs/flux.2-pro`** — top FLUX.2 quality, **8–10 reference
  images** for identity/style consistency, 4MP, ~60% first-try text. Strong hero
  mascots and reference-locked work; steps/guidance not exposed.
- **`black-forest-labs/flux.2-flex`** — the **controllable** FLUX.2: push
  `num_inference_steps` to **40–50 for the best Flux text rendering**, full
  guidance control, 10 references. The Flux pick for **logotype / typography /
  combination mark / brand board** when staying in-family.
- **`fal-ai/flux/dev`** — FLUX.1 workhorse, **largest LoRA ecosystem** (incl.
  logo-design LoRAs), best FLUX.1 text. Beware the **`white background` bug**
  (use "neutral backdrop, soft light, high contrast"). Reach for it only when a
  specific community LoRA is the point; otherwise FLUX.2 supersedes.
- **`fal-ai/flux/schnell`** — concept thumbnails only. 4 steps, weak
  text/detail. Superseded by klein 9b; keep only for throwaway ideation.
- **`rundiffusion-fal/juggernaut-flux/pro`** — FLUX.1 photoreal fine-tune.
  Excellent for **photorealistic** humans/creatures/scenes and the **only model
  here with negative prompts**. Wrong tool for cute/flat/vector brand work.

### Recraft — the vector / logo / icon specialist

- **`fal-ai/recraft/v4.1/text-to-image`** (+ `/text-to-vector`, `/pro`,
  `/utility`) — **best in class for logotype, icon system, combination mark**,
  and the **only native SVG** output. `colors`/`background_color` params enforce
  a palette; **`style_id`** (train on 1–5 refs) locks brand DNA across an asset
  family — genuinely useful for a cohesive system. Weak at expressive mascots,
  photoreal, and full boards; SVGs need cleanup (treat as "80% done"); **no
  `num_images`/seed/negative** on fal. **V4.1 dropped the `style` enum** — style
  is now prompt + `style_id` only.

### Specialized — mostly bench

- **`xai/grok-imagine-image/quality`** — broad style range (anime → flat vector
  → logos/icons/mascots), strong adherence, clean output. **Worth trialing** as
  a versatile alt; no fine-tuning/LoRA.
- **`fal-ai/ernie-image/lora/turbo`** (+ base) — stylized range + a **cheap
  brand LoRA trainer** (~$1.80) for locked consistency. Worth trialing for
  brand-lock.
- **`fal-ai/wan/v2.7/text-to-image`** — text-rendering/poster specialist with a
  thinking mode; situational for text-heavy assets, not mascots.
- **`fal-ai/z-image/turbo`**, **`imagineart-2.0-preview`**,
  **`nvidia/cosmos-3-super`** — **skip** for brand/mascot (photoreal /
  physical-AI / preview; narrow or out-of-distribution).

---

## The matrix — content-type → model

Primary pick first, then alternates. "Quick" = exploration rounds; "Final" =
converged/canonical.

| Content-type             | Quick (explore)          | Final (canonical)                                      | Notes                                                          |
| ------------------------ | ------------------------ | ------------------------------------------------------ | -------------------------------------------------------------- |
| **Hero mascot**          | klein 9b · grok          | flux.2-pro · nano-banana-2                             | klein for volume; pro for reference-locked identity.           |
| **Expression sheet**     | klein 9b (one pose/call) | flux.2-pro / flex (refs) · nb2 (5 chars)               | Hardest for consistency — anchor with reference images.        |
| **Logotype / wordmark**  | klein 9b (rough)         | **recraft v4.1** · nb2 · flux.2-flex(40–50 steps)      | Text is the deciding axis; Recraft for vector finals.          |
| **Combination mark**     | klein 9b                 | **recraft v4.1** · flux.2-flex                         | Generate symbol, then combined.                                |
| **Sticker pack**         | **klein 9b** · flux/dev  | flux.2-pro                                             | **Flux only** if you need transparency; gpt-image-2 can't.     |
| **Icon system**          | klein 9b                 | **recraft v4.1** (+ `style_id`)                        | Recraft set = N calls (no num_images); lock prompt + style_id. |
| **Color palette board**  | klein 9b (HEX) · nb2     | **nano-banana-2** · gpt-image-2                        | Boards = instruction-following; klein only for a rough swatch. |
| **Typography specimen**  | —                        | **nano-banana-2 (2K+)** · gpt-image-2 · flux.2-flex    | Text-critical; render at 2K+.                                  |
| **UI mockup**            | klein 9b (rough)         | **nano-banana-2** · gpt-image-2                        | World-knowledge of UI + legible text.                          |
| **Scene / workflow**     | klein 9b · flux.2-turbo  | flux.2-pro · nano-banana-2                             | Diffusion fine for textless scenes; nb2 if labels needed.      |
| **Full composite board** | —                        | **nano-banana-2 (2K/4K, high-thinking)** · gpt-image-2 | Only instruction-following models do this well.                |

**The shape of it:** Flux/klein for fast iteration and any transparent cutout →
Recraft for clean vector logos/icons → nano-banana-2 / gpt-image-2 for anything
with words or a laid-out board. glamour's exploration phase leans Flux; its
canonical/spec phase fans out by content-type.

---

## Prompting cheat-sheet (by paradigm)

**Diffusion (Flux, klein, recraft):**

- Front-load the subject; order subject → action → environment → lighting →
  style. Earlier tokens weigh more.
- Be explicit and spatial; name concrete specifics ("thick white die-cut sticker
  border", "flat shading, high contrast", "soft amethyst rim glow").
- No SD weight syntax (`(word:1.5)`); use "prominently featuring".
- No negative prompts (except juggernaut) — reword positively.
- HEX colors work on FLUX.2 + Recraft `colors` param — use for brand precision.
- klein/dev: avoid "white background" on dev (bug) → "neutral backdrop".

**Instruction-following (gpt-image-2, Gemini):**

- Write a structured brief: scene → subject → key details → artifact type →
  constraints. For boards, **enumerate each panel** explicitly.
- Quote text verbatim and name its role/font:
  `headline "Digestify" in bold rounded sans-serif, centered`. Add "verbatim —
  no substitutions" if it drifts.
- Describe spatial relationships in words ("logo top-right, mascot
  center-left").
- Gemini: render text-heavy work at **2K+**; use high-thinking for boards.
- gpt-image-2: `quality: high` for dense text; restart session between batches.

**Recraft specifics:**

- Architectural mode (structured detail) for production; quote the wordmark
  text.
- Constrain with prompt negatives ("no gradients, no shadows, no textures")
  since there's no negative-prompt param.
- `style_id` (1–5 reference images) to lock brand DNA across the asset family.
- `/text-to-vector` for SVG; budget cleanup time.

---

## Proposed generation test plan (validation)

The research is a hypothesis; generation confirms it. A spend-bounded sweep to
test the load-bearing claims, using a fixed cute+cozy+occult brief (the
Spellbook system) so cells are comparable:

1. **Text axis (the big claim).** Same logotype brief —
   `wordmark "Digestify", rounded sans-serif, amethyst` — across **recraft
   v4.1**, **nano-banana-2 (2K)**, **flux.2-flex (45 steps)**, **klein 9b**.
   Confirms the text ranking and whether Recraft vector beats raster
   instruction-following for our look.
2. **Mascot axis.** Same mascot brief across **klein 9b**, **flux.2-pro**,
   **grok quality**, **nano-banana-2**. Confirms quick-vs-final and whether grok
   earns a roster slot.
3. **Board axis.** Full composite brand-board brief on **nano-banana-2 (4K,
   high-thinking)** vs **gpt-image-2 (high)**. Confirms the board winner and
   whether we can reproduce the original ChatGPT-board quality.
4. **Transparency axis.** Sticker/icon cutout on **klein 9b** (transparent) vs
   **recraft v4.1** (vector) — confirms the isolation story for asset export.

Each cell `--n 4` where supported; eyeball in Preview; record subjective
adherence + a keep/drop per model. Findings flow back into the matrix above and
into `references/mediaforge.md`.

---

## Generation results

Run via `artifacts/model-tests/run.ts` (reusable harness; images land in
`/tmp/glamour-tests/<round>/`, not committed). Brief held constant per round.

### Axis 1 — TEXT (Digestify logo lockup: wordmark + 3-word tagline + mascot)

Tested 9 models. **Headline: text is largely a solved problem in 2026 models** —
the old "diffusion can't spell" rule is stale. Every model rendered the wordmark
**"Digestify"** correctly, and every model **except klein** also rendered the
tagline **"Synthesize. Review. Digestify."** correctly, at default settings, on
the first try, repeatably across samples.

| Model           | Wordmark | Tagline                                            | Aesthetic read (this brief)                                                                  | Verdict                        |
| --------------- | -------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------ |
| `recraft-v41`   | ✓        | ✓                                                  | Cleanest vector; textbook brand mark; perfect palette                                        | **keep**                       |
| `nano-banana-2` | ✓        | ✓                                                  | Most premium/polished; best baby-cthulhu (little wings); reliable                            | **keep**                       |
| `gpt-image-2`   | ✓        | ✓                                                  | Best _conceptual_ adherence — rendered the "eldritch librarian reading a book"; small canvas | **keep**                       |
| `flux2-pro`     | ✓        | ✓                                                  | Clean, reliable; research's "~60% first-try text" was pessimistic here                       | **keep**                       |
| `flux2-flex`    | ✓        | ✓                                                  | Good even at default steps (couldn't set 40–50 — see cap below)                              | **keep**                       |
| `grok-quality`  | ✓        | ✓                                                  | Bubbly 3D wordmark w/ drop shadow; octopus-in-moon; characterful                             | **keep (wildcard earns slot)** |
| `wan-27`        | ✓        | ✓                                                  | Solid, on-brand, sparkles+moons; confirms text-specialist billing                            | **keep (wildcard)**            |
| `ernie-turbo`   | ✓        | ✓                                                  | Clean, on-brand; cheap; confirms dense-text claim                                            | **keep (wildcard)**            |
| `klein-9b`      | ✓        | ✗ (garbles small text: "Syntesllize"/"Syntsehize") | Cute mascot, fine wordmark; small multi-word unreliable                                      | **text-weak**                  |

**Implications for routing:**

- **Don't prune for text** (except the weakest tier). The text axis no longer
  discriminates much — differentiation must come from **style range, aesthetic
  quality, and adherence on complex/composite asks** (the next axes).
- **`klein-9b` → keep as the fast exploration default, but route text-bearing
  finals elsewhere.** It nails a single large wordmark; it garbles small
  multi-word copy. (Untested `flux/schnell` is presumed worse → stays benched.)
- **`gpt-image-2` showed the strongest _conceptual_ prompt-adherence** — it
  alone picked up the implied "librarian reading a book" from the broader brief.
  Worth weighting for briefs where capturing intent matters more than pixel
  polish.
- **Wildcards `grok`, `wan`, `ernie` all passed text** and stay in for the style
  round — they may differentiate on style range.

### Tooling finding (media-forge)

`media-forge generate image` exposes
`--prompt --model --n --width --height --seed --negative-prompt` but **no
`--steps`, `--quality`, or resolution-tier flag**. Consequences:

- **`flux.2-flex` can't be dialed to its 40–50-step text sweet spot** — it ran
  at default steps (still passed text here, but its ceiling is untapped).
- **Gemini's 1K/2K/4K tier isn't directly selectable** — pushing
  `--width/--height` to 2048 worked and kept small text legible, but the native
  resolution-tier control (and `high-thinking` mode) aren't reachable.
- `gpt-image-2` `quality:high` is the fal default, so that one's fine.

→ Backlog candidate: a media-forge feature request (or a `--extra` passthrough)
for steps/quality/resolution/thinking, so the agent can reach each model's best
mode. Until then, the matrix's "Final" picks assume default knobs.

### Axis 2 — STYLE RANGE + detail coherence (cozy-occult bookshop scene × 4 styles)

8 models × 4 styles (photojournalism realism → photorealistic surrealism →
Pixar-style 3D → anime), one scene held constant. Tests both **range** (can a
model leave its house aesthetic on request?) and **detail coherence** (does the
armchair / candles / moon / teacup / glowing book all survive?).

**Headline: range is the real discriminator, and only the instruction-following
models (plus grok) genuinely have it.** Diffusion models each have a house
aesthetic they drift toward regardless of the style asked for — most notably,
**almost none produce a true 2D-cel anime or a true documentary photo of a cute
subject; they render a 3D storybook version instead.**

| Tier                          | Models                                 | Read                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **True range**                | `nano-banana-2`, `grok-quality`        | Each style genuinely distinct + high quality. nano's photojourno is a real _photo_; its anime is true cel; its 3D is true Pixar. grok read "cute + photo" as a clever _plush-toy photo_, did whimsical surreal (candle-faces, aurora), charming watercolor anime, and even rendered legible incidental book titles. |
| **Broad (illustration only)** | `recraft-v41`                          | Surprise — the **raster** endpoint is _not_ vector-locked; lovely Ghibli-style anime + solid 3D. But its "photo" still skews illustrated — no true photoreal. (Vector-lock is only the `text-to-vector` endpoint.)                                                                                                  |
| **High detail, mid range**    | `gpt-image-2`                          | Richest incidental detail (geodes, textures) and strong adherence; surreal + 3D excellent; but photo = realistic _render_ and anime = _painterly digital painting_, not cel. Excels at rich/surreal/board, not at "give me a specific 2D medium."                                                                   |
| **Mid (3D-storybook bias)**   | `klein-9b`, `flux2-pro`, `ernie-turbo` | All gravitate to a 3D render; weak _true_ 2D anime. ernie most atmospheric (but had small adherence misses — closed eyes, two teacups); klein fastest/cheapest; flux2-pro cleanest.                                                                                                                                 |
| **Narrow**                    | `juggernaut`                           | Locked to cinematic-3D even when asked for photo or anime. Its photoreal strength is for _realistic_ subjects (humans), not cute creatures → renders them as 3D toys. **Bench for cute-brand work.**                                                                                                                |

**Detail coherence** was strong across nearly all models — the scene's elements
reliably survived. The differentiator was **style-target adherence**, not scene
adherence.

**Implications for routing:**

- **Diffusion models = pick by their native aesthetic, not by asking for a style
  they don't have.** klein/flux/ernie are great when the desired look _is_ their
  house look (cute 3D storybook) and for fast iteration.
- **Need a _specific_ medium (true anime, true photo, a deliberately different
  look)? → instruction-following (`nano-banana-2`) or `grok`.** These are the
  range tools.
- **`grok-quality` decisively earns a roster slot** — broad range, high
  character, incidental-text bonus, cheap. Promote from wildcard to keeper.
- **`juggernaut` → bench** for cute/brand; keep only for realistic-human work
  (out of scope for glamour's brand use case).
- **`gpt-image-2` → reach for rich/surreal renders, detail density, and (from
  axis 1) text + composite boards — not for clean 2D-medium asks.**

### Axis 2b — IDIOMATIC STYLE (best-model-per-style, subject tailored to the style)

Where axis 2 held one (cute, non-photographic) subject constant, this round gave
each style its **own idiomatic subject** — a thing you'd actually render that
way: a weathered fisherman portrait (photojournalism, w/ a **hands/face stress
test**), a goldfish adrift in a flooded room (photoreal surrealism), a lone
robot finding a flower in a junkyard (Pixar 3D), a schoolgirl on a
blossom-strewn platform (Ghibli anime). 9 models × 4 styles, n=1.

**The headline finding — subject matter is as strong a style signal as the style
words.** Models that 3D-ified the cute cthulhu in axis 2 produced _genuine_
output here: `klein`, `ernie`, even **`recraft`** and the photoreal specialist
**`z-image`** all delivered believable documentary photos _and_ true 2D-cel
anime once the subject fit the style. The cute mascot had been dragging them
toward 3D storybook; an idiomatic subject releases the model's real range. This
is a prompting lesson for glamour as much as a routing one: **describe a subject
that belongs to the target style, don't just name the style.**

**Hands/portraiture (the realism stress test):** essentially solved in this
tier. All 9 produced plausible hands on the fisherman; only `grok` had a minor
finger quirk. No model embarrassed itself.

**Per-style winners:**

| Style                          | Winner(s)                                                                                               | Notes                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Photojournalism / portrait** | `nano-banana-2` (most editorial), `juggernaut` (crispest portrait), `z-image` (astonishing for ~$0.004) | All 9 were credible photos; these three best.                 |
| **Photoreal surrealism**       | `nano-banana-2` (cleanest), `gpt-image-2` (moodiest/fine-art)                                           | `z-image` strong + cheap.                                     |
| **Pixar 3D**                   | **`grok-quality`** (cinematic, detailed, legible "WARNING"/"STOP" text)                                 | `nano-banana-2`, `gpt-image-2` close.                         |
| **Anime (2D cel)**             | **`grok-quality`** (Ghibli watercolor, legible station sign)                                            | `nano-banana-2`, and surprises `klein` / `ernie` / `z-image`. |

**Model takeaways (refined):**

- **`grok-quality` is the breakout** — wins anime + Pixar, strong everywhere,
  and renders legible incidental text (signs, labels) no other model matches at
  this consistency. Firmly a keeper / often a first choice for stylized work.
- **`nano-banana-2`** — excellent across all four; the reliable all-rounder.
- **`gpt-image-2`** — best for moody/rich/surreal + (axis 1) text/boards.
- **`z-image/turbo`** — the value shock: credible photo, anime, and surreal at
  ~$0.004/image. Promote from "skip" to **cheap-iteration generalist** — re-test
  it more broadly.
- **`juggernaut`** — the one genuinely narrow model: even an idiomatic anime
  subject came out render/painterly, not 2D. Excellent realism, poor
  stylization. Reach for it only for photoreal humans.
- **`klein` / `ernie` / `recraft` / `flux2-pro`** — more versatile than axis 2
  suggested _when the subject is idiomatic_; weakest only when fighting their
  bias with an off-subject style request.

### Axis 3+5 — COMPOSITE BRAND BOARD (also the hardest multi-element adherence test)

Fed the **real original ChatGPT brandboard brief** for Digestify (baby-cthulhu,
moss/seafoam/lavender/indigo, sections: logo · expressions · stickers · palette
· icons · review-UI mockup · tagline) to 5 models on larger canvases. The
question: can media-forge models produce a usable multi-section brand board —
glamour's marquee deliverable — and match the original ChatGPT boards?

**Yes — decisively, for the instruction-following models.**

| Model               | Board result                                                                                                                                                                                                                                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`gpt-image-2`**   | **Champion.** Both runs agency-grade: numbered sections, legible sticker slogans ("Summarize the abyss", "Digest. Rest. Repeat."), palette with names+hex, a real review-UI mockup (key points, 92% confidence ring, star rating, "Mark as Digested"), footer taglines. Matches/beats the original ChatGPT boards (same model family). 1536², ~3MB. |
| **`nano-banana-2`** | Excellent + reliable. Cleaner/lighter layouts, exact palette (moss/seafoam/lavender/indigo + hex), labeled expressions, "Approved by the Deep Ones" charm. Two solid variants at 2K.                                                                                                                                                                |
| **`grok-quality`**  | **Surprise** — a genuinely cohesive, charming, fully-labeled board (shield logo, named swatches, legible stickers, UI mockup) at a fraction of the cost. A real third option.                                                                                                                                                                       |
| **`recraft-v41`**   | Credible _clean/minimal_ vector board — attempts real sections (its brand-tool layout DNA shows), but sparse and tiny/imperfect labels. Good for a minimal aesthetic, not a rich board.                                                                                                                                                             |
| **`flux2-pro`**     | Fails the structured board — loose collage of elements, no panels/palette/UI. Confirms **diffusion can't do multi-panel layout**; pair it with an instruction-following model for boards.                                                                                                                                                           |

**Takeaways:**

- **The board deliverable is real and single-prompt-achievable.** Route boards
  to **`gpt-image-2`** (richest) or **`nano-banana-2`** (cleaner, 2K legible);
  **`grok`** is the budget option. This also settles the **adherence axis**: the
  instruction-following models hold a 6-section layout + dozens of labels
  coherently; diffusion does not.
- For glamour: generate the _board_ with an instruction-following model, but
  generate _isolated reusable assets_ (mascot cutouts, stickers, icons) with the
  appropriate per-content-type model — the board is a presentation artifact, not
  the asset source.
- Cheap workhorses on a board: **`klein-9b`** gets the _structure_ (mascot zone,
  expressions row, palette, icons, UI panel) but **garbles every label**
  ("STYFIFY AY") — usable as a rough comp only. **`ernie-turbo`** repeatedly
  timed out on the large portrait board (its "turbo" path choking on a dense
  multi-section ask at 1024×1536).

**⚠ Prompt-provenance caveat (fairness).** The board brief is the _actual prompt
the user got from ChatGPT_, so it is ChatGPT-idiomatic and gives `gpt-image-2` a
home-turf margin. Two reasons this is a _margin_, not the result: (1) the win
tracks **architecture** — instruction-following (gpt-image-2, nano-banana-2 [a
different vendor], grok) all succeeded; both diffusion models failed regardless;
(2) we used **one ChatGPT-shaped prompt for everyone** and applied _none_ of the
per-model patterns the pre-research surfaced. A fair re-test would tailor the
board prompt per model:

- **FLUX.2 (flux2-pro/flex)** → **JSON-structured** prompt (`scene`/`subjects`/
  `style`/`layout` objects) — untried; may sharply tighten its collage.
- **Gemini/nano-banana** → explicitly **enumerated panels** + **high-thinking**
  (the latter not reachable via media-forge yet).
- **gpt-image-2** → the 5-section brief it already likes (what we used).

→ **Next investigation (now or later):** a focused web-research pass on
**composite / multi-element / brand-board prompting best-practices per model**,
then a re-run of the promising-but-behind models with a model-tailored board
prompt to see how much the gap closes. Tracks toward the model-selection matrix
carrying not just _which model_ but _how to prompt it_ for boards.

### Axis — BOARD FAIRNESS RE-TEST (resolved: both things are true)

Re-ran the Digestify board with each model prompted **its own documented way**
(per-model prompting research): `gpt-image-2` with the `THE TEXT READS: "…"`
6-part framework; `nano-banana-2` with **zone-enumerated** rows (pushed to 2K);
`flux2-flex` + `flux2-pro` with a **JSON-structured** prompt
(`scene`/`composition`/ `subjects`/`brand_colors`). Caveat: media-forge can't
set flux.2-flex steps (40–50) or Gemini thinking/resolution-tier, so those ran
below documented best.

**Result — the answer to "genuinely best vs. prompt-advantaged?" is _both_:**

- **gpt-image-2 is genuinely the ceiling.** Its tailored board is the best of
  the whole project: 6 flawless panels, 5 _labeled_ expressions with a
  consistent character, palette with **exact** names+hex (Moss #6A7E5A … Plum
  #6C4A8E), the five specified icons, and a fully realized review-UI card
  (abstract, key points, 4-star rating, "Mark as Digested"). Verbatim adherence.
  → "the latter."
- **AND the ChatGPT-shaped prompt _was_ handicapping FLUX.** With a FLUX-shaped
  **JSON** prompt, `flux2-pro`/`flex` jumped from "loose collage, can't do
  boards" (the `board` round) to **real, labeled, multi-panel boards**. The
  provenance bias was real; tailoring removed much of it. → "the former" too,
  for FLUX.
- **`nano-banana-2`** tailored: also complete + accurate, a hair less rich than
  gpt-image-2.
- **FLUX still varies run-to-run** (pro-0 had all 6 panels; pro-1 only 3) — the
  "iterate 3–5× and pick" the research warned about.

**Refined board verdict:** `gpt-image-2` ≥ `nano-banana-2` > `flux2-pro`/`flex`
(now a genuine, cheaper contender) > rest.

**The load-bearing lesson for glamour:** the model-selection matrix must carry
**per-model prompt _structure_**, not just which model — `THE TEXT READS` for
gpt-image-2, **zone-enumeration** for Gemini, **JSON** for FLUX. (Tailored
prompts live in `artifacts/model-tests/run.ts` as `BOARD_GPT` / `BOARD_NANO` /
`BOARD_FLUX_JSON`.) This also strengthens media-forge ask #3 (param
passthrough): flux.2-flex's board would likely improve further at its 40–50-step
sweet spot, which the CLI can't currently reach.

### Cost instrumentation

media-forge exposes cost two ways, now wired into the tooling:

- **`usage summary --since --until [--group-by type,provider]`** — window rollup
  (per-batch / per-day truth).
- **`jobs get <serviceJobId>`** — per-job actual cost (`costMicrosUsd`), but it
  **finalizes asynchronously** (reads `pending` right after generation; re-query
  a minute later).

Pipeline: `run.ts` records each `serviceJobId` → `costs.ts <round>` enriches the
manifest with actual per-image cost (re-runnable) → `gallery.ts` shows per-image
(actual vs. estimate), per-model subtotal, and per-round total. Older rounds
that predate id-capture fall back to a baked price-map estimate.

**Spend so far (these experiments):** idiomatic round **$1.98**, board round
**$0.88** (7 imgs — boards are big), all model-test work **≈$9 total**.
Per-image actuals confirm the ranking-vs-cost story: `z-image`/`klein`/`ernie`
are sub-cent–to–low-cent; `gpt-image-2` and 2K `nano-banana-2` are the expensive
tiers (~$0.10–0.30, and boards push gpt-image-2 higher at 1536²). Check live
totals with `media-forge usage summary --since … --until …`.

## Status

Done: pre-research · **text** · **style-range** · **idiomatic-style** ·
**composite board (+ adherence)** · **per-model composite-prompting research +
board fairness re-test** (108 test images across 5 rounds in
`artifacts/model-tests/outputs/`, browsable + costed via the generated
`gallery.html`). Also produced: **media-forge CLI feedback report**
(`docs/projects/media-forge-cli-gaps/report.md`).

**Routing folded into the spell:**
`plugins/spellbook/skills/glamour/references/ mediaforge.md` is now the agent's
routing brain — paradigms, content-type→model matrix, **per-model prompt
structure**, constraints, cost, and CLI limits.

Remaining axes (both gated on media-forge feature asks): **mascot** (hero +
expression-sheet _consistency_ — wants reference-image input, ask #1; testable
only as a single-image character sheet until then) · **transparency / isolated
cutout** (clean asset export — wants `--background`, ask #2). Pick these up once
the CLI gaps land.

## Possible future home: media-forge

This suite — the `run.ts` harness, the costed `gallery.ts`, the per-model
research, and the `costs.ts` pipeline — is really a portable **model-evaluation
kit**, and media-forge (which owns the model roster) is its natural long-term
home. Moving the image results + galleries there would let a **living capability
gallery** grow as new models are added/tested: sample outputs per content-type +
actual cost per model, answering "what is this model good at, and what does it
cost?" at a glance. The gallery is already manifest-driven, so relocation is
mostly about where manifests/images live. Captured as intent, not scheduled.
