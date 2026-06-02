# Provider reference — media-forge

How the agent turns glamour's prompts into variants using the **media-forge**
CLI. Generation is **agent-side** (house-style: the agent is the runtime); the
daemon only displays what you post. This is one provider reference; others (Fal
direct, etc.) would follow the same shape — generate → get image URL(s) → post
via `cli.ts variant --url`.

## The command

```
media-forge generate image \
  --prompt="<prompt>" \
  --model="fal-ai/flux-2/klein/9b/lora" \
  --n=4 --width=1024 --height=1024 \
  --format json
```

- Output (json): `data.outputs[].presignedUrl` (each valid ~24h), plus
  `mimeType`, `sizeBytes`, `serviceJobId`.
- `--n` up to 4 on most models → a whole variant round in one call.
- `ping` to verify config; `models list --format json` for capabilities.

## Model selection

- **Exploration rounds → `fal-ai/flux-2/klein/9b/lora`** (klein 9b, schnell's
  successor). ~5s, and it honors atmospheric asks (rim glow, crescent-moon
  marks, sparkles) better than `fal-ai/flux/schnell`.
- **Converged / canonical finals → a premium model** (`openai/gpt-image-2`,
  `fal-ai/recraft/v4.1/text-to-image`). Slower, higher fidelity.
- _(Future: a model-per-task matrix — which model suits mascots vs. logotypes
  vs. icon sheets vs. boards — may reorder this. See design-notes roadmap.)_

## Prompting these models

They are **non-reasoning** image models — be **explicit and spatial**; don't
rely on dot-connecting.

- Spell out placement: "two little curved horns **growing out of the top of the
  cat's head, between its ears**" (not just "two horns" → renders as ears).
- Name concrete style specifics: "thick **white die-cut sticker border**",
  "**flat shading, high contrast**", "soft **amethyst rim glow**".
- Use `--negative-prompt` to suppress unwanted traits (e.g. "scary, gore,
  realistic, photographic").
- Square `--width/--height` for mascots/icons (klein's default canvas runs
  small).
- Generate `--n 4` and let the user pick — that's the variants flow.
- Exploration can use smaller dims (e.g. 768²) for speed/lighter state; finals
  larger.

## The handoff

For each output URL, post it as a variant — `--url` downloads and **inlines**
it, so the image is self-contained (persists in the snapshot, survives URL
expiry):

```
bun cli.ts variant --url "<presignedUrl>" \
  --label "Mascot · amethyst" \
  --prompt "<the prompt that made it>"
```

So the full generate loop, on a `generate` / regenerate event:

1. `cli.ts status on "generating…"` _(optional — the surface auto-spins on the
   user's button press; only needed for a custom message)._
2. `media-forge generate image --prompt=… --model=fal-ai/flux-2/klein/9b/lora --n=4 --width=1024 --height=1024 --format json`
3. For each `data.outputs[].presignedUrl`:
   `cli.ts variant --url <url> --label … --prompt …`
4. `cli.ts phase variants` (if not already there).

For a fresh round, `cli.ts variants-clear` first.
