// Real image files for tests, made here, never downloaded: a PNG written by
// hand (zlib from node, CRC by table), and the other formats re-encoded from it
// with `Bun.Image`. A HEIC exists only where the machine can encode one.
import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  const typed = new TextEncoder().encode(type);
  out.set(typed, 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * A `w` × `h` RGB PNG: a diagonal gradient from `from` to `to`, so a thumbnail
 * or a JPEG of it is not a flat colour that compresses to nothing. With
 * `alpha`, RGBA, and its left half fully transparent.
 */
export function pngBytes(
  w: number,
  h: number,
  from: [number, number, number] = [20, 90, 60],
  to: [number, number, number] = [230, 200, 120],
  alpha = false,
): Uint8Array<ArrayBuffer> {
  const px = alpha ? 4 : 3;
  const raw = new Uint8Array(h * (1 + w * px));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * px);
    raw[row] = 0; // no filter
    for (let x = 0; x < w; x++) {
      const t = (x + y) / Math.max(1, w + h - 2);
      for (let c = 0; c < 3; c++)
        raw[row + 1 + x * px + c] = Math.round(
          (from[c] as number) + ((to[c] as number) - (from[c] as number)) * t,
        );
      if (alpha) raw[row + 1 + x * px + 3] = x < w / 2 ? 0 : 255;
    }
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = alpha ? 6 : 2; // RGBA or RGB
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The smallest GIF there is: one transparent pixel. */
export const GIF_1PX = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]);

export const jpegBytes = async (w: number, h: number): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await new Bun.Image(pngBytes(w, h)).jpeg({ quality: 85 }).bytes());

export const webpBytes = async (w: number, h: number): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await new Bun.Image(pngBytes(w, h)).webp({ quality: 80 }).bytes());

/** A HEIC photo, or null where this machine cannot encode one (Linux, `Bun.Image.backend = "bun"`). */
export async function heicBytes(w: number, h: number): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    return new Uint8Array(await new Bun.Image(pngBytes(w, h)).heic({ quality: 80 }).bytes());
  } catch {
    return null;
  }
}

/**
 * An 8x8 CMYK JPEG (four components, no ICC profile), made with macOS sips:
 * browsers show it, but Bun.Image cannot decode it, so a decode failure alone
 * must not read as a damaged file.
 */
export const CMYK_JPEG = new Uint8Array(
  Buffer.from(
    "/9j/4AAQSkZJRgABAQAASABIAAD/4QBARXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAAqACAAQAAAABAAAACKADAAQAAAABAAAACAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/+4ADkFkb2JlAGQAAAAAAP/AABQIAAgACAQBEQACEQEDEQEEEQH/xAAfAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgv/xAC1EAACAQMDAgQDBQUEBAAAAX0BAgMABBEFEiExQQYTUWEHInEUMoGRoQgjQrHBFVLR8CQzYnKCCQoWFxgZGiUmJygpKjQ1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4eLj5OXm5+jp6vHy8/T19vf4+fr/xAAfAQADAQEBAQEBAQEBAAAAAAAAAQIDBAUGBwgJCgv/xAC1EQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2wBDAAICAgICAgMCAgMFAwMDBQYFBQUFBggGBgYGBggKCAgICAgICgoKCgoKCgoMDAwMDAwODg4ODg8PDw8PDw8PDw//2wBDAQIDAwQEBAcEBAcQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/3QAEAAH/2gAOBAEAAhEDEQQRAD8As/s5fs5O72s01rX+iuX5fOc+eZ/COR5HOUz/AGI4c4co4WjCEIH/2Q==",
    "base64",
  ),
);

/** A GIF of two one-pixel frames: animated, as far as anything reading it can tell. */
export const GIF_2_FRAMES = new Uint8Array([
  ...GIF_1PX.subarray(0, 19),
  ...GIF_1PX.subarray(19, 42),
  ...GIF_1PX.subarray(19, 42),
  0x3b,
]);

/**
 * A JPEG with an EXIF block carrying `orientation` (6: the stored pixels are
 * to be turned a quarter clockwise, as a phone held upright writes them) and a
 * GPS block, so a test can tell whether metadata survives.
 */
export function withExifOrientation(
  jpeg: Uint8Array,
  orientation: number,
): Uint8Array<ArrayBuffer> {
  const body = [..."Exif\0\0"].map((c) => c.charCodeAt(0)).concat([...exifTiff(orientation)]);
  const len = body.length + 2;
  return new Uint8Array([
    ...jpeg.subarray(0, 2),
    0xff,
    0xe1,
    len >> 8,
    len & 255,
    ...body,
    ...jpeg.subarray(2),
  ]);
}

/** An EXIF block (a TIFF header and IFD0) carrying `orientation` and a GPS block. */
export function exifTiff(orientation: number): Uint8Array<ArrayBuffer> {
  const t: number[] = [];
  const w16 = (v: number) => t.push(v & 255, (v >> 8) & 255);
  const w32 = (v: number) => t.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
  t.push(0x49, 0x49); // little-endian TIFF
  w16(42);
  w32(8); // IFD0 right after the header
  w16(2); // two entries
  w16(0x0112); // Orientation, SHORT, 1
  w16(3);
  w32(1);
  w16(orientation);
  w16(0);
  w16(0x8825); // the GPS IFD's offset, LONG, 1
  w16(4);
  w32(1);
  w32(8 + 2 + 24 + 4);
  w32(0); // no next IFD
  w16(1); // the GPS IFD: GPSVersionID 2.2.0.0
  w16(0);
  w16(1);
  w32(4);
  t.push(2, 2, 0, 0);
  w32(0);
  return new Uint8Array(t);
}

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const XMP_PACKET =
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description exif:GPSLatitude="51,30.0N"/></rdf:RDF></x:xmpmeta>';

/** A JPEG segment: marker, big-endian length, payload. */
const segment = (marker: number, payload: number[]) => {
  const len = payload.length + 2;
  return [0xff, marker, len >> 8, len & 255, ...payload];
};

/**
 * A JPEG carrying everything an import removes, beside what it keeps: EXIF
 * (orientation and GPS), XMP, a Photoshop IPTC block, and an ICC segment
 * (APP2), right after SOI.
 */
export function jpegWithMetadata(jpeg: Uint8Array, orientation = 1): Uint8Array<ArrayBuffer> {
  return new Uint8Array([
    ...jpeg.subarray(0, 2),
    ...segment(0xe1, [...ascii("Exif\0\0"), ...exifTiff(orientation)]),
    ...segment(0xe1, [...ascii("http://ns.adobe.com/xap/1.0/\0"), ...ascii(XMP_PACKET)]),
    ...segment(0xed, [...ascii("Photoshop 3.0\0"), ...ascii("8BIM"), 0x04, 0x04, 0, 0, 0, 0, 0, 0]),
    ...segment(0xe2, [...ascii("ICC_PROFILE\0"), 1, 1, ...ascii("not a real profile")]),
    ...jpeg.subarray(2),
  ]);
}

/**
 * A PNG carrying an `eXIf` chunk (orientation and GPS) and an XMP `iTXt`, and a
 * plain `tEXt` Software line that stays, before its pixels.
 */
export function pngWithMetadata(png: Uint8Array, orientation = 1): Uint8Array<ArrayBuffer> {
  const ihdrEnd = 8 + 25;
  const xmp = [...ascii("XML:com.adobe.xmp"), 0, 0, 0, 0, 0, ...ascii(XMP_PACKET)];
  return new Uint8Array([
    ...png.subarray(0, ihdrEnd),
    ...chunk("tEXt", new Uint8Array([...ascii("Software"), 0, ...ascii("a test")])),
    ...chunk("eXIf", exifTiff(orientation)),
    ...chunk("iTXt", new Uint8Array(xmp)),
    ...png.subarray(ihdrEnd),
  ]);
}

/** A RIFF chunk: fourcc, little-endian size, payload, padded to even. */
const riffChunk = (fourcc: string, data: Uint8Array) => {
  const out = new Uint8Array(8 + data.length + (data.length & 1));
  out.set(ascii(fourcc));
  new DataView(out.buffer).setUint32(4, data.length, true);
  out.set(data, 8);
  return out;
};

/**
 * An extended WebP (VP8X, with alpha) carrying EXIF (orientation and GPS) and
 * XMP chunks after its image, its flags and RIFF size saying so.
 */
export async function webpWithMetadata(orientation = 1): Promise<Uint8Array<ArrayBuffer>> {
  const base = new Uint8Array(
    await new Bun.Image(pngBytes(40, 30, undefined, undefined, true)).webp({ quality: 80 }).bytes(),
  );
  if (String.fromCharCode(...base.subarray(12, 16)) !== "VP8X") throw new Error("expected VP8X");
  const body = new Uint8Array([
    ...base.subarray(12),
    ...riffChunk("EXIF", exifTiff(orientation)),
    ...riffChunk("XMP ", new Uint8Array(ascii(XMP_PACKET))),
  ]);
  body[8] = (body[8] as number) | 0x08 | 0x04;
  const head = new Uint8Array(12);
  head.set(ascii("RIFF"));
  new DataView(head.buffer).setUint32(4, body.length + 4, true);
  head.set(ascii("WEBP"), 8);
  return new Uint8Array([...head, ...body]);
}

/** A GIF with an XMP application extension (as Adobe writes it) and a comment that stays. */
export function gifWithXmp(gif: Uint8Array = GIF_1PX): Uint8Array<ArrayBuffer> {
  // XMP's "magic trailer": 258 bytes that let a reader skip it as sub-blocks.
  const trailer = [1, ...Array.from({ length: 256 }, (_, k) => 255 - k), 0];
  const xmp = [0x21, 0xff, 11, ...ascii("XMP DataXMP"), ...ascii(XMP_PACKET), ...trailer];
  const comment = [0x21, 0xfe, 4, ...ascii("note"), 0];
  return new Uint8Array([...gif.subarray(0, 19), ...xmp, ...comment, ...gif.subarray(19)]);
}
