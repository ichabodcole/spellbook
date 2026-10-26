/**
 * Images on the daemon's side: reading what an image file IS (its first bytes,
 * never its name), answering the file route, converting a HEIC on its way in,
 * and the cached thumbnails.
 *
 * Which path may be served is the session's rule (`WorkspaceSession.imageFile`):
 * only an image node inside a mirrored context entry, or the one image a listed
 * entry holds (never its siblings), by realpath. This module
 * never decides that; it is handed a path that passed.
 *
 * ⛔ Nothing here reads an image as text. Bytes go out streamed from the
 * descriptor the guard opened, and the only bytes read in this process are the
 * first few (`readHeadFd`), to sniff the type, and the whole file when a
 * thumbnail is made from it.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  openSync,
  readdirSync,
  readSync,
  type Stats,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { type ImageType, sniffImage } from "../lib/docFormat.ts";
import { type ImageImportSettings, importChangesImages } from "../lib/imageImport.ts";
import { DiskRefusal, sessionDiskAt } from "./disk";
import { hasMetadata, holdsMetadata, stripMetadata, strippedWords } from "./imageMetadata.ts";

/** The most one dropped image may weigh. A photograph, not an archive. */
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/** The most pixels an image the daemon decodes may have (a HEIC, a thumbnail's source). */
export const IMAGE_MAX_PIXELS = 100_000_000;

/** The widths a thumbnail is made at: the tree's preview, and later a card. */
export const THUMB_WIDTHS = [256, 1024] as const;
export type ThumbWidth = (typeof THUMB_WIDTHS)[number];

/** The most a thumbnail's source may weigh, read into memory from its checked descriptor. */
export const THUMB_SOURCE_MAX_BYTES = 128 * 1024 * 1024;

/**
 * Open `path` for reading, refusing a symbolic link in its last place
 * (`O_NOFOLLOW`): the descriptor is what every later read uses, so the file
 * cannot be swapped under it. Null when it cannot be opened (gone, a link).
 */
export function openNoFollow(path: string): number | null {
  try {
    return openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
}

/** The first bytes of an open file, enough to sniff its type. Empty when it cannot be read. */
export function readHeadFd(fd: number, n = 32): Uint8Array {
  const buf = new Uint8Array(n);
  try {
    return buf.subarray(0, readSync(fd, buf, 0, n, 0));
  } catch {
    return new Uint8Array(0);
  }
}

/** The whole of an open file of `size` bytes, from its start. */
export function readAllFd(fd: number, size: number): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(size);
  let at = 0;
  while (at < size) {
    const got = readSync(fd, buf, at, size - at, at);
    if (got === 0) break;
    at += got;
  }
  return buf.subarray(0, at);
}

/** A file's identity for caching: changes whenever its content could have. */
export function stampOf(st: Pick<Stats, "ino" | "size" | "mtimeMs">): string {
  return `${st.ino.toString(36)}-${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}`;
}

/**
 * Whether a browser says this request came from another site. `Sec-Fetch-Site`
 * is set by the browser and cannot be set by a page. An `<img>` on a foreign
 * page sends no `Origin` (so the origin guard lets it by), but it does send
 * `Sec-Fetch-Site: cross-site`; the image routes refuse it, so a page the human
 * is browsing cannot even learn an image's size. Absent (the CLI, an old
 * browser) and `same-origin` (our own surface) and `none` (typed into the
 * address bar) pass.
 */
export function crossSite(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  return site !== null && site !== "same-origin" && site !== "none";
}

/** The headers every image answer carries, whatever its body. */
function imageHeaders(type: string, etag: string): Headers {
  return new Headers({
    "Content-Type": type,
    // Revalidated every time, answered 304 while unchanged: an image replaced
    // under the same name must never show stale from the cache.
    "Cache-Control": "no-cache",
    ETag: etag,
    // The bytes are what the type says, and nothing else may be guessed.
    "X-Content-Type-Options": "nosniff",
    // Loadable only by our own page, never embedded by another site.
    "Cross-Origin-Resource-Policy": "same-origin",
    // Opened directly, nothing in it may run.
    "Content-Security-Policy": "default-src 'none'; sandbox",
  });
}

/**
 * Serve a file that passed the session's check, as `type`, honouring
 * `If-None-Match`. The body is read from `source`: a descriptor the check
 * opened (streamed from, and closed when done; ⛔ never the path again, which
 * could have been swapped since), or the path of a file the daemon itself made
 * (a cached thumbnail).
 */
export function imageResponse(
  req: Request,
  source: { fd: number; size: number } | { path: string },
  type: string,
  stamp: string,
): Response {
  const etag = `"${stamp}"`;
  const headers = imageHeaders(type, etag);
  const fd = "fd" in source ? source.fd : null;
  if (req.headers.get("if-none-match") === etag) {
    if (fd !== null) closeSync(fd);
    return new Response(null, { status: 304, headers });
  }
  if (fd === null) return new Response(Bun.file((source as { path: string }).path), { headers });
  const size = (source as { size: number }).size;
  headers.set("Content-Length", String(size));
  return new Response(streamFd(fd, size), { headers });
}

const STREAM_CHUNK = 256 * 1024;

/** An open file's first `size` bytes as a stream, closing the descriptor when done or cancelled. */
function streamFd(fd: number, size: number): ReadableStream<Uint8Array> {
  let at = 0;
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    closeSync(fd);
  };
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      try {
        const want = Math.min(STREAM_CHUNK, size - at);
        const buf = new Uint8Array(Math.max(0, want));
        const got = want > 0 ? readSync(fd, buf, 0, want, at) : 0;
        if (got === 0) {
          close();
          controller.close();
          return;
        }
        at += got;
        controller.enqueue(buf.subarray(0, got));
      } catch (e) {
        close();
        controller.error(e);
      }
    },
    cancel: close,
  });
}

/**
 * A request body, read as it streams in and given up as soon as it passes
 * `max` bytes: a chunked upload with no length is never buffered past the cap.
 * Null when it was too large.
 */
export async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!body) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** A refusal from an image route, as JSON like every other answer from the daemon. */
export function imageRefusal(status: number, error: string): Response {
  return Response.json(
    { ok: false, error },
    { status, headers: { "Cross-Origin-Resource-Policy": "same-origin" } },
  );
}

/** Why an image could not be made or read, in words; carries a code to branch on. */
export class ImageError extends Error {
  constructor(
    message: string,
    readonly code: "unsupported" | "decode" | "too-large",
  ) {
    super(message);
  }
}

const codeOf = (e: unknown): string | undefined =>
  e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : undefined;

/**
 * Whether an image's bytes visibly stop short of its format's end marker. Null
 * when the format's end cannot be checked (AVIF, anything else): no verdict.
 *
 * - PNG ends in an IEND chunk (anything after it is ignored by readers).
 * - JPEG ends in FF D9, give or take a little padding after it.
 * - GIF ends in its 0x3B trailer, give or take padding.
 * - WebP's RIFF header says how long the file is.
 */
export function cutShort(bytes: Uint8Array): boolean | null {
  const n = bytes.byteLength;
  const at = (i: number, ...want: number[]) => want.every((b, k) => bytes[i + k] === b);
  /** The end, past trailing zero (and, for JPEG, 0xFF fill) padding, looking back at most 64 bytes. */
  const lastReal = (fill: number[]) => {
    let i = n - 1;
    while (i >= 0 && n - i <= 64 && fill.includes(bytes[i] ?? -1)) i--;
    return i;
  };
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) {
    // "IEND", searched from the end: a truncated file has none.
    for (let i = n - 8; i >= 8; i--) if (at(i, 0x49, 0x45, 0x4e, 0x44)) return false;
    return true;
  }
  if (at(0, 0xff, 0xd8)) {
    // Entropy-coded data stuffs every FF, so FF D9 near the end is the real end
    // marker, not an embedded thumbnail's (those sit near the start).
    const end = lastReal([0x00, 0xff, 0x0a, 0x0d, 0x20]);
    for (let i = end - 1; i >= 2 && end - i < 32; i--) if (at(i, 0xff, 0xd9)) return false;
    return true;
  }
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return bytes[lastReal([0x00])] !== 0x3b;
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) {
    const riff = new DataView(bytes.buffer, bytes.byteOffset, n).getUint32(4, true);
    return n < riff + 8;
  }
  return null;
}

/**
 * Whether bytes that sniff as an image may be written as one. A truncated
 * upload keeps its header (so the sniff and even the size read pass) and
 * loses its pixels; a full decode, on Bun's worker threads, finds that. But
 * Bun cannot decode everything a browser shows (a CMYK JPEG), so a failed
 * decode refuses only when the format's end marker is missing as well. A
 * format this machine has no decoder for (an AVIF without AV1), one whose end
 * cannot be checked, and an image too large to decode all pass: the browser may
 * still read them.
 */
export async function imageDecodes(bytes: Uint8Array): Promise<boolean> {
  try {
    await new Bun.Image(bytes, { maxPixels: IMAGE_MAX_PIXELS }).resize(1, 1).webp().bytes();
    return true;
  } catch (e) {
    const code = codeOf(e);
    if (code === "ERR_IMAGE_FORMAT_UNSUPPORTED" || code === "ERR_IMAGE_TOO_MANY_PIXELS")
      return true;
    return cutShort(bytes) !== true;
  }
}

/**
 * A HEIC (or HEIF) photo as a JPEG, through `Bun.Image`, which decodes HEIC with
 * the operating system's own codec (ImageIO on macOS). Where the machine has
 * none (Linux), it refuses in words rather than writing a file nothing can show.
 * Orientation is applied, so a portrait photo stays upright.
 */
export async function heicToJpeg(bytes: Uint8Array): Promise<Uint8Array> {
  try {
    return await new Bun.Image(bytes, { maxPixels: IMAGE_MAX_PIXELS, autoOrient: true })
      .jpeg({ quality: HEIC_JPEG_QUALITY })
      .bytes();
  } catch (e) {
    throw heicError(e);
  }
}

/** The JPEG quality a HEIC photo is converted at when the import settings ask for nothing else. */
const HEIC_JPEG_QUALITY = 90;

/** Why a HEIC photo could not be converted, from `Bun.Image`'s error code. */
function heicError(e: unknown): ImageError {
  const code = codeOf(e);
  if (code === "ERR_IMAGE_FORMAT_UNSUPPORTED")
    return new ImageError(
      "this machine cannot read HEIC photos: export it as JPEG first (Photos: File, Export)",
      "unsupported",
    );
  if (code === "ERR_IMAGE_TOO_MANY_PIXELS")
    return new ImageError("the photo is too large to convert", "too-large");
  return new ImageError("the photo could not be read as HEIC", "decode");
}

// ── the import settings, applied (kit-image-import-settings) ─────────────────

/**
 * Whether an image's bytes hold more than one frame: an animated GIF (a second
 * image descriptor), an animated WebP (the VP8X animation flag) or an animated
 * PNG (an `acTL` chunk before the first `IDAT`). `Bun.Image` decodes only the
 * first frame, so converting one would silently stop it moving.
 */
export function isAnimated(bytes: Uint8Array): boolean {
  const n = bytes.byteLength;
  const ascii = (i: number, s: string) => [...s].every((c, k) => bytes[i + k] === c.charCodeAt(0));
  const u32be = (i: number) =>
    (bytes[i] ?? 0) * 0x1000000 +
    (((bytes[i + 1] ?? 0) << 16) | ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0));
  if (ascii(0, "GIF8")) {
    let i = 13;
    const packed = bytes[10] ?? 0;
    if (packed & 0x80) i += 3 * 2 ** ((packed & 0x07) + 1);
    /** Past a run of sub-blocks (a length byte, that many bytes, until a 0). */
    const skipBlocks = (at: number) => {
      let j = at;
      while (j < n && bytes[j] !== 0) j += (bytes[j] as number) + 1;
      return j + 1;
    };
    let frames = 0;
    while (i < n) {
      const b = bytes[i];
      if (b === 0x2c) {
        if (++frames > 1) return true;
        const local = bytes[i + 9] ?? 0;
        i += 10;
        if (local & 0x80) i += 3 * 2 ** ((local & 0x07) + 1);
        i = skipBlocks(i + 1); // past the LZW minimum code size, then the data
      } else if (b === 0x21) i = skipBlocks(i + 2);
      else break; // the trailer, or something unreadable: no more frames found
    }
    return false;
  }
  if (ascii(0, "RIFF") && ascii(8, "WEBP"))
    return ascii(12, "VP8X") && ((bytes[20] ?? 0) & 0x02) !== 0;
  if (bytes[0] === 0x89 && ascii(1, "PNG")) {
    let i = 8;
    while (i + 8 <= n) {
      if (ascii(i + 4, "acTL")) return true;
      if (ascii(i + 4, "IDAT")) return false;
      i += 12 + u32be(i);
    }
  }
  return false;
}

/** What an image brought in was written as, after the import settings had their say. */
export type ImportedBytes = {
  bytes: Uint8Array;
  /** What the bytes are, by their first bytes; null when they are no image (the session refuses them). */
  type: ImageType | null;
  /** What was done to it, in words, when it was re-encoded: "converted from PNG to WebP at quality 80". */
  done?: string;
  /** Why it was written as it came, when the settings would have changed it: "it is animated". */
  left?: string;
  /** Left because it already is what the settings ask for (within the cap, already WebP): nothing to report loudly. */
  already?: true;
  /** What metadata was taken out, in words: "its EXIF and XMP metadata was removed, location included". */
  stripped?: string;
  /** Why metadata it holds was kept (an AVIF, or a file whose structure could not be read safely). */
  metaKept?: string;
};

const LABEL: Record<ImageType, string> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
  "image/gif": "GIF",
  "image/avif": "AVIF",
};

const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;

/**
 * An image's bytes as the import settings want them written: the one place a
 * drop on the tree, a paste or drop into a document, and (later) a drop on a
 * board are optimised, on the daemon's side and on Bun's worker threads.
 *
 * - **Left as it came**, with `left` saying why, when converting would not
 *   help or cannot be done: an animated image (only its first frame would
 *   survive), an AVIF (already compact, and not encodable everywhere), one this
 *   machine cannot decode, one already within the cap and in the format asked
 *   for, a GIF that would need resizing (GIF is read here but never written),
 *   and one that as WebP would be no smaller and needs no resizing. SVG never
 *   gets here: it is refused before.
 * - **Re-encoded** otherwise: turned upright by its EXIF orientation first,
 *   brought down to the longest side (never enlarged), and written as WebP at
 *   the quality, or in its own format (a JPEG at the quality, a PNG lossless).
 *   A re-encoded image carries no EXIF or other metadata (camera, date, GPS
 *   location); its colour profile is kept.
 * - **Its metadata removed** either way, whatever the settings: an image left
 *   as it came loses its EXIF, XMP and IPTC from the container alone, its
 *   coded image untouched (`imageMetadata.ts`), and `stripped` says what went.
 *   An AVIF keeps its own, and `metaKept` says so.
 *
 * A HEIC photo (`heic: true`) is always re-encoded, since nothing shows HEIC:
 * to WebP when asked, else to JPEG (at 90, or at the quality when it is also
 * made smaller). It throws an `ImageError` when it cannot be read, as
 * `heicToJpeg` does. With the defaults only the metadata goes.
 */
export async function optimiseImport(
  bytes: Uint8Array,
  settings: ImageImportSettings,
  opts: { heic?: boolean } = {},
): Promise<ImportedBytes> {
  const r = await reencodeForImport(bytes, settings, opts);
  // Metadata goes from every image brought in, whatever the settings say (the
  // user's decision, 2026-10-06): see `imageMetadata.ts`.
  if (r.type === null) return r;
  if (r.done) {
    // Re-encoded: `Bun.Image` writes no EXIF or XMP. Said when the original had some.
    const again = stripMetadata(r.bytes, r.type);
    const out = again.removed.length > 0 ? { ...r, bytes: again.bytes } : r;
    if (opts.heic)
      return hasMetadata(bytes)
        ? { ...out, stripped: "its camera details and location were not carried over" }
        : out;
    const had = stripMetadata(bytes, sniffImage(bytes.subarray(0, 32)) as ImageType);
    return had.removed.length > 0
      ? { ...out, stripped: strippedWords({ removed: had.removed, location: had.location }) }
      : out;
  }
  if (r.type === "image/avif")
    return hasMetadata(r.bytes)
      ? { ...r, metaKept: "AVIF metadata cannot be removed without re-encoding, so it was kept" }
      : r;
  const s = stripMetadata(r.bytes, r.type);
  const cannot = {
    ...r,
    metaKept: "its metadata could not be removed without damaging it, so it was kept",
  };
  // Nothing is said removed that is still there.
  if (s.removed.length === 0) return holdsMetadata(r.bytes) ? cannot : r;
  if (holdsMetadata(s.bytes)) return cannot;
  // The container was rewritten: what read before must still read, at the same
  // size. (One Bun cannot read at all, a CMYK JPEG, has only the walk's word.)
  const sizeOf = async (b: Uint8Array) => {
    try {
      const m = await new Bun.Image(b, { maxPixels: IMAGE_MAX_PIXELS }).metadata();
      return `${m.width}x${m.height}`;
    } catch {
      return null;
    }
  };
  const before = await sizeOf(r.bytes);
  if (before !== null && (await sizeOf(s.bytes)) !== before) return cannot;
  return { ...r, bytes: s.bytes, stripped: strippedWords(s) };
}

/** `optimiseImport` before the metadata goes: the settings' conversion and cap, or why not. */
async function reencodeForImport(
  bytes: Uint8Array,
  settings: ImageImportSettings,
  opts: { heic?: boolean },
): Promise<ImportedBytes> {
  const heic = opts.heic === true;
  const type = heic ? null : sniffImage(bytes.subarray(0, 32));
  const asCame = (left?: string, already?: true): ImportedBytes => ({
    bytes,
    type,
    ...(left ? { left } : {}),
    ...(already ? { already } : {}),
  });
  if (!heic && (!importChangesImages(settings) || type === null)) return asCame();
  if (!heic && type !== null) {
    if (isAnimated(bytes)) return asCame("it is animated, and only its first frame would be kept");
    if (type === "image/avif") return asCame("AVIF is already compact, and is left as it is");
  }
  let width: number;
  let height: number;
  try {
    // Read with the orientation applied, so the cap is on the upright image.
    ({ width, height } = await new Bun.Image(bytes, {
      maxPixels: IMAGE_MAX_PIXELS,
      autoOrient: true,
    }).metadata());
  } catch (e) {
    if (heic) throw heicError(e);
    return asCame("it could not be decoded here to convert it");
  }
  const cap = settings.maxSide;
  const resize = cap !== null && Math.max(width, height) > cap;
  const target: ImageType =
    settings.format === "webp" ? "image/webp" : heic ? "image/jpeg" : (type as ImageType);
  if (!heic) {
    if (!resize && target === type)
      return asCame(
        cap !== null
          ? `it is already within ${cap} px${settings.format === "webp" ? " and WebP" : ""}`
          : "it is already WebP",
        true,
      );
    if (target === "image/gif")
      return asCame("a GIF is read here but never written, so it cannot be made smaller");
  }
  const quality = heic && !resize && target === "image/jpeg" ? HEIC_JPEG_QUALITY : settings.quality;
  let out: Uint8Array;
  const img = new Bun.Image(bytes, { maxPixels: IMAGE_MAX_PIXELS, autoOrient: true });
  if (resize) img.resize(cap, cap, { fit: "inside", withoutEnlargement: true });
  try {
    if (target === "image/webp") img.webp({ quality });
    else if (target === "image/jpeg") img.jpeg({ quality });
    else img.png();
    out = await img.bytes();
  } catch (e) {
    if (heic) throw heicError(e);
    return asCame("it could not be converted here");
  }
  if (!heic && !resize && out.byteLength >= bytes.byteLength)
    return asCame(
      `as ${LABEL[target]} it would be no smaller: ${kb(out.byteLength)} against ${kb(bytes.byteLength)}`,
    );
  const from = heic ? "HEIC" : LABEL[type as ImageType];
  const to = LABEL[target];
  const lossy = target === "image/webp" || target === "image/jpeg";
  const parts: string[] = [];
  if (to !== from)
    parts.push(`converted from ${from} to ${to}${lossy ? ` at quality ${quality}` : ""}`);
  if (resize)
    parts.push(
      `made smaller from ${width}×${height} to ${img.width}×${img.height}${to === from && lossy ? ` at quality ${quality}` : ""}`,
    );
  return {
    bytes: out,
    type: target,
    done: `${parts.join(", ")}: ${kb(bytes.byteLength)} to ${kb(out.byteLength)}`,
  };
}

/** Where a thumbnail of `stamp` at `width` is cached under the session folder. */
export function thumbPath(sessionDir: string, stamp: string, width: ThumbWidth): string {
  return join(sessionDir, "thumbs", `${stamp}-${width}.webp`);
}

/** The cached thumbnail of `stamp` at `width`, when it is already made. */
export function cachedThumb(sessionDir: string, stamp: string, width: ThumbWidth): string | null {
  const out = thumbPath(sessionDir, stamp, width);
  try {
    return statSync(out).size > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * A WebP thumbnail of an image's bytes, `width` wide at most (never enlarged),
 * cached by the file's stamp, so a changed file gets a new one and an unchanged
 * one is read from disk. `read` gives the source's bytes (from the descriptor the
 * guard checked, never the path) and is called only on a miss. Made on Bun's
 * worker threads, never on the daemon's own. Returns the cached file's path, or
 * throws an `ImageError` (an AVIF on a machine with no AV1 decoder, a broken
 * file, a source too large to read).
 */
export async function thumbnail(
  sessionDir: string,
  read: () => Uint8Array,
  stamp: string,
  width: ThumbWidth,
): Promise<string> {
  const hit = cachedThumb(sessionDir, stamp, width);
  if (hit) return hit;
  const out = thumbPath(sessionDir, stamp, width);
  // The session's own writer: a `thumbs/` that is a link leading out of the
  // session is refused, and nothing is written (`./disk.ts`).
  const disk = sessionDiskAt(sessionDir);
  disk.mkdir(join(sessionDir, "thumbs"), { recursive: true });
  // Written to a temporary name of its own and renamed, so a half-made thumbnail
  // is never served, and two cold requests for the same one never collide.
  const tmp = `${out}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    const bytes = await new Bun.Image(read(), { maxPixels: IMAGE_MAX_PIXELS })
      .resize(width, width, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 75 })
      .bytes();
    disk.writeFile(tmp, bytes);
    disk.rename(tmp, out);
    return out;
  } catch (e) {
    try {
      disk.unlink(tmp);
    } catch {
      /* never written */
    }
    if (e instanceof ImageError || e instanceof DiskRefusal) throw e;
    const code = codeOf(e);
    if (code === "ERR_IMAGE_FORMAT_UNSUPPORTED")
      throw new ImageError("this machine cannot decode that image", "unsupported");
    if (code === "ERR_IMAGE_TOO_MANY_PIXELS")
      throw new ImageError("the image is too large to preview", "too-large");
    throw new ImageError("the image could not be read", "decode");
  }
}

/** How old a stray temporary thumbnail must be before a prune removes it. */
export const THUMB_TMP_GRACE_MS = 60_000;

/**
 * Remove every cached thumbnail whose stamp names no image the session shows
 * now (a file changed, renamed away or deleted), and any temporary one left
 * half-made. Returns how many went. Only the session's own `thumbs/` folder is
 * touched, and only files named as this module names them.
 */
export function pruneThumbs(
  sessionDir: string,
  keep: ReadonlySet<string>,
  now = Date.now(),
): number {
  const dir = join(sessionDir, "thumbs");
  const disk = sessionDiskAt(sessionDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let gone = 0;
  for (const name of names) {
    const made = /^(.+)-(?:256|1024)\.webp$/.exec(name);
    let drop = false;
    if (made) drop = !keep.has(made[1] as string);
    else if (/\.webp\.[0-9a-f]{8}\.tmp$/.test(name)) {
      try {
        drop = now - statSync(join(dir, name)).mtimeMs > THUMB_TMP_GRACE_MS;
      } catch {
        drop = false;
      }
    }
    if (!drop) continue;
    try {
      disk.unlink(join(dir, name));
      gone++;
    } catch {
      /* gone already, or refused (a thumbs/ that leads out): left */
    }
  }
  return gone;
}
