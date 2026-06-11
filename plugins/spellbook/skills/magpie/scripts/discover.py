"""Magpie — discover phase.

Calls Gemini 3.5 Flash via OpenRouter on a moodboard / branding board image,
asks the model to identify every distinct extractable visual element, and
writes a manifest JSON describing them.

The manifest is human-editable: the agent reviews it, optionally edits or
prunes entries (e.g., drop "tagline" if not wanted), then hands it to
extract.py which produces the actual cropped image files.

Usage:
    export OPENROUTER_API_KEY=...
    python3 discover.py <image> [--out <manifest.json>] [--model <model>]

Outputs:
    <image_dir>/<image_stem>-manifest.json    (default location)
    or the path given via --out

The manifest schema is documented in SKILL.md.
"""

from __future__ import annotations
import argparse
import base64
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from urllib import request, error

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "google/gemini-3.5-flash"

PROMPT = """Identify every distinct extractable visual element in this image. \
"Distinct extractable" means: a single visually-coherent asset a designer would \
want to pull out as its own file — a logo, an icon, a sticker, a color swatch \
row, a piece of cover art, a UI screenshot. Do NOT include background, texture, \
or surrounding canvas.

For each element, return a bounding box using Google's normalized coordinate \
system (image is [0, 1000] on both axes, 0,0 top-left) in the documented order: \
[y_min, x_min, y_max, x_max].

Return ONLY a JSON array, no prose, in this exact shape:
[
  {"name": "<short_snake_case_name>", "type": "<one of: wordmark, tagline, icon, illustration, sticker, palette, typography, screenshot, other>", "box_2d": [y_min, x_min, y_max, x_max]}
]

Naming rules:
- Use distinctive snake_case names; if there are multiple of the same kind, \
  differentiate descriptively (icon_mammoth, icon_gear, sticker_coffee, \
  sticker_skateboard).
- The `type` field is critical — extract.py uses it to decide whether to \
  run background removal.
"""


MAX_IMAGE_BYTES = 30 * 1024 * 1024  # OpenRouter vision endpoints reject very
                                    # large payloads with non-actionable 4xx;
                                    # bail with a clearer error first.
WARN_IMAGE_BYTES = 15 * 1024 * 1024


def encode_image_data_url(path: Path) -> str:
    size = path.stat().st_size
    if size > MAX_IMAGE_BYTES:
        raise SystemExit(
            f"ERROR: {path.name} is {size / 1_048_576:.1f} MB, above the "
            f"{MAX_IMAGE_BYTES // 1_048_576} MB limit. Resize before retrying "
            f"(e.g., ImageMagick: `magick {path.name} -resize 2000x2000\\> {path.stem}-small{path.suffix}`)."
        )
    if size > WARN_IMAGE_BYTES:
        print(f"WARN: {path.name} is {size / 1_048_576:.1f} MB; large requests "
              f"sometimes hit OpenRouter's payload limits.", file=sys.stderr)
    suffix = path.suffix.lower()
    mime = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
    }.get(suffix, "image/png")
    b64 = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{b64}"


def parse_bboxes(content: str) -> list[dict]:
    """Strip optional ```json fences and parse the JSON array."""
    s = content.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)\s*```", s, re.DOTALL)
    if fence:
        s = fence.group(1)
    return json.loads(s)


def normalized_to_pixel(box: list[int], width: int, height: int) -> list[int]:
    """Convert Gemini's [y_min, x_min, y_max, x_max] (0..1000) to source pixels."""
    y1, x1, y2, x2 = box
    px1 = max(0, round(x1 / 1000 * width))
    py1 = max(0, round(y1 / 1000 * height))
    px2 = min(width, round(x2 / 1000 * width))
    py2 = min(height, round(y2 / 1000 * height))
    return [px1, py1, px2, py2]


def get_image_size(path: Path) -> tuple[int, int]:
    from PIL import Image
    with Image.open(path) as img:
        return img.size


def call_openrouter(api_key: str, model: str, image_data_url: str, prompt: str) -> dict:
    body = {
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": image_data_url}},
            ],
        }],
        "temperature": 0,
    }
    req = request.Request(
        OPENROUTER_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/ichabodcole/spellbook",
            "X-Title": "magpie",
        },
        method="POST",
    )
    try:
        with request.urlopen(req, timeout=180) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace")
        raise SystemExit(f"OpenRouter HTTP {e.code}: {body_text}") from None


def main() -> int:
    ap = argparse.ArgumentParser(description="Discover extractable elements in a moodboard image.")
    ap.add_argument("image", type=Path, help="Path to source image (PNG/JPG/WebP)")
    ap.add_argument("--out", type=Path, default=None, help="Manifest output path (default: <image>-manifest.json)")
    ap.add_argument("--model", default=DEFAULT_MODEL, help=f"OpenRouter model id (default: {DEFAULT_MODEL})")
    args = ap.parse_args()

    if not args.image.exists():
        print(f"ERROR: image not found: {args.image}", file=sys.stderr)
        return 2
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        print("ERROR: OPENROUTER_API_KEY env var not set", file=sys.stderr)
        return 2

    W, H = get_image_size(args.image)
    image_url = encode_image_data_url(args.image)
    image_hash = hashlib.sha256(args.image.read_bytes()).hexdigest()[:16]

    print(f"Source: {args.image.name} ({W}×{H})")
    print(f"Model:  {args.model}")
    print()

    resp = call_openrouter(api_key, args.model, image_url, PROMPT)
    try:
        content = resp["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as ex:
        print(f"ERROR: unexpected response shape from OpenRouter "
              f"(no choices[0].message.content): {ex}\n\n"
              f"Full response:\n{json.dumps(resp, indent=2)[:2000]}", file=sys.stderr)
        return 1

    usage = resp.get("usage", {})
    cost = usage.get("cost", 0.0)
    prompt_tokens = usage.get("prompt_tokens", 0)
    completion_tokens = usage.get("completion_tokens", 0)
    reasoning_tokens = usage.get("completion_tokens_details", {}).get("reasoning_tokens", 0)

    try:
        elements_raw = parse_bboxes(content)
    except json.JSONDecodeError as ex:
        print(f"ERROR: model returned non-JSON output:\n{content}\n\nParse error: {ex}", file=sys.stderr)
        return 1

    elements = []
    for entry in elements_raw:
        name = entry.get("name")
        kind = entry.get("type", "other")
        box = entry.get("box_2d")
        if not name or box is None:
            continue
        elements.append({
            "name": name,
            "type": kind,
            "box_2d": box,
            "bbox_pixel": normalized_to_pixel(box, W, H),
        })

    manifest = {
        "source": str(args.image.resolve()),
        "source_size": [W, H],
        "source_sha256_16": image_hash,
        "model": args.model,
        "cost_usd": cost,
        "tokens": {
            "prompt": prompt_tokens,
            "completion": completion_tokens,
            "reasoning": reasoning_tokens,
        },
        "elements": elements,
    }

    out_path = args.out or args.image.parent / f"{args.image.stem}-manifest.json"
    out_path.write_text(json.dumps(manifest, indent=2))

    print(f"Discovered {len(elements)} element(s) — cost ${cost:.4f} "
          f"(prompt={prompt_tokens}, completion={completion_tokens}, "
          f"reasoning={reasoning_tokens}):\n")
    type_pad = max((len(e["type"]) for e in elements), default=4)
    name_pad = max((len(e["name"]) for e in elements), default=4)
    for e in elements:
        bx = e["bbox_pixel"]
        print(f"  {e['type']:<{type_pad}}  {e['name']:<{name_pad}}  "
              f"src=({bx[0]},{bx[1]},{bx[2]},{bx[3]})")
    print(f"\nManifest written: {out_path}")
    print(f"Next: python3 extract.py {out_path.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
