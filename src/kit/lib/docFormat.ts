/**
 * What the workspace opens, and how it treats each kind of file. One list and
 * one question, shared by the daemon (`workspace/tree.ts` re-exports them) and
 * the surface (`context/model.ts` does too), so the two cannot disagree. Pure:
 * no `node:` imports, so a surface can bundle it.
 *
 * Two formats of DOCUMENT, which is text:
 *
 * - **markdown**: `.md`, `.markdown` and `.txt`. Rendered, linked, searched,
 *   indexed for links and drawn on the map.
 * - **json**: `.json`. Edited raw in JSON mode and checked to parse before a
 *   save, never read as markdown: no rendered view, no frontmatter, no links,
 *   not on the map. A world's profile files (`_meta/profiles/*.json`) are the
 *   first of these.
 *
 * And IMAGES, which are not documents at all (`IMAGE_EXTENSIONS`). An image is
 * a node of its own kind in the tree (`{ kind: "image" }`), never a `doc` node,
 * so nothing that walks documents (versions, search, links, the map, profiles)
 * ever meets one: it is left out by construction, not by a check each tool must
 * remember. `isDocName` is false for every image name, and `docFormat` is never
 * asked about one.
 *
 * And BUNDLES (`bundles.ts`): a folder an app registered by extension, shown
 * as one item, whose main file is a document of the format its type names.
 */

import { bundleTypeOfMain } from "./bundles.ts";

/** What the workspace admits as a document. Everything else is not shown. */
export const DOC_EXTENSIONS = [".md", ".markdown", ".txt", ".json"] as const;

export function isDocName(name: string): boolean {
  const lower = name.toLowerCase();
  return DOC_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** How a document is edited and read. */
export type DocFormat = "markdown" | "json";

/**
 * ⛔ THE ONE PLACE a document's format is decided, from its name or path. Ask
 * this rather than testing an extension: everything that reads a document as
 * markdown (the rendered view, links, the map) skips what is not.
 */
export function docFormat(name: string): DocFormat {
  // A registered bundle's main file is read as its type says (`board.canvas`
  // is JSON), by its name alone: the same answer from a bare name, a rel or a
  // path.
  const main = bundleTypeOfMain(name);
  if (main) return main.format;
  return name.toLowerCase().endsWith(".json") ? "json" : "markdown";
}

// ── images ─────────────────────────────────────────────────────────────────

/** The raster images the workspace shows in the tree and opens in its viewer. */
export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"] as const;

/** An image's type, as the file route serves it. */
export type ImageType = "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "image/avif";

/** The extension a file of each image type is written with. */
export const EXTENSION_OF: Record<ImageType, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
};

export function isImageName(name: string): boolean {
  const lower = name.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** HEIC and HEIF: an iPhone's photos. Converted to JPEG when dropped in, where the machine can. */
export function isHeicName(name: string): boolean {
  return /\.(?:heic|heif)$/i.test(name);
}

/** SVG is refused: it can carry script. */
export function isSvgName(name: string): boolean {
  return /\.svgz?$/i.test(name);
}

/** Why an SVG is not brought in, in the user's words: shown on a refused drop. */
export const SVG_REFUSED =
  "SVG is not brought in: an SVG can carry script, which would run inside the app. Export it as PNG or WebP instead.";

/**
 * The type the bytes themselves say, from their first bytes, or null when they
 * are not one of the images the workspace shows. ⛔ The file route serves THIS,
 * never the name's type: a page saved as `x.png` is not an image, and is
 * refused rather than served.
 */
export function sniffImage(head: Uint8Array): ImageType | null {
  const at = (i: number, bytes: readonly number[]) => bytes.every((b, k) => head[i + k] === b);
  const ascii = (i: number, s: string) =>
    at(
      i,
      [...s].map((c) => c.charCodeAt(0)),
    );
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  // ISO BMFF: a box size, then `ftyp`, then the brand. AVIF says `avif` or `avis`.
  if (ascii(4, "ftyp") && (ascii(8, "avif") || ascii(8, "avis"))) return "image/avif";
  return null;
}

/** "PNG", "JPEG": an image type as the viewer's footer names it. */
export function imageTypeLabel(type: string): string {
  return type.replace(/^image\//, "").toUpperCase();
}

/** An image's pixel size, as its header says. */
export type PixelSize = { width: number; height: number };

/** How many of an image's first bytes `imageSize` wants: enough to reach a JPEG's frame header past its metadata. */
export const IMAGE_HEAD_BYTES = 64 * 1024;

/**
 * The pixel size an image's own header gives, from its first bytes (`head`,
 * up to IMAGE_HEAD_BYTES), or null when the header is not where it should be.
 * Read so a page can reserve an embed's space before its bytes arrive. A
 * JPEG's EXIF rotation is not applied: the size is the stored one, and a
 * browser keeps the reserved shape only until the image itself has loaded.
 */
export function imageSize(head: Uint8Array, type: ImageType): PixelSize | null {
  const u16be = (i: number) => ((head[i] ?? 0) << 8) | (head[i + 1] ?? 0);
  const u16le = (i: number) => (head[i] ?? 0) | ((head[i + 1] ?? 0) << 8);
  const u24le = (i: number) => u16le(i) | ((head[i + 2] ?? 0) << 16);
  const u32be = (i: number) => u16be(i) * 65536 + u16be(i + 2);
  const ascii = (i: number, s: string) => [...s].every((c, k) => head[i + k] === c.charCodeAt(0));
  const ok = (width: number, height: number): PixelSize | null =>
    width > 0 && height > 0 ? { width, height } : null;
  if (head.length < 10) return null;
  switch (type) {
    case "image/png":
      return ascii(12, "IHDR") ? ok(u32be(16), u32be(20)) : null;
    case "image/gif":
      return ok(u16le(6), u16le(8));
    case "image/webp":
      if (ascii(12, "VP8 ")) return ok(u16le(26) & 0x3fff, u16le(28) & 0x3fff);
      if (ascii(12, "VP8L")) {
        const b = (i: number) => head[21 + i] ?? 0;
        return ok(
          1 + (((b(1) & 0x3f) << 8) | b(0)),
          1 + (((b(3) & 0x0f) << 10) | (b(2) << 2) | ((b(1) & 0xc0) >> 6)),
        );
      }
      if (ascii(12, "VP8X")) return ok(1 + u24le(24), 1 + u24le(27));
      return null;
    case "image/jpeg": {
      let i = 2;
      while (i + 9 < head.length) {
        if (head[i] !== 0xff) return null;
        const m = head[i + 1] ?? 0;
        if (m === 0xff) {
          i++;
          continue;
        }
        // Standalone markers carry no length.
        if (m === 0x01 || (m >= 0xd0 && m <= 0xd9)) {
          i += 2;
          continue;
        }
        // Start of frame: every SOFn but DHT (C4), JPG (C8) and DAC (CC).
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
          return ok(u16be(i + 7), u16be(i + 5));
        i += 2 + u16be(i + 2);
      }
      return null;
    }
    case "image/avif": {
      for (let i = 4; i + 16 <= head.length; i++)
        if (ascii(i, "ispe")) return ok(u32be(i + 8), u32be(i + 12));
      return null;
    }
  }
}
