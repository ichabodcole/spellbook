---
name: magpie
description:
  Magpie extracts individual visual assets from a moodboard, branding board, or
  composite image — picks out the distinct elements (mascots, icons, stickers,
  logos, color palettes, UI mockups, type samples) and saves each as its own PNG
  file, optionally with a transparent background. Trigger when the user says
  "magpie this", "extract elements from this moodboard", "pull assets out of
  this branding board", "extract the icons/stickers/mascots from this image",
  "separate the elements in this image", or any obvious variant. Also consider
  suggesting it proactively when the user shares an AI-generated branding/style
  sheet image and the workflow needs individual asset files. Requires Python
  3.11+ and an OPENROUTER_API_KEY env var (uses Gemini 3.5 Flash via OpenRouter
  to identify elements).
---

# Magpie

A magpie picks individual shiny things out of a busy collection. This skill does
the same with images: hand it a single composite image (moodboard, branding
sheet, sticker sheet, style board) and it returns each distinct visual asset as
its own file. Background removal is applied conditionally based on what each
element is — stickers and illustrations get clean alpha; palettes and
screenshots stay whole.

## When to Use

Fire on direct asks: "magpie this", "extract elements from this moodboard",
"pull the stickers out of this image", "separate these icons", "give me each of
these assets as its own file."

Suggested invocation (propose first, don't fire): the user has just received an
AI-generated branding board or moodboard image from another agent or tool, and
the natural next step is using its elements somewhere. Example:

> "I see your branding board. Want me to use magpie to pull each element out as
> a separate file with backgrounds removed?"

Don't use for:

- A single-element image where there's nothing to extract — just rename the
  file.
- Photos with no design-asset structure (a vacation photo, a screenshot of a
  single window). Magpie is for **composite images of distinct visual assets**,
  not generic image segmentation.

## Prerequisites

Magpie runs under Python 3.11+ and uses Gemini 3.5 Flash via OpenRouter for
element discovery, plus the `rembg` library for background removal.

- **Environment:** `OPENROUTER_API_KEY` must be set in the shell environment. If
  missing, the discover step fails fast with a clear error; surface that to the
  user and stop. **Do not attempt to install a key for them.**
- **Python deps (installed once):** `pip install Pillow rembg`
  - First `rembg` run downloads a ~176MB U2Net model to `~/.u2net/`.
  - Subsequent runs are fast.

## Two-Step Workflow

The skill has two phases on purpose so the user can review what Magpie
discovered before paying for the extraction. Both steps are cheap (single- digit
cents for discover, free for extract) but the review step is the value add.

### Step 1: Discover

Run discover.py against the source image. It calls Gemini and writes a manifest
JSON describing every distinct element found.

```bash
python3 "$CLAUDE_PLUGIN_ROOT/skills/magpie/scripts/discover.py" path/to/board.png
```

Output:

- Prints cost (~$0.01-0.03/image) + token counts to stdout
- Lists each discovered element with type, name, and source-pixel bbox
- Writes a manifest file at `<source_dir>/<image_stem>-manifest.json`

Show the discovered list to the user. They may want to:

- Drop entries they don't need (edit the JSON, delete the line from
  `elements[]`)
- Rename entries (`"name": "icon_mammoth"` → `"name": "logo_mark"`)
- Override the `type` field if Magpie misclassified (this affects bg-removal in
  step 2)
- Re-run discovery if the model missed something significant

### Step 2: Extract

Run extract.py with the manifest. It crops each element from the source and
applies background removal conditionally.

```bash
python3 "$CLAUDE_PLUGIN_ROOT/skills/magpie/scripts/extract.py" path/to/board-manifest.json
```

Output:

- One PNG per element at `<element_name>.png`
- A second `<element_name>_alpha.png` for types eligible for background removal
  (see Alpha Policy below)
- A `gallery.html` for browser review
- Default output directory: `<manifest_dir>/<image_stem>-extracted/`

## Manifest Schema

```json
{
  "source": "/abs/path/to/board.png",
  "source_size": [1408, 768],
  "source_sha256_16": "abc123...",
  "model": "google/gemini-3.5-flash",
  "cost_usd": 0.0235,
  "tokens": { "prompt": 1365, "completion": 2414, "reasoning": 1389 },
  "elements": [
    {
      "name": "icon_mammoth",
      "type": "icon",
      "box_2d": [675, 43, 789, 101],
      "bbox_pixel": [61, 519, 142, 606]
    }
  ]
}
```

The `type` field is one of `wordmark`, `tagline`, `icon`, `illustration`,
`sticker`, `palette`, `typography`, `screenshot`, `other`. The agent or user can
override either `name` or `type` by editing the manifest before extract.py runs.

`box_2d` is Gemini's normalized [0..1000] coordinate output preserved for audit;
`bbox_pixel` is the [x1, y1, x2, y2] used by extract.py.

## Alpha Policy

Background removal works well for graphics on a uniform background but
**destroys flat-color content** like color palettes and screenshots. The
`--alpha` flag controls how aggressive extract.py is:

| Policy           | Applies rembg to                                        |
| ---------------- | ------------------------------------------------------- |
| `auto` (default) | `illustration`, `sticker`, `icon`, `wordmark`           |
| `all`            | everything except `palette`, `screenshot`, `typography` |
| `none`           | nothing (raw crops only)                                |

`auto` is the right default for almost all cases. Override only when the user
explicitly wants alpha on `tagline` / `other` types, or wants to skip alpha
entirely.

## Cost Awareness

Discover-step cost is printed in the script output and recorded in the manifest
at `cost_usd`. Surface this to the user — they like knowing what the model spend
was. Typical range: $0.005-0.03 per board depending on density.

`temperature=0` makes responses deterministic, so re-running discover on the
same image returns identical bboxes. A future iteration of this skill may add a
cache by `source_sha256_16` to make repeat runs free.

## Common Pitfalls

- **`OPENROUTER_API_KEY` missing.** Surface the error and stop. Do not install a
  key, do not skip the step, do not fall back silently.
- **Source image not found from manifest path.** The manifest stores an absolute
  path. If the source moves, edit the `"source"` field before running
  extract.py, or pass a fresh manifest.
- **rembg first-run download.** The first `extract.py` invocation downloads
  ~176MB of model weights. If the user is on a slow connection, warn them.
- **Manifest with no elements.** If discover returned an empty array (very
  unusual — image with no recognizable assets), tell the user and ask what they
  wanted; don't proceed with extract.
- **Element type misclassification.** If Magpie marked a screenshot as
  `illustration`, alpha-mode auto would destroy it. Spot-check the type column
  in the discover output before extracting if anything looks off.

## Why Magpie Looks the Way It Does

Magpie is the first skill in a longer arc: AI generates a branding board →
Magpie extracts the assets → a future branding skill applies them. The gallery's
branded aesthetic (warm cream + magpie-iridescent indigo + treasure-gold accent)
is the visual identity for the Magpie family. Keep it intact across future skill
additions to maintain identity continuity.
