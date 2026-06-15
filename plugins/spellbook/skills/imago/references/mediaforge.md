# Provider reference — media-forge

How the imago agent turns prompts into variants using the **media-forge** CLI,
and **which model to pick + how to prompt it** for the kind of image being made.
Generation is **agent-side** (house-style: the agent is the runtime); the daemon
only displays what you post.

> This is the decision brain — self-contained for routing and prompting; you
> need nothing outside this skill to use it. (The full model-by-model evidence
> behind these calls lives in the Spellbook source repo, not in the installed
> skill.)

## The command

```
media-forge generate image \
  --prompt="<prompt>" \
  --model="<model-id>" \
  --n=4 --width=1024 --height=1024 \
  --format json
```

- Output (json): each image is an entry in `data.outputs[]` → `presignedUrl`
  (valid ~24h), `mimeType`, `sizeBytes`. The **`serviceJobId` is job-level (one
  per call), not a per-output field** — read it from the top of the response (or
  use `--no-wait`, which returns the id immediately) and pass it to
  `jobs get <serviceJobId>` for actual cost.
- `--n` up to 4 on most fal models → a whole variant round in one call. (Recraft
  is 1/call. fal `nano-banana-2`/`gemini-3.1` **do** honor `--n` — verified
  `num_images:2`→2; the OpenRouter gemini twins may be 1/call — unverified.)
- **Transform verbs** (image→image, not text-to-image): `generate image --ref`
  (edit / consistency), `generate bg-remove` (→ transparent PNG),
  `generate inpaint` (masked region swap). See **Reference images & edit** and
  **Transform operations** below.
- Other verbs: `models list` (capabilities + per-model `operations`),
  `jobs get <serviceJobId>` (per-job actual cost — finalizes a minute later),
  `usage summary --since --until` (spend rollup), `status` (api/db/redis/worker/
  queue readiness), `ping`.
- **Concurrency:** the fal tenant caps concurrent jobs at ~2 — fan out more and
  jobs queue past `--timeout` and exit **124** (looks like a timeout). Keep
  parallel generations to ~2. `media-forge status` shows
  `queue.{waiting,active}` — check it to tell a real timeout from a backed-up
  queue.

## The two paradigms (pick the right kind of model first)

Every model is one of two kinds, and they fail in opposite ways:

- **Instruction-following / autoregressive** — `openai/gpt-image-2`,
  `fal-ai/nano-banana-2` (Gemini 3 "nano-banana"). They _plan layout before
  rendering_: they own **readable text**, **multi-panel boards**, **UI
  mockups**, and **true style range** (a real photo vs. a real 2D-cel anime on
  command).
- **Diffusion** — the **Flux** family, **Recraft**, the specialized models. Non-
  reasoning: be **explicit and spatial**. Each has a **house aesthetic it drifts
  toward** (most lean "cute 3D storybook"). Great for single subjects, fast
  iteration, and any look that _is_ their native aesthetic.

One-liner: **words-in-the-image or a laid-out board → instruction-following.
Single illustrated subject or fast iteration → diffusion. Clean vector logo/icon
→ Recraft. Reference/edit (consistency) → see Reference images.**

## Content-type → model routing

Primary pick first; "Quick" = exploration rounds, "Final" = canonical output.

| Content-type              | Quick (explore)             | Final (canonical)                                                                    |
| ------------------------- | --------------------------- | ------------------------------------------------------------------------------------ |
| Hero mascot               | `klein-9b` · `grok`         | `flux.2-pro` · `nano-banana-2`                                                       |
| Expression sheet          | `klein-9b`                  | `nano-banana-2` via **`--ref`** (reuse the hero's output URL — see Reference images) |
| Logotype / wordmark       | `klein-9b`                  | `recraft/v4.1` · `nano-banana-2` · `flux.2-flex`                                     |
| Combination mark          | `klein-9b`                  | `recraft/v4.1` · `flux.2-flex`                                                       |
| Sticker pack (cutout)     | `klein-9b` · `flux/dev`     | `nano-banana-2`/`flux.2-pro` → **`bg-remove`** for true cutout                       |
| Icon system               | `klein-9b`                  | `recraft/v4.1`                                                                       |
| Color palette board       | `nano-banana-2`             | `nano-banana-2` · `gpt-image-2`                                                      |
| Typography specimen       | —                           | `nano-banana-2` · `gpt-image-2`                                                      |
| UI mockup                 | `klein-9b` (rough)          | `nano-banana-2` · `gpt-image-2`                                                      |
| Scene / illustration      | `klein-9b` · `flux.2-turbo` | `flux.2-pro` · `nano-banana-2`                                                       |
| **Full composite board**  | —                           | **`gpt-image-2` ≥ `nano-banana-2`** (FLUX viable when prompted as JSON)              |
| Photoreal (people/scenes) | `z-image/turbo`             | `juggernaut-flux/pro` · `nano-banana-2`                                              |

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

Build each board prompt in the per-model shape above — a structured brief for
`gpt-image-2`, a zone-enumerated layout for `nano-banana-2`, and a
JSON-structured prompt string (`scene`/`composition`/`subjects`/`brand_colors`)
for FLUX.

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

- **Transparency:** no generator emits alpha directly (not a Flux/recraft param;
  recraft's `background_color` sets a color, not alpha). Get a cutout by running
  **`generate bg-remove`** on any finished image — now a first-class verb (see
  **Transform operations**). So: generate on the best-fit model, then bg-remove.
- **`num_images`:** `--n`≤4 on flux schnell/dev, flux-2 turbo/klein,
  gpt-image-2, and fal `nano-banana-2`/`gemini-3.1` (verified —
  `num_images:2`→2). **1/call** on recraft (single image in/out); OpenRouter
  gemini/flux twins unverified.
- **Seed:** flux family + juggernaut expose `--seed`; gpt-image-2 / Gemini /
  recraft (on fal) do **not** — lock the prompt instead.
- **Negative prompts:** only `juggernaut-flux/pro`. Everyone else: reword
  positively ("sharp focus" not "no blur").
- **Watermark:** all Gemini outputs carry an invisible SynthID + C2PA.

## Reference images & edit (character + style consistency)

`--ref <url|path>` conditions generation on a reference image and routes to the
model's edit endpoint. This is **imago's edit path** — the other half of the
loop. **Validated end-to-end** (URL refs + local-file upload).

**Reasoning models edit without a mask.** `nano-banana-2` / `gpt-image-2` /
`grok` take a whole-image `--ref` + a natural instruction — _"replace the rose
with a door", "add a knitted scarf, move the acorn right, keep the palette"_ —
and reason about _where_ themselves. So imago's annotation marks (arrow / pin)
are passed **as part of that instruction** (you describe what the user marked),
not as a pixel mask. Explicit `inpaint` masks are a deferred follow-up, for the
non-reasoning models that need them (see Transform operations). For V1: focus or
mark a variant → generate with `--ref <its path/url>` + a prompt describing the
change → post an **edit** batch.

Two ingest shapes:

- **local file** — `--ref ./influence.png` auto-uploads (presigned PUT) then
  edits.
- **output URL / variant path — the loop-closer** — reuse the focused variant's
  on-disk `path` (from `/state`) or a presigned output URL as `--ref` to carry a
  character/look forward. This is how imago does an **edit**: the user focuses
  or marks a variant, you `--ref` it and prompt the change ("same fox, add a
  scarf; keep the style + composition"), then post an `--kind edit` batch.

Key points:

- **Role is prompt-expressed, not a flag** — say "the exact same character from
  the reference, now <pose>, keep its colors/style." (No style-vs-subject
  field.)
- **Repeat `--ref` for multiple references.** Cap per model is discoverable:
  `models list` → `operations.edit.maxRefs` (e.g. nano-banana-2: 14,
  flux-2/turbo: 4). `operations: null` = not edit-capable (recraft's edit is a
  separate image-to-image lane; gpt-image-2 not declared as of now).
- **Presigned refs expire ~24h** — reuse promptly; a stale/404 ref → opaque
  error.
- `nano-banana-2` holds identity strongly across edits (great for consistency;
  small pose asks stay subtle). Validated: one mascot → "reading a spellbook" /
  "waving" kept identical body / face / palette / style.

## Transform operations (image→image, separate verbs)

These take an image **in** and route to a dedicated endpoint — discover them via
`models list` → the model's `operations` key. They run on their **own model
ids**, not the generators.

- **`generate bg-remove --model <id> --ref <url|path>`** → transparent PNG.
  Prompt-less, exactly one image in. Models: `fal-ai/bria/background/remove`,
  `fal-ai/ideogram/remove-background` (`operations.bg-remove`,
  `supportsGenerate: false`). This is imago's cutout path for stickers /
  isolated mascots / icons.
- **`generate inpaint --model <id> --ref <url|path> --mask <url|path> --prompt "<what to paint>"`**
  → regenerates only the masked region. **Mask convention: WHITE = regenerate,
  BLACK = keep**; mask must match the base's dimensions. Models:
  `fal-ai/flux-pro/v1/fill`, `fal-ai/flux-lora/inpainting`
  (`operations.inpaint`, single ref). Use for targeted swaps ("change just the
  banner text", "replace the background object") without re-rolling the whole
  image.
- Both accept local files (auto-uploaded) or URLs — including a generated output
  URL, same loop-closer as `--ref`.

_Verb surface confirmed live; not yet exercised end-to-end by imago — treat the
behavior notes (mask polarity, identity hold) as schema-grounded until a real
pass runs._

## Cost awareness

Per-image actuals (lock with `jobs get`): `z-image`/`klein`/`ernie` are
sub-cent–to–low-cent; `recraft`/`juggernaut`/`flux.2` mid; `nano-banana-2` (esp.
2K) and `gpt-image-2` (esp. boards at 1536²+) are the expensive tiers
(~$0.10–0.30/image). So: **explore cheap (klein/grok/z-image), spend on the
canonical finals.** Check spend with
`media-forge usage summary --since <iso> --until <iso> [--group-by type,provider]`.

## CLI limitations (today)

**Shipped — no longer blocked:** reference/edit (`--ref`, character
consistency + influence→output), **transparency** (`generate bg-remove`), and
**masked edits** (`generate inpaint`). The whole image→image transform axis is
live.

Still **not** exposed: provider param passthrough — steps/guidance (caps
flux.2-flex text), quality, Gemini resolution-tier + "thinking" mode (no
`--param`) — and **vector/SVG output** (recraft's `text-to-vector` endpoint
isn't in `models list`; v4.1 declares no vector op). These remain known gaps
(provider param passthrough, vector/SVG output) — until they land, take each
model at its defaults.

Two validated gotchas: **nano-banana-2 ignores `--width/--height`** (wants its
own aspect/resolution; you'll get its default aspect, not your square), and a
**stale/404 ref URL** surfaces as an opaque `Unprocessable Entity` — presigned
refs expire ~24h, so reuse them promptly.

## The handoff — posting results into the conversation

`cli.ts batch` takes the produced images as positional srcs (presigned URLs,
`data:` URLs, or local paths) and **inlines** each, so they're self-contained
(persist in the snapshot, survive URL expiry) and a result message + the batch
land in the surface in one call:

```
bun cli.ts batch \
  --kind generate \
  --prompt "<the settled prompt>" \
  --tag "a fox under an oak" \
  --summary "Kept all 4 — pick one to focus, or tell me what to change." \
  "<presignedUrl1>" "<presignedUrl2>" "<presignedUrl3>" "<presignedUrl4>"
```

The first variant auto-focuses if nothing is focused yet.

**The generate loop** (reacting to events on `cli.ts tail`):

1. **`say`** event — the user expressed intent. Interpret it; reply with
   `cli.ts say "<your read>"`, then `cli.ts propose "<prompt>" --n 4` (the
   surface shows a Send card).
2. **`proposal.send`** event — they confirmed. `cli.ts status on "generating…"`,
   then
   `media-forge generate image --prompt="<the proposal>" --model=<routed> --n=4 --format json`.
3. `cli.ts batch --kind generate --prompt "<…>" --tag "<…>" <url…>`, then
   `cli.ts status off`.

**The edit loop** (a `marks.commit` event, a `variant.like` + a change request,
or a plain `say` about the focused image): read the focused variant's `path`
from `cli.ts state`, generate with `--ref <path>` + an instruction that includes
whatever the user marked, then:

```
bun cli.ts batch --kind edit --edited-from <variantId> \
  --prompt "<the edit instruction>" "<resultUrl…>"
```

Other reactions: `style.capture` → analyze the focused image, then
`cli.ts style "<name>"` to add it to the catalog. `ref.add` → factor the
attached reference into the next generation (`--ref` it). Ambiguous intent →
`cli.ts ask "<question>" --options "a|b"` (or `handoff` to the terminal).
