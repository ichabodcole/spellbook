"""Magpie — crop+remove helper (gallery sub-phase).

Crops one element's bbox out of a source composite and, when the element's
type warrants it, removes the background with rembg (U2Net) to produce a clean
transparent PNG. One element per invocation — the daemon's extract loop (the
agent) calls this once per element.

This is the per-element companion to the legacy batch `extract.py`; it shares
that file's ALPHA policy (ALPHA_AUTO_TYPES / ALPHA_FORBIDDEN_TYPES) verbatim so
the two stay in lockstep, and backend.ts's `shouldRemove` mirrors the same
decision in TypeScript.

Usage:
    python3 remove.py --source <path> --bbox "x1,y1,x2,y2" --type <elementType> \
        --out <path> [--pad <px>] [--alpha auto|all|none]

Prints one JSON line to stdout on success:
    {"out": "<path>", "removed": true|false, "size": [w, h]}

Fails fast (clear stderr message + nonzero exit) on bad args / missing source.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Element types where rembg reliably produces a usable alpha. Confirmed during
# the PoC in docs/projects/moodboard-element-extraction. Kept in lockstep with
# extract.py (and mirrored by backend.ts's shouldRemove).
ALPHA_AUTO_TYPES = {"illustration", "sticker", "icon", "wordmark"}

# Element types where rembg destroys the asset (flat-color content). Never apply
# alpha to these, even under --alpha all.
ALPHA_FORBIDDEN_TYPES = {"palette", "screenshot", "typography"}


def should_remove(kind: str, policy: str) -> bool:
    """Mirror of backend.ts's shouldRemove — the alpha-policy decision."""
    if policy == "none":
        return False
    if policy == "all":
        return kind not in ALPHA_FORBIDDEN_TYPES
    # auto (default)
    return kind in ALPHA_AUTO_TYPES


def parse_bbox(raw: str) -> tuple[int, int, int, int]:
    parts = [p.strip() for p in raw.split(",")]
    if len(parts) != 4:
        raise ValueError(f'bbox must be "x1,y1,x2,y2" (got {raw!r})')
    try:
        x1, y1, x2, y2 = (int(round(float(p))) for p in parts)
    except ValueError as exc:
        raise ValueError(f"bbox values must be numbers (got {raw!r})") from exc
    if x2 <= x1 or y2 <= y1:
        raise ValueError(f"bbox must have x2>x1 and y2>y1 (got {raw!r})")
    return x1, y1, x2, y2


def main() -> int:
    ap = argparse.ArgumentParser(description="Crop + (optionally) remove background for one element.")
    ap.add_argument("--source", required=True, type=Path, help="Path to the source composite image")
    ap.add_argument("--bbox", required=True, help='Element bbox "x1,y1,x2,y2" in source pixels')
    ap.add_argument("--type", required=True, dest="kind", help="Element type (drives the alpha decision)")
    ap.add_argument("--out", required=True, type=Path, help="Output PNG path")
    ap.add_argument("--pad", type=int, default=8, help="Pad the bbox by N px on each side (default 8)")
    ap.add_argument(
        "--alpha",
        choices=["auto", "all", "none"],
        default="auto",
        help="Background-removal policy: "
        "auto = remove for illustration/sticker/icon/wordmark only (default); "
        "all = remove for everything except palette/screenshot/typography; "
        "none = never remove",
    )
    ap.add_argument(
        "--model",
        default=None,
        help="rembg model name for a specific removal (e.g. isnet-general-use, "
        "birefnet-general, u2netp, silueta). Omit for rembg's default (u2net). "
        "Used by the model-agnostic retry to run a DIFFERENT model on a flagged item.",
    )
    args = ap.parse_args()

    if not args.source.exists():
        print(f"ERROR: source image not found: {args.source}", file=sys.stderr)
        return 2

    try:
        x1, y1, x2, y2 = parse_bbox(args.bbox)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    if args.pad < 0:
        print(f"ERROR: --pad must be >= 0 (got {args.pad})", file=sys.stderr)
        return 2

    from PIL import Image

    do_remove = should_remove(args.kind, args.alpha)

    with Image.open(args.source) as src:
        w, h = src.size
        # Pad the bbox, clamped to image bounds — a too-tight bbox starves the
        # removal model of edge context (the design-notes fix).
        px1 = max(0, x1 - args.pad)
        py1 = max(0, y1 - args.pad)
        px2 = min(w, x2 + args.pad)
        py2 = min(h, y2 + args.pad)
        crop = src.crop((px1, py1, px2, py2))

        args.out.parent.mkdir(parents=True, exist_ok=True)

        if do_remove:
            from rembg import remove

            if args.model:
                # A specific rembg model (the model-agnostic retry runs a DIFFERENT
                # one than was already tried). new_session downloads it on first use.
                from rembg import new_session

                cut = remove(crop, session=new_session(args.model))
            else:
                cut = remove(crop)  # rembg's default (u2net)
            cut.save(args.out)
            out_size = cut.size
        else:
            # Raw crop, no alpha — palettes/screenshots/typography must stay whole.
            crop.save(args.out)
            out_size = crop.size

    print(
        json.dumps(
            {"out": str(args.out), "removed": do_remove, "model": args.model, "size": list(out_size)}
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
