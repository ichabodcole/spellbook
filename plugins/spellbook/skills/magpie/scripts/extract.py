"""Magpie — extract phase.

Reads a manifest produced by discover.py and writes one cropped PNG per
element. Optionally applies background removal (rembg) based on the
`type` field of each element — rembg destroys flat-color content
(palettes, screenshots), so this is conditional by type, not unconditional.

Also produces a self-contained gallery.html in the output directory so
the user can review the extracted assets in a browser.

Usage:
    python3 extract.py <manifest.json> [--out <dir>] [--alpha auto|all|none] [--no-gallery]

Outputs:
    <out>/<element_name>.png             (every element)
    <out>/<element_name>_alpha.png       (only for types eligible for rembg)
    <out>/gallery.html                   (review page, opens in any browser)

The default output directory is <manifest_dir>/<image_stem>-extracted/.
"""

from __future__ import annotations
import argparse
import base64
import html
import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
ASSETS_DIR = SCRIPT_DIR.parent / "assets"

# Element types where rembg reliably produces a usable alpha. Confirmed during
# the PoC in docs/projects/moodboard-element-extraction.
ALPHA_AUTO_TYPES = {"illustration", "sticker", "icon", "wordmark"}

# Element types where rembg destroys the asset (flat-color content). Never
# apply alpha to these, even under --alpha all.
ALPHA_FORBIDDEN_TYPES = {"palette", "screenshot", "typography"}


def safe_filename(name: str) -> str:
    s = "".join(c if c.isalnum() or c in "-_." else "_" for c in name or "")
    s = s.lstrip(".")  # avoid producing hidden dotfiles
    return s or "element"


def main() -> int:
    ap = argparse.ArgumentParser(description="Extract elements from a Magpie manifest.")
    ap.add_argument("manifest", type=Path, help="Path to manifest JSON from discover.py")
    ap.add_argument("--out", type=Path, default=None, help="Output directory (default: <image_stem>-extracted/)")
    ap.add_argument(
        "--alpha",
        choices=["auto", "all", "none"],
        default="auto",
        help="Background removal policy: "
             "auto = remove bg for illustration/sticker/icon/wordmark only (default); "
             "all = remove bg for everything except palette/screenshot/typography; "
             "none = skip rembg entirely",
    )
    ap.add_argument("--no-gallery", action="store_true", help="Skip gallery.html generation")
    args = ap.parse_args()

    if not args.manifest.exists():
        print(f"ERROR: manifest not found: {args.manifest}", file=sys.stderr)
        return 2

    manifest = json.loads(args.manifest.read_text())
    source = Path(manifest["source"])
    if not source.exists():
        print(f"ERROR: source image referenced in manifest not found: {source}", file=sys.stderr)
        return 2

    elements = manifest.get("elements", [])
    if not elements:
        print("ERROR: manifest contains no elements", file=sys.stderr)
        return 1

    out_dir = args.out or args.manifest.parent / f"{source.stem}-extracted"
    out_dir.mkdir(parents=True, exist_ok=True)

    from PIL import Image

    # Lazy-import rembg only if alpha will actually run; it loads a 176MB model
    # on first use, and `--alpha none` should be free.
    remove_bg = None
    if args.alpha != "none":
        from rembg import remove
        remove_bg = remove

    cropped = 0
    alphaed = 0
    written: list[Path] = []  # files this run produced; used for the zip so
                              # stale PNGs from prior runs don't leak in.

    with Image.open(source) as src_img:
        print(f"Source: {source.name}  ({src_img.size[0]}×{src_img.size[1]})")
        print(f"Manifest: {args.manifest.name}  ({len(elements)} elements)")
        print(f"Alpha policy: {args.alpha}")
        print(f"Output: {out_dir}/\n")

        for entry in elements:
            name = safe_filename(entry.get("name", ""))
            kind = entry.get("type", "other")
            bbox = entry.get("bbox_pixel")
            if not bbox or len(bbox) != 4:
                print(f"  SKIP {name}: missing bbox_pixel")
                continue
            x1, y1, x2, y2 = bbox
            crop = src_img.crop((x1, y1, x2, y2))
            crop_path = out_dir / f"{name}.png"
            crop.save(crop_path)
            written.append(crop_path)
            cropped += 1

            do_alpha = False
            if args.alpha == "all":
                do_alpha = kind not in ALPHA_FORBIDDEN_TYPES
            elif args.alpha == "auto":
                do_alpha = kind in ALPHA_AUTO_TYPES
            if do_alpha and remove_bg is not None:
                cut = remove_bg(crop)
                alpha_path = out_dir / f"{name}_alpha.png"
                cut.save(alpha_path)
                written.append(alpha_path)
                alphaed += 1
                print(f"  {kind:<13} {name}.png + _alpha.png  ({crop.size[0]}×{crop.size[1]})")
            else:
                note = ""
                if args.alpha != "none":
                    note = " (alpha skipped: " + (
                        "type in forbidden list" if kind in ALPHA_FORBIDDEN_TYPES
                        else "type not in auto list"
                    ) + ")"
                print(f"  {kind:<13} {name}.png{note}  ({crop.size[0]}×{crop.size[1]})")

    if not args.no_gallery:
        zip_path = write_assets_zip(out_dir, source.stem, written)
        gallery_path = write_gallery(out_dir, source, manifest, elements, args.alpha, zip_path.name)
        print(f"Gallery: {gallery_path}")
        print(f"Zip:     {zip_path}")

    print(f"\nDone. {cropped} crops + {alphaed} alpha variants in {out_dir}/")
    return 0


def write_assets_zip(out_dir: Path, stem: str, files: list[Path]) -> Path:
    """Bundle the explicitly-written files into a single .zip — passing the
    list (rather than globbing the directory) keeps stale PNGs from a prior
    run from leaking into the new zip."""
    import zipfile
    zip_path = out_dir / f"{stem}-magpie-assets.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(files, key=lambda f: f.name):
            zf.write(p, arcname=p.name)
    return zip_path


GALLERY_CSS = """
/* Magpie brand palette — pulled directly from the Magpie branding board.
   --ink:        #001117   deep magpie plumage
   --slate:      #1E293B   secondary ink
   --indigo:     #6366F1   primary iridescent
   --indigo-soft:#A5B4FC   tint of the iridescent
   --cyan:       #20E0E0   accent iridescence (wing sheen)
   --paper:      #F3F4F6   cool light gray (the magpie's belly)
*/
@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Poppins:wght@600;700&display=swap");
:root {
  --ink: #001117;
  --slate: #1E293B;
  --indigo: #6366F1;
  --indigo-soft: #A5B4FC;
  --cyan: #20E0E0;
  --paper: #F3F4F6;
  --card: #ffffff;
  --muted: #64748b;
  --line: #e2e8f0;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI",
       Roboto, sans-serif; background: var(--paper); color: var(--ink);
       padding: 32px; line-height: 1.55; font-weight: 400; }
.wordmark { font-family: "Poppins", "Inter", sans-serif; font-size: 32px;
            font-weight: 700; letter-spacing: -0.02em; color: var(--ink);
            display: inline-flex; align-items: center; gap: 10px; }
.wordmark::after { content: ""; width: 12px; height: 12px; border-radius: 50%;
                   background: var(--cyan);
                   box-shadow: 0 0 0 3px rgba(32, 224, 224, 0.18); }
header { margin-bottom: 40px; padding-bottom: 24px;
         border-bottom: 2px solid var(--line); }
h1 { font-family: "Poppins", sans-serif; font-size: 20px; font-weight: 600;
     margin: 14px 0 8px; color: var(--slate); letter-spacing: -0.01em; }
h2 { font-family: "Poppins", sans-serif; font-size: 11px;
     text-transform: uppercase; letter-spacing: 0.16em; color: var(--indigo);
     margin: 40px 0 16px; font-weight: 600;
     display: flex; align-items: center; gap: 12px; }
h2::before { content: ""; width: 18px; height: 2px;
             background: linear-gradient(90deg, var(--indigo), var(--cyan));
             border-radius: 2px; }
h2 .count { color: var(--muted); font-weight: 500; letter-spacing: 0.02em; }
.meta { color: var(--muted); font-size: 12px; font-weight: 500; }
.meta strong { color: var(--slate); font-weight: 600; }
.meta-row { margin-top: 6px; }
.source-preview { max-width: 100%; max-height: 280px; margin-top: 16px;
                  border-radius: 8px; border: 1px solid var(--line);
                  box-shadow: 0 2px 8px rgba(0, 17, 23, 0.06); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: 16px; }
.card { background: var(--card); border: 1px solid var(--line);
        border-radius: 12px; padding: 14px; transition: all 0.15s ease;
        box-shadow: 0 1px 2px rgba(0, 17, 23, 0.03); }
.card:hover { border-color: var(--indigo); transform: translateY(-2px);
              box-shadow: 0 6px 20px rgba(99, 102, 241, 0.14); }
.card-name { font-family: "Inter", sans-serif; font-size: 13px;
             font-weight: 600; margin-bottom: 3px; color: var(--ink);
             word-break: break-all; letter-spacing: -0.005em; }
.card-meta { font-size: 10px; color: var(--muted); margin-bottom: 12px;
             font-variant-numeric: tabular-nums; font-family:
             "SF Mono", Monaco, "Cascadia Code", monospace; }
.thumbs { display: flex; gap: 6px; align-items: flex-start;
          background: repeating-conic-gradient(#e2e8f0 0deg 90deg,
                       var(--paper) 90deg 180deg) 0 0/12px 12px;
          padding: 8px; border-radius: 6px; border: 1px solid var(--line); }
.thumb { flex: 1; min-width: 0; }
.thumb img { width: 100%; height: auto; display: block; border-radius: 2px; }
.thumb-label { font-family: "Inter", sans-serif; font-size: 9px;
               color: var(--muted); text-align: center; margin-top: 6px;
               text-transform: uppercase; letter-spacing: 0.1em;
               font-weight: 600; }
a { color: inherit; text-decoration: none; }

/* Brand row: extracted wordmark + mascot + download-all CTA */
.brand-row { display: flex; align-items: center; gap: 20px; margin-bottom: 8px; }
.brand-wordmark { height: 56px; width: auto; display: block; }
.brand-mascot { height: 76px; width: auto; display: block;
                filter: drop-shadow(0 4px 12px rgba(0, 17, 23, 0.12)); }
.download-all { margin-left: auto; display: inline-flex; align-items: center;
                gap: 8px; padding: 9px 16px; background: var(--indigo);
                color: #fff; border-radius: 8px; font-family: "Inter", sans-serif;
                font-size: 13px; font-weight: 600; letter-spacing: -0.005em;
                transition: all 0.15s ease;
                box-shadow: 0 1px 2px rgba(99, 102, 241, 0.3); }
.download-all:hover { background: var(--ink); transform: translateY(-1px);
                      box-shadow: 0 4px 12px rgba(0, 17, 23, 0.2); }

/* Per-card download icon button */
.card-head { display: flex; align-items: flex-start; gap: 8px;
             justify-content: space-between; }
.card-dl { flex-shrink: 0; width: 22px; height: 22px; border-radius: 5px;
           display: inline-flex; align-items: center; justify-content: center;
           color: var(--muted); border: 1px solid transparent;
           transition: all 0.12s ease; }
.card-dl:hover { color: var(--indigo); border-color: var(--indigo);
                 background: rgba(99, 102, 241, 0.06); }
"""

WORDMARK_HTML = '<span class="wordmark">Magpie</span>'


def asset_data_url(path: Path) -> str:
    """Load a bundled asset and return a base64 data: URL."""
    if not path.exists():
        return ""
    b64 = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:image/png;base64,{b64}"


def write_gallery(out_dir: Path, source: Path, manifest: dict, elements: list[dict], alpha_policy: str, zip_name: str) -> Path:
    """Generate a self-contained gallery.html for reviewing the extracted assets."""
    # Group elements by type, preserving discovery order within each group.
    groups: dict[str, list[dict]] = {}
    for e in elements:
        groups.setdefault(e.get("type", "other"), []).append(e)
    type_order = ["wordmark", "tagline", "typography", "illustration", "sticker",
                  "icon", "palette", "screenshot", "other"]
    ordered_types = [t for t in type_order if t in groups] + [t for t in groups if t not in type_order]

    W, H = manifest.get("source_size", ["?", "?"])
    cost = manifest.get("cost_usd", 0.0)
    model = manifest.get("model", "?")

    # Source image lives outside out_dir; reference it relatively if possible.
    try:
        rel_source = source.relative_to(out_dir.parent)
        source_href = f"../{rel_source}"
    except ValueError:
        source_href = source.as_uri()

    # Bundled Magpie identity assets (extracted from the Magpie branding board
    # by Magpie itself — eat your own dog food). Inlined as data URLs so the
    # gallery stays a single self-contained file.
    wordmark_url = asset_data_url(ASSETS_DIR / "wordmark.png")
    mascot_url = asset_data_url(ASSETS_DIR / "mascot-box.png")

    if wordmark_url:
        brand_html = (
            f'<img class="brand-wordmark" src="{wordmark_url}" alt="Magpie" />'
        )
    else:
        brand_html = WORDMARK_HTML
    mascot_html = (
        f'<img class="brand-mascot" src="{mascot_url}" alt="" />' if mascot_url else ""
    )

    body_chunks = [
        '<header>',
        '  <div class="brand-row">',
        f'    {brand_html}',
        f'    {mascot_html}',
        f'    <a class="download-all" href="{html.escape(zip_name)}" download>'
        f'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
        f'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">'
        f'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>'
        f'<polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'
        f'</svg> Download all (.zip)</a>',
        '  </div>',
        f'  <h1>{html.escape(source.name)}</h1>',
        '  <div class="meta">',
        f'    <div class="meta-row"><strong>{len(elements)}</strong> elements · '
        f'<strong>{W}×{H}</strong> source · model <strong>{html.escape(model)}</strong> · '
        f'cost <strong>${cost:.4f}</strong> · alpha policy <strong>{html.escape(alpha_policy)}</strong></div>',
        f'    <img class="source-preview" src="{html.escape(source_href)}" alt="source" />',
        '  </div>',
        '</header>',
    ]

    download_svg = (
        '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" '
        'stroke="currentColor" stroke-width="2.5" stroke-linecap="round" '
        'stroke-linejoin="round" aria-hidden="true">'
        '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>'
        '<polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'
        '</svg>'
    )

    for t in ordered_types:
        body_chunks.append(f'<h2>{html.escape(t)} <span class="count">· {len(groups[t])}</span></h2>')
        body_chunks.append('<div class="grid">')
        for e in groups[t]:
            name = safe_filename(e["name"])
            crop_file = f"{name}.png"
            alpha_file = f"{name}_alpha.png"
            has_alpha = (out_dir / alpha_file).exists()
            bx = e.get("bbox_pixel", [0, 0, 0, 0])
            body_chunks.append('  <div class="card">')
            body_chunks.append('    <div class="card-head">')
            body_chunks.append(f'      <div class="card-name">{html.escape(e["name"])}</div>')
            body_chunks.append(
                f'      <a class="card-dl" href="{html.escape(crop_file)}" '
                f'download title="Download {html.escape(name)}.png">{download_svg}</a>'
            )
            body_chunks.append('    </div>')
            body_chunks.append(
                f'    <div class="card-meta">src ({bx[0]},{bx[1]})–({bx[2]},{bx[3]}) '
                f'· {bx[2] - bx[0]}×{bx[3] - bx[1]}</div>'
            )
            body_chunks.append('    <div class="thumbs">')
            body_chunks.append('      <div class="thumb">')
            body_chunks.append(f'        <a href="{html.escape(crop_file)}" download><img src="{html.escape(crop_file)}" alt="{html.escape(e["name"])}"></a>')
            body_chunks.append('        <div class="thumb-label">crop</div>')
            body_chunks.append('      </div>')
            if has_alpha:
                body_chunks.append('      <div class="thumb">')
                body_chunks.append(f'        <a href="{html.escape(alpha_file)}" download><img src="{html.escape(alpha_file)}" alt="{html.escape(e["name"])} alpha"></a>')
                body_chunks.append('        <div class="thumb-label">alpha</div>')
                body_chunks.append('      </div>')
            body_chunks.append('    </div>')
            body_chunks.append('  </div>')
        body_chunks.append('</div>')

    body = "\n".join(body_chunks)
    page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Magpie — {html.escape(source.name)}</title>
<style>{GALLERY_CSS}</style>
</head>
<body>
{body}
</body>
</html>
"""
    gallery_path = out_dir / "gallery.html"
    gallery_path.write_text(page)
    return gallery_path


if __name__ == "__main__":
    raise SystemExit(main())
