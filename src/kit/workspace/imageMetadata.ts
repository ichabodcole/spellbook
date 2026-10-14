/**
 * Removing an image's metadata without touching its pixels (decided by the
 * user on 2026-10-06, kit-image-import-settings): every image brought in loses
 * its EXIF (camera, dates, GPS location), its XMP and its IPTC, whatever the
 * import settings say. A re-encoded image already carries none; this is for
 * the images written as they came, and works on the container alone, so the
 * coded image data is byte for byte what came in.
 *
 * - **JPEG**: the APP1 segments holding EXIF or XMP (standard and extended) and
 *   the APP13 Photoshop segment holding IPTC are dropped. APP0 (JFIF), APP2
 *   (the ICC colour profile), APP14 (Adobe's colour transform), the tables and
 *   every scan are kept as they are. What follows the end marker (an Apple
 *   MPF second image or depth map, a motion photo's clip) goes, with the MPF
 *   index pointing at it: it carries metadata of its own, and stripping each
 *   embedded image would break the MPF offsets. Padding after the end stays.
 * - **PNG**: the `eXIf` chunk, and every text chunk (`tEXt`, `zTXt`, `iTXt`)
 *   but a `Software` line: Make, Model, Author, Comment and the like may say
 *   who took it, with what, or where. `iCCP` is kept.
 * - **WebP**: the `EXIF` and `XMP ` chunks of an extended (VP8X) file, with
 *   the VP8X flags and the RIFF size fixed to match. A simple WebP has nowhere
 *   to keep metadata.
 * - **GIF**: the XMP application extension (`XMP DataXMP`). GIF has no EXIF.
 *   Comments and the looping extension stay.
 * - **AVIF**: not stripped: its metadata sits in items the file's location
 *   table points into, which cannot be cut out safely without rewriting the
 *   file. `hasMetadata` says whether it has some, so the import can say so.
 *
 * **Orientation.** A photo whose EXIF says to turn it would show sideways once
 * its EXIF is gone, and turning a JPEG losslessly is not possible in general
 * (only whole blocks can be rotated). So where the EXIF that goes held an
 * orientation other than 1, a new EXIF block is written in its place holding
 * that one tag and nothing else: no camera, no date, no location.
 */

import type { ImageType } from "../lib/docFormat.ts";

/** What an import removes: metadata, PNG text that is not harmless, and what follows a JPEG's end. */
export type MetadataKind = "EXIF" | "XMP" | "IPTC" | "text" | "trailer";

export type Stripped = {
  /** The image without its metadata: the bytes that came in when there was none. */
  bytes: Uint8Array;
  /** What was taken out, in the order found; empty when nothing was. */
  removed: MetadataKind[];
  /** Whether the EXIF that went held a GPS block (a location). */
  location: boolean;
  /** The orientation kept in a minimal EXIF block, when there was one other than 1. */
  orientation?: number;
};

const enc = new TextEncoder();
const startsWith = (b: Uint8Array, at: number, s: string) =>
  [...s].every((c, k) => b[at + k] === c.charCodeAt(0));

/** What an EXIF block (a TIFF header and IFD0, after any `Exif\0\0`) says of orientation and location. */
export function readExif(block: Uint8Array): { orientation: number; location: boolean } {
  const tiff = startsWith(block, 0, "Exif\0\0") ? block.subarray(6) : block;
  const none = { orientation: 1, location: false };
  if (tiff.byteLength < 8) return none;
  const le = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!le && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return none;
  const u16 = (i: number) =>
    le ? (tiff[i] ?? 0) | ((tiff[i + 1] ?? 0) << 8) : ((tiff[i] ?? 0) << 8) | (tiff[i + 1] ?? 0);
  const u32 = (i: number) => (le ? u16(i) + u16(i + 2) * 0x10000 : u16(i) * 0x10000 + u16(i + 2));
  const ifd = u32(4);
  if (ifd + 2 > tiff.byteLength) return none;
  const count = u16(ifd);
  let orientation = 1;
  let location = false;
  for (let k = 0; k < count; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > tiff.byteLength) break;
    const tag = u16(e);
    if (tag === 0x0112) orientation = u16(e + 8);
    if (tag === 0x8825) location = true;
  }
  return { orientation: orientation >= 1 && orientation <= 8 ? orientation : 1, location };
}

/** A TIFF block holding one tag, the orientation: what a stripped photo keeps so it shows upright. */
export function orientationOnlyExif(orientation: number): Uint8Array {
  return new Uint8Array([
    0x49,
    0x49,
    0x2a,
    0x00,
    0x08,
    0x00,
    0x00,
    0x00, // little-endian TIFF, IFD0 at 8
    0x01,
    0x00, // one entry
    0x12,
    0x01,
    0x03,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    orientation & 0xff,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00, // no next IFD
  ]);
}

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
};

const unchanged = (bytes: Uint8Array): Stripped => ({ bytes, removed: [], location: false });

/** An image's bytes without its EXIF, XMP and IPTC, by `type`; see the module's comment. */
export function stripMetadata(bytes: Uint8Array, type: ImageType): Stripped {
  try {
    if (type === "image/jpeg") return stripJpeg(bytes);
    if (type === "image/png") return stripPng(bytes);
    if (type === "image/webp") return stripWebp(bytes);
    if (type === "image/gif") return stripGif(bytes);
  } catch {
    /* a file whose structure is not as it says: left whole, and checked by the caller */
  }
  return unchanged(bytes);
}

/** Whether an image appears to hold EXIF or XMP: for a format `stripMetadata` leaves whole (AVIF). */
export function hasMetadata(bytes: Uint8Array): boolean {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return b.includes("Exif") || b.includes("<x:xmpmeta") || b.includes("http://ns.adobe.com/xap");
}

function result(
  bytes: Uint8Array,
  parts: Uint8Array[],
  removed: MetadataKind[],
  location: boolean,
  orientation: number,
): Stripped {
  if (removed.length === 0) return unchanged(bytes);
  return {
    bytes: concat(parts),
    removed: [...new Set(removed)],
    location,
    ...(orientation !== 1 ? { orientation } : {}),
  };
}

function stripJpeg(bytes: Uint8Array): Stripped {
  const n = bytes.byteLength;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return unchanged(bytes);
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  const removed: MetadataKind[] = [];
  let location = false;
  let orientation = 1;
  let wroteOrientation = false;
  /** Where the MPF segment (the index of extra images after this one) went in `parts`. */
  let mpf = -1;
  let i = 2;
  for (;;) {
    if (i + 2 > n || bytes[i] !== 0xff) return unchanged(bytes); // not where a marker should be
    const marker = bytes[i + 1] as number;
    if (marker === 0xff) {
      parts.push(bytes.subarray(i, i + 1)); // fill byte
      i += 1;
      continue;
    }
    // The end of the image: what follows is a trailer, dealt with below.
    if (marker === 0xd9) {
      parts.push(bytes.subarray(i, i + 2));
      i += 2;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(bytes.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (i + 4 > n) return unchanged(bytes);
    const len = ((bytes[i + 2] as number) << 8) | (bytes[i + 3] as number);
    const end = i + 2 + len;
    if (len < 2 || end > n) return unchanged(bytes);
    const at = i + 4;
    let drop: MetadataKind | null = null;
    if (marker === 0xe1 && startsWith(bytes, at, "Exif\0")) {
      drop = "EXIF";
      const e = readExif(bytes.subarray(at, end));
      location ||= e.location;
      if (orientation === 1) orientation = e.orientation;
    } else if (
      marker === 0xe1 &&
      (startsWith(bytes, at, "http://ns.adobe.com/xap/1.0/\0") ||
        startsWith(bytes, at, "http://ns.adobe.com/xmp/extension/\0"))
    )
      drop = "XMP";
    else if (marker === 0xed && startsWith(bytes, at, "Photoshop 3.0\0")) drop = "IPTC";
    if (drop) {
      removed.push(drop);
      if (drop === "EXIF" && orientation !== 1 && !wroteOrientation) {
        const body = concat([enc.encode("Exif\0\0"), orientationOnlyExif(orientation)]);
        const size = body.byteLength + 2;
        parts.push(new Uint8Array([0xff, 0xe1, size >> 8, size & 0xff]), body);
        wroteOrientation = true;
      }
    } else {
      if (marker === 0xe2 && startsWith(bytes, at, "MPF\0")) mpf = parts.length;
      parts.push(bytes.subarray(i, end));
    }
    i = end;
    if (marker === 0xda) {
      // A scan: its entropy-coded data runs to the next marker that is not a
      // stuffed byte (FF 00), a restart (FF D0-D7) or fill. A progressive file
      // has several scans, with tables between them.
      let j = i;
      while (j + 1 < n) {
        if (bytes[j] !== 0xff) {
          j++;
          continue;
        }
        const m = bytes[j + 1] as number;
        if (m === 0x00 || (m >= 0xd0 && m <= 0xd7)) j += 2;
        else if (m === 0xff) j += 1;
        else break;
      }
      if (j + 1 >= n) return unchanged(bytes); // no end: cut short, for the import's own check
      parts.push(bytes.subarray(i, j));
      i = j;
    }
  }
  // After the end of the image: padding stays; anything else (an Apple MPF
  // depth map or second image, a motion photo's clip) carries metadata of its
  // own, GPS included, so it goes, and the MPF index that pointed at it.
  const trailer = bytes.subarray(i);
  if (trailer.some((b) => b !== 0x00 && b !== 0xff && b !== 0x0a && b !== 0x0d && b !== 0x20)) {
    removed.push("trailer");
    if (mpf >= 0) parts[mpf] = new Uint8Array(0);
  } else parts.push(trailer);
  return result(bytes, parts, removed, location, orientation);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let k = 0; k < 256; k++) {
    let c = k;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[k] = c >>> 0;
  }
  return t;
})();
const crc32 = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (const x of b) c = (CRC_TABLE[(c ^ x) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.byteLength);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.byteLength);
  out.set(enc.encode(type), 4);
  out.set(data, 8);
  v.setUint32(8 + data.byteLength, crc32(out.subarray(4, 8 + data.byteLength)));
  return out;
}

/** What a PNG text chunk's keyword says it carries, when it is metadata this removes. */
function pngTextKind(keyword: string): MetadataKind | null {
  const k = keyword.toLowerCase();
  if (k === "xml:com.adobe.xmp" || k === "raw profile type xmp") return "XMP";
  if (k === "raw profile type exif" || k === "raw profile type app1") return "EXIF";
  if (k === "raw profile type iptc" || k === "raw profile type 8bim") return "IPTC";
  // Text that says only which program wrote the file stays; any other text
  // (Make, Model, Author, Comment, Creation Time, a caption) may say who took
  // it, with what, or where, and goes.
  return PNG_TEXT_KEPT.has(k) ? null : "text";
}

/** The PNG text keywords kept: harmless, saying only what made the file. */
const PNG_TEXT_KEPT = new Set(["software"]);

function stripPng(bytes: Uint8Array): Stripped {
  const n = bytes.byteLength;
  const v = new DataView(bytes.buffer, bytes.byteOffset, n);
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  const removed: MetadataKind[] = [];
  let location = false;
  let orientation = 1;
  let i = 8;
  while (i + 12 <= n) {
    const len = v.getUint32(i);
    const end = i + 12 + len;
    if (end > n) return unchanged(bytes);
    const type = String.fromCharCode(...bytes.subarray(i + 4, i + 8));
    const data = bytes.subarray(i + 8, i + 8 + len);
    let drop: MetadataKind | null = null;
    if (type === "eXIf") {
      drop = "EXIF";
      const e = readExif(data);
      location ||= e.location;
      orientation = e.orientation;
    } else if (type === "tEXt" || type === "zTXt" || type === "iTXt") {
      const nul = data.indexOf(0);
      drop = pngTextKind(String.fromCharCode(...data.subarray(0, nul < 0 ? 0 : nul)));
    }
    if (drop) {
      removed.push(drop);
      if (drop === "EXIF" && orientation !== 1)
        parts.push(pngChunk("eXIf", orientationOnlyExif(orientation)));
    } else parts.push(bytes.subarray(i, end));
    i = end;
    if (type === "IEND") break;
  }
  // Anything after IEND, as it came.
  if (i < n) parts.push(bytes.subarray(i));
  return result(bytes, parts, removed, location, orientation);
}

function stripWebp(bytes: Uint8Array): Stripped {
  const n = bytes.byteLength;
  if (
    !startsWith(bytes, 0, "RIFF") ||
    !startsWith(bytes, 8, "WEBP") ||
    !startsWith(bytes, 12, "VP8X")
  )
    return unchanged(bytes);
  const v = new DataView(bytes.buffer, bytes.byteOffset, n);
  const parts: Uint8Array[] = [];
  const removed: MetadataKind[] = [];
  let location = false;
  let orientation = 1;
  let i = 12;
  while (i + 8 <= n) {
    const fourcc = String.fromCharCode(...bytes.subarray(i, i + 4));
    const size = v.getUint32(i + 4, true);
    const end = Math.min(n, i + 8 + size + (size & 1));
    if (i + 8 + size > n) return unchanged(bytes);
    if (fourcc === "EXIF") {
      removed.push("EXIF");
      const e = readExif(bytes.subarray(i + 8, i + 8 + size));
      location ||= e.location;
      orientation = e.orientation;
      if (orientation !== 1) {
        const tiff = orientationOnlyExif(orientation);
        const head = new Uint8Array(8);
        head.set(enc.encode("EXIF"));
        new DataView(head.buffer).setUint32(4, tiff.byteLength, true);
        parts.push(head, tiff); // 26 bytes: even, no pad
      }
    } else if (fourcc === "XMP ") removed.push("XMP");
    else parts.push(bytes.subarray(i, end));
    i = end;
  }
  if (removed.length === 0) return unchanged(bytes);
  const body = concat(parts);
  // The VP8X flags (the first byte of its payload, 8 bytes in): EXIF 0x08, XMP 0x04.
  body[8] = ((body[8] as number) & ~0x0c) | (orientation !== 1 ? 0x08 : 0);
  const head = new Uint8Array(12);
  head.set(enc.encode("RIFF"));
  new DataView(head.buffer).setUint32(4, body.byteLength + 4, true);
  head.set(enc.encode("WEBP"), 8);
  return {
    bytes: concat([head, body]),
    removed: [...new Set(removed)],
    location,
    ...(orientation !== 1 ? { orientation } : {}),
  };
}

function stripGif(bytes: Uint8Array): Stripped {
  const n = bytes.byteLength;
  const packed = bytes[10] ?? 0;
  let i = 13;
  if (packed & 0x80) i += 3 * 2 ** ((packed & 0x07) + 1);
  const parts: Uint8Array[] = [bytes.subarray(0, i)];
  const removed: MetadataKind[] = [];
  /** Past a run of sub-blocks (a length byte, that many bytes, until a 0). */
  const pastBlocks = (at: number) => {
    let j = at;
    while (j < n && bytes[j] !== 0) j += (bytes[j] as number) + 1;
    return j + 1;
  };
  while (i < n) {
    const b = bytes[i];
    if (b === 0x2c) {
      const local = bytes[i + 9] ?? 0;
      let j = i + 10;
      if (local & 0x80) j += 3 * 2 ** ((local & 0x07) + 1);
      j = pastBlocks(j + 1);
      parts.push(bytes.subarray(i, j));
      i = j;
    } else if (b === 0x21) {
      const label = bytes[i + 1];
      const j = pastBlocks(i + 2);
      const xmp = label === 0xff && bytes[i + 2] === 11 && startsWith(bytes, i + 3, "XMP DataXMP");
      if (xmp) removed.push("XMP");
      else parts.push(bytes.subarray(i, j));
      i = j;
    } else {
      parts.push(bytes.subarray(i)); // the trailer, and anything after it
      break;
    }
  }
  if (i > n) return unchanged(bytes);
  return result(bytes, parts, removed, false, 1);
}

/** What was taken out, in words, for the chat line and the import note: no parentheses, as it is often put inside some. */
export function strippedWords(s: Pick<Stripped, "removed" | "location" | "orientation">): string {
  const kinds = s.removed.filter((k) => k !== "trailer");
  const list =
    kinds.length > 1
      ? `${kinds.slice(0, -1).join(", ")} and ${kinds[kinds.length - 1]}`
      : (kinds[0] ?? "");
  const said: string[] = [];
  if (list)
    said.push(
      `its ${list} metadata was removed${s.location ? ", location included" : ""}${
        s.orientation ? ", but its orientation was kept" : ""
      }`,
    );
  if (s.removed.includes("trailer"))
    said.push("what followed the image, extra images or a motion clip, was dropped");
  return said.join("; ");
}

/**
 * Whether bytes still hold metadata an import promises to remove: XMP, or an
 * EXIF block with a location. What a strip is checked against before the
 * import says it removed anything.
 */
export function holdsMetadata(bytes: Uint8Array): boolean {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.includes("<x:xmpmeta") || b.includes("http://ns.adobe.com/xap")) return true;
  for (let at = b.indexOf("Exif\0\0"); at >= 0; at = b.indexOf("Exif\0\0", at + 1))
    if (readExif(bytes.subarray(at)).location) return true;
  return false;
}
