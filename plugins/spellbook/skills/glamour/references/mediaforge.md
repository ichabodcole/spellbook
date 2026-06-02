# Provider reference — media-forge

How the glamour agent turns prompts into variants using the **media-forge** CLI,
and **which model to pick + how to prompt it** for the kind of image being made.
Generation is **agent-side** (house-style: the agent is the runtime); the daemon
only displays what you post.

> This is the decision brain. The full evidence behind every claim — model-by-
> model research and the generation experiments (text, style-range, idiomatic-
> style, board, board fairness re-test) — lives in
> `docs/projects/image-style-spell/model-research.md`. Read it when a routing
> call is non-obvious.

## The command

```
media-forge generate image \
  --prompt="<prompt>" \
  --model="<model-id>" \
  --n=4 --width=1024 --height=1024 \
  --format json
```

- Output (json): `data.outputs[].presignedUrl` (each valid ~24h), plus
  `mimeType`, `sizeBytes`, `serviceJobId`.
- `--n` up to 4 on most fal models → a whole variant round in one call. (Recraft
  and most Gemini routes are 1/call.)
- Other verbs: `models list` (capabilities), `jobs get <serviceJobId>` (per-job
  actual cost — finalizes a minute later), `usage summary --since --until`
  (spend rollup), `ping`.
- **Concurrency:** the fal tenant caps concurrent jobs at ~2 — fan out more and
  jobs queue past `--timeout` and exit **124** (looks like a timeout). Keep
  parallel generations to ~2.

## The two paradigms (pick the right kind of model first)

Every model is one of two kinds, and they fail in opposite ways:

- **Instruction-following / autoregressive** — `openai/gpt-image-2`,
  `fal-ai/nano-banana-2` (Gemini 3 "nano-banana"). They _plan layout before
  rendering_: they own **readable text**, **multi-panel boards**, **UI
  mockups**, and **true style range** (a real photo vs. a real 2D-cel anime on
  command).
- **Diffusion** — the **Flux** family, **Recraft**, the specialized models. Non-
  reasoning: be **explicit and spatial**. Each has a **house aesthetic it drifts
  toward** (most lean "cute 3D storybook"), and is the **only kind that can do
  transparency**. Great for single subjects, fast iteration, and any look that
  _is_ their native aesthetic.

One-liner: **words-in-the-image or a laid-out board → instruction-following.
Single illustrated subject, fast iteration, or a transparent cutout → diffusion.
Clean vector logo/icon → Recraft.**

## Content-type → model routing

Primary pick first; "Quick" = exploration rounds, "Final" = canonical output.

| Content-type              | Quick (explore)             | Final (canonical)                                                       |
| ------------------------- | --------------------------- | ----------------------------------------------------------------------- |
| Hero mascot               | `klein-9b` · `grok`         | `flux.2-pro` · `nano-banana-2`                                          |
| Expression sheet          | `klein-9b`                  | `flux.2-pro`/`nano-banana-2` (consistency hard — see caveat)            |
| Logotype / wordmark       | `klein-9b`                  | `recraft/v4.1` · `nano-banana-2` · `flux.2-flex`                        |
| Combination mark          | `klein-9b`                  | `recraft/v4.1` · `flux.2-flex`                                          |
| Sticker pack (cutout)     | `klein-9b` · `flux/dev`     | `flux.2-pro` (Flux only if transparency needed)                         |
| Icon system               | `klein-9b`                  | `recraft/v4.1`                                                          |
| Color palette board       | `nano-banana-2`             | `nano-banana-2` · `gpt-image-2`                                         |
| Typography specimen       | —                           | `nano-banana-2` · `gpt-image-2`                                         |
| UI mockup                 | `klein-9b` (rough)          | `nano-banana-2` · `gpt-image-2`                                         |
| Scene / illustration      | `klein-9b` · `flux.2-turbo` | `flux.2-pro` · `nano-banana-2`                                          |
| **Full composite board**  | —                           | **`gpt-image-2` ≥ `nano-banana-2`** (FLUX viable when prompted as JSON) |
| Photoreal (people/scenes) | `z-image/turbo`             | `juggernaut-flux/pro` · `nano-banana-2`                                 |

Model ids: `fal-ai/flux-2/klein/9b/lora`, `fal-ai/nano-banana-2`,
`openai/gpt-image-2`, `black-forest-labs/flux.2-pro`,
`black-forest-labs/flux.2-flex`, `fal-ai/recraft/v4.1/text-to-image`,
`xai/grok-imagine-image/quality/text-to-image`,
`rundiffusion-fal/juggernaut-flux/pro`, `fal-ai/z-image/turbo`,
`fal-ai/ernie-image/turbo`, `fal-ai/flux/dev`.

**Notable models:** `klein-9b` — fast cheap default for exploration (garbles
small multi-word text, so route text-finals elsewhere). `grok-quality` —
surprise all-rounder: broad style range + renders legible incidental text;
strong cheap pick for mascots/scenes/anime. `z-image/turbo` — astonishing value
(~$0.004): credible photo, anime, and surreal. `juggernaut` — photoreal humans
only; renders cute subjects as 3D toys, narrow range. `recraft/v4.1` — the
vector/logo/icon specialist (raster endpoint is broader than expected; a
`text-to-vector` endpoint exists for true SVG but isn't in the current
`models list`).

## Per-model prompt structure (this matters as much as model choice)

The same brand board went from "loose collage" to "agency-grade" purely by
prompting each model the way its docs recommend. **Match the prompt shape to the
model:**

- **`gpt-image-2`** — structured brief (background → subject → details →
  constraints); wrap every literal string in **`THE TEXT READS: "…"`**;
  enumerate panels for boards; `quality:high` is the fal default. Best
  conceptual adherence and richest detail.
- **`nano-banana-2` (Gemini)** — **zone-enumerated** layout ("ROW 1, left zone
  labeled '…': …"); quote text + give per-line font hints; render text-heavy
  work at **2K+** (push `--width/--height` to 2048 — the native resolution tier
  and "high-thinking" mode aren't reachable via the CLI).
- **FLUX (`flux.2-flex`/`pro`, `klein`)** — non-reasoning: **explicit +
  spatial** ("two small curved horns growing out of the top of the cat's head,
  between its ears"), front-load the subject, name concrete style specifics, HEX
  colors work. For a **board**, pass a **JSON-structured** prompt as the prompt
  string (`scene`/`composition`/`subjects`/`brand_colors`) — this is what
  rescues FLUX's layout. Prefer `flux.2-flex` for text (wants 40–50 steps — _not
  settable via the CLI yet_, so it runs below its best). No negative prompts
  (except `juggernaut`). FLUX boards vary run-to-run — generate `--n` and pick.
- **`recraft/v4.1`** — architectural/structured prompting; quote the wordmark;
  constrain with prompt-side negatives ("no gradients, no shadows"); it has no
  negative-prompt/seed param on fal.

Worked, ready-to-use board prompts per model live in
`docs/projects/image-style-spell/artifacts/model-tests/run.ts` as `BOARD_GPT` /
`BOARD_NANO` / `BOARD_FLUX_JSON`.

General diffusion-prompt hygiene: spell out placement; name style specifics
("thick white die-cut sticker border", "flat shading, high contrast", "soft
amethyst rim glow"); square dims for mascots/icons; on `flux/dev` avoid "white
background" (bug) → "neutral backdrop".

## Two findings that change how you prompt

- **Text is largely solved** in 2026 models — wordmarks + short taglines render
  correctly first-try on nearly everything (klein is the weak exception). Don't
  avoid text; do route small-dense-text finals to instruction-following models.
- **Subject matter is as strong a style signal as the style words.** A model
  that 3D-ifies a cute mascot will produce a true documentary photo when given a
  fisherman, and true cel anime when given a schoolgirl-at-sunset. So **describe
  a subject that belongs to the target style** — don't just name the style.

## Constraints that override preference

- **Transparency:** `gpt-image-2` can't; **Flux** can. Isolated cutouts
  (stickers/icons/mascots for compositing) → Flux. (media-forge has no
  `--background` flag yet — see CLI limits.)
- **`num_images`:** `--n`≤4 on flux schnell/dev, flux-2 turbo/klein,
  gpt-image-2; **1/call** on recraft and most Gemini routes (need N separate
  calls for a set).
- **Seed:** flux family + juggernaut expose `--seed`; gpt-image-2 / Gemini /
  recraft (on fal) do **not** — lock the prompt instead.
- **Negative prompts:** only `juggernaut-flux/pro`. Everyone else: reword
  positively ("sharp focus" not "no blur").
- **Watermark:** all Gemini outputs carry an invisible SynthID + C2PA.

## Cost awareness

Per-image actuals (lock with `jobs get`): `z-image`/`klein`/`ernie` are
sub-cent–to–low-cent; `recraft`/`juggernaut`/`flux.2` mid; `nano-banana-2` (esp.
2K) and `gpt-image-2` (esp. boards at 1536²+) are the expensive tiers
(~$0.10–0.30/image). So: **explore cheap (klein/grok/z-image), spend on the
canonical finals.** Check spend with
`media-forge usage summary --since <iso> --until <iso> [--group-by type,provider]`.

## CLI limitations (today)

media-forge `generate image` is **text-to-image only** and exposes
`--prompt --model --n --width --height --seed --negative-prompt`. It can **not**
set steps/guidance, quality, resolution-tier, "thinking" mode, transparency, or
pass a **reference image** — which caps flux.2-flex (steps), Gemini (tier/
thinking), and blocks reference-driven **character consistency** and **influence
→ output** entirely. These are filed as asks in
`docs/projects/media-forge-cli-gaps/report.md`; until they land, route around
the gaps (e.g. expression-sheet consistency is best-effort via a single
character sheet, not reference conditioning).

## The handoff

For each output URL, post it as a variant — `--url` downloads and **inlines**
it, so the image is self-contained (persists in the snapshot, survives URL
expiry):

```
bun cli.ts variant --url "<presignedUrl>" \
  --label "Mascot · amethyst" \
  --prompt "<the prompt that made it>"
```

The full generate loop, on a `generate` / regenerate event:

1. `cli.ts status on "generating…"` _(optional — the surface auto-spins on the
   user's button press)._
2. `media-forge generate image --prompt=… --model=<routed model> --n=4 --width=1024 --height=1024 --format json`
3. For each `data.outputs[].presignedUrl`:
   `cli.ts variant --url <url> --label … --prompt …`
4. `cli.ts phase variants` (if not already there).

For a fresh round, `cli.ts variants-clear` first.
