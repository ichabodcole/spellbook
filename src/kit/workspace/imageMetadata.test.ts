// Every image brought in loses its metadata (the user's decision, 2026-10-06),
// and an image written as it came loses it from the container alone: GPS and
// XMP present before, gone after; the coded image byte for byte the same; the
// file still decodes, at the same size; and a photo's orientation still turns
// it upright, kept in a one-tag EXIF block.
import { describe, expect, test } from "bun:test";
import { IMAGE_IMPORT_DEFAULTS } from "../lib/imageImport.ts";
import {
  GIF_1PX,
  GIF_2_FRAMES,
  gifWithXmp,
  jpegBytes,
  jpegWithMetadata,
  pngBytes,
  pngWithMetadata,
  webpWithMetadata,
} from "../lib/testImages.ts";
import { holdsMetadata, readExif, stripMetadata, strippedWords } from "./imageMetadata";
import { isAnimated, optimiseImport } from "./images";

const has = (b: Uint8Array, s: string) => Buffer.from(b).includes(s);
/** A PNG chunk with its CRC left zero: the strip never checks one. */
const pngChunkOf = (type: string, data: Uint8Array) => {
  const out = new Uint8Array(12 + data.length);
  new DataView(out.buffer).setUint32(0, data.length);
  out.set(
    [...type].map((c) => c.charCodeAt(0)),
    4,
  );
  out.set(data, 8);
  return out;
};
const size = async (b: Uint8Array) => new Bun.Image(b).metadata();
/** The bytes from a JPEG's start of scan on: the coded image itself. */
const scan = (b: Uint8Array) => {
  for (let i = 2; i + 1 < b.length; i++)
    if (b[i] === 0xff && b[i + 1] === 0xda) return b.subarray(i);
  throw new Error("no SOS");
};
/** A PNG's or WebP's image chunks, by name, as they stand. */
const pngChunks = (b: Uint8Array, want: string) => {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Uint8Array[] = [];
  for (let i = 8; i + 12 <= b.length; ) {
    const len = v.getUint32(i);
    if (String.fromCharCode(...b.subarray(i + 4, i + 8)) === want)
      out.push(b.subarray(i, i + 12 + len));
    i += 12 + len;
  }
  return out;
};
const riffChunks = (b: Uint8Array) => {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Record<string, Uint8Array> = {};
  for (let i = 12; i + 8 <= b.length; ) {
    const size = v.getUint32(i + 4, true);
    out[String.fromCharCode(...b.subarray(i, i + 4))] = b.subarray(i, i + 8 + size);
    i += 8 + size + (size & 1);
  }
  return out;
};

describe("a JPEG", () => {
  test("loses its EXIF, XMP and IPTC; keeps its ICC segment and its coded image", async () => {
    const plain = await jpegBytes(64, 48);
    const full = jpegWithMetadata(plain);
    expect(readExif(full.subarray(6)).location).toBe(true);
    expect(has(full, "GPSLatitude")).toBe(true);
    const s = stripMetadata(full, "image/jpeg");
    expect(s.removed).toEqual(["EXIF", "XMP", "IPTC"]);
    expect(s.location).toBe(true);
    expect(s.orientation).toBeUndefined();
    for (const gone of ["Exif", "GPSLatitude", "xmpmeta", "Photoshop 3.0"])
      expect(has(s.bytes, gone)).toBe(false);
    expect(has(s.bytes, "ICC_PROFILE")).toBe(true);
    expect(scan(s.bytes)).toEqual(scan(full));
    // Nothing else changed: it is the plain JPEG plus its ICC segment.
    expect(s.bytes.length).toBe(plain.length + 4 + 12 + 2 + 18);
    expect(await size(s.bytes)).toMatchObject({ width: 64, height: 48, format: "jpeg" });
  });

  test("turned by its EXIF, it keeps the orientation alone, and still shows upright", async () => {
    const full = jpegWithMetadata(await jpegBytes(64, 48), 6);
    expect(await size(full)).toMatchObject({ width: 48, height: 64 });
    const s = stripMetadata(full, "image/jpeg");
    expect(s.orientation).toBe(6);
    expect(has(s.bytes, "GPSLatitude")).toBe(false);
    // One EXIF block left, holding one tag and no GPS.
    const at = Buffer.from(s.bytes).indexOf("Exif");
    expect(readExif(s.bytes.subarray(at))).toEqual({ orientation: 6, location: false });
    expect(await size(s.bytes)).toMatchObject({ width: 48, height: 64 });
    expect(scan(s.bytes)).toEqual(scan(full));
  });

  test("with none, it is the very bytes that came in", async () => {
    const plain = await jpegBytes(16, 16);
    expect(stripMetadata(plain, "image/jpeg").bytes).toBe(plain);
  });
});

describe("a PNG", () => {
  test("loses eXIf and the XMP text; keeps other text and every image chunk", async () => {
    const plain = pngBytes(40, 30);
    const full = pngWithMetadata(plain);
    const s = stripMetadata(full, "image/png");
    expect(s.removed).toEqual(["EXIF", "XMP"]);
    expect(s.location).toBe(true);
    expect(pngChunks(s.bytes, "eXIf")).toEqual([]);
    expect(pngChunks(s.bytes, "iTXt")).toEqual([]);
    expect(pngChunks(s.bytes, "tEXt").length).toBe(1);
    expect(pngChunks(s.bytes, "IDAT")).toEqual(pngChunks(full, "IDAT"));
    expect(await size(s.bytes)).toMatchObject({ width: 40, height: 30, format: "png" });
  });

  test("text that may say who took it, with what, goes; Software stays", () => {
    const text = (k: string, v: string) => {
      const data = new Uint8Array(
        [...k]
          .map((c) => c.charCodeAt(0))
          .concat(
            [0],
            [...v].map((c) => c.charCodeAt(0)),
          ),
      );
      return data;
    };
    const plain = pngBytes(8, 8);
    const chunks = [
      ["Make", "Phone"],
      ["Model", "X"],
      ["Author", "Someone"],
      ["Software", "a test"],
    ].map(([k, v]) => pngChunkOf("tEXt", text(k as string, v as string)));
    const full = new Uint8Array([
      ...plain.subarray(0, 33),
      ...chunks.flatMap((c) => [...c]),
      ...plain.subarray(33),
    ]);
    const s = stripMetadata(full, "image/png");
    expect(s.removed).toEqual(["text"]);
    const kept = pngChunks(s.bytes, "tEXt").map((c) => String.fromCharCode(...c.subarray(8, -4)));
    expect(kept).toEqual(["Software\0a test"]);
  });

  test("an eXIf orientation is kept alone", () => {
    const s = stripMetadata(pngWithMetadata(pngBytes(8, 8), 8), "image/png");
    const [exif] = pngChunks(s.bytes, "eXIf");
    expect(readExif((exif as Uint8Array).subarray(8, -4))).toEqual({
      orientation: 8,
      location: false,
    });
  });
});

describe("a WebP", () => {
  test("loses its EXIF and XMP chunks, with the flags and the RIFF size fixed", async () => {
    const full = await webpWithMetadata();
    expect(await size(full)).toMatchObject({ width: 40, height: 30 });
    const s = stripMetadata(full, "image/webp");
    expect(s.removed).toEqual(["EXIF", "XMP"]);
    const chunks = riffChunks(s.bytes);
    expect(Object.keys(chunks)).toEqual(["VP8X", "ALPH", "VP8 "]);
    expect((s.bytes[20] as number) & 0x0c).toBe(0);
    expect((s.bytes[20] as number) & 0x10).toBe(0x10); // still says it has alpha
    expect(new DataView(s.bytes.buffer).getUint32(4, true)).toBe(s.bytes.length - 8);
    expect(chunks["VP8 "]).toEqual(riffChunks(full)["VP8 "]);
    expect(await size(s.bytes)).toMatchObject({ width: 40, height: 30, format: "webp" });
  });

  test("an orientation is kept in a one-tag EXIF chunk, flagged", async () => {
    const s = stripMetadata(await webpWithMetadata(3), "image/webp");
    expect((s.bytes[20] as number) & 0x08).toBe(0x08);
    const exif = riffChunks(s.bytes).EXIF as Uint8Array;
    expect(readExif(exif.subarray(8))).toEqual({ orientation: 3, location: false });
    expect(await size(s.bytes)).toMatchObject({ format: "webp" });
  });
});

describe("a GIF", () => {
  test("loses its XMP extension and keeps its comment, frames and animation", async () => {
    const s = stripMetadata(gifWithXmp(), "image/gif");
    expect(s.removed).toEqual(["XMP"]);
    expect(has(s.bytes, "xmpmeta")).toBe(false);
    expect(has(s.bytes, "note")).toBe(true);
    expect(s.bytes.length).toBe(GIF_1PX.length + 8);
    const animated = stripMetadata(gifWithXmp(GIF_2_FRAMES), "image/gif");
    expect(isAnimated(animated.bytes)).toBe(true);
    expect(await size(animated.bytes)).toMatchObject({ width: 1, height: 1, format: "gif" });
  });
});

describe("what follows a JPEG's end", () => {
  test("a second JPEG with GPS after the first (an MPF image, a trailer) goes, and the MPF index with it", async () => {
    const main = await jpegBytes(64, 48);
    const second = jpegWithMetadata(await jpegBytes(16, 16));
    // An MPF segment in the main image, pointing at what follows.
    const mpf = [
      0xff,
      0xe2,
      0,
      12,
      ...[..."MPF\0"].map((c) => c.charCodeAt(0)),
      0x49,
      0x49,
      0x2a,
      0,
      8,
      0,
    ];
    const withMpf = new Uint8Array([...main.subarray(0, 2), ...mpf, ...main.subarray(2)]);
    const trailer = new Uint8Array([...withMpf, ...second]);
    expect(holdsMetadata(trailer)).toBe(true);
    const s = stripMetadata(trailer, "image/jpeg");
    expect(s.removed).toEqual(["trailer"]);
    expect(holdsMetadata(s.bytes)).toBe(false);
    expect(new Uint8Array(s.bytes)).toEqual(main);
    expect(strippedWords(s)).toBe(
      "what followed the image, extra images or a motion clip, was dropped",
    );
    const r = await optimiseImport(trailer, IMAGE_IMPORT_DEFAULTS);
    expect(holdsMetadata(r.bytes)).toBe(false);
    expect(r.stripped).toBe("what followed the image, extra images or a motion clip, was dropped");
  });

  test("padding after the end stays, and a progressive JPEG's scans are walked whole", async () => {
    const main = await jpegBytes(32, 32);
    const padded = new Uint8Array([...jpegWithMetadata(main), 0, 0, 0xff]);
    const s = stripMetadata(padded, "image/jpeg");
    expect(s.removed).not.toContain("trailer");
    expect(s.bytes.subarray(-3)).toEqual(new Uint8Array([0, 0, 0xff]));
    const progressive = new Uint8Array(
      await new Bun.Image(pngBytes(64, 64)).jpeg({ progressive: true }).bytes(),
    );
    const p = stripMetadata(jpegWithMetadata(progressive), "image/jpeg");
    expect(p.removed).toEqual(["EXIF", "XMP", "IPTC"]);
    expect(await size(p.bytes)).toMatchObject({ width: 64, height: 64 });
  });

  test("never says it removed what is still there", async () => {
    // Cut short in its scan: the walk cannot find the end, so nothing is stripped.
    const full = jpegWithMetadata(await jpegBytes(64, 48));
    const cut = full.subarray(0, full.length - 40);
    const r = await optimiseImport(cut, IMAGE_IMPORT_DEFAULTS);
    expect(r.stripped).toBeUndefined();
    expect(r.metaKept).toBe(
      "its metadata could not be removed without damaging it, so it was kept",
    );
  });
});

describe("through the import", () => {
  test("with the defaults, a photo keeps its pixels and loses its location, and says so", async () => {
    const full = jpegWithMetadata(await jpegBytes(64, 48), 6);
    const r = await optimiseImport(full, IMAGE_IMPORT_DEFAULTS);
    expect(r.done).toBeUndefined();
    expect(r.stripped).toBe(
      "its EXIF, XMP and IPTC metadata was removed, location included, but its orientation was kept",
    );
    expect(has(r.bytes, "GPSLatitude")).toBe(false);
    expect(scan(r.bytes)).toEqual(scan(full));
    expect(await size(r.bytes)).toMatchObject({ width: 48, height: 64 });
  });

  test("an animated GIF left as it came loses its XMP all the same", async () => {
    const r = await optimiseImport(gifWithXmp(GIF_2_FRAMES), {
      ...IMAGE_IMPORT_DEFAULTS,
      format: "webp",
    });
    expect(r.left).toContain("animated");
    expect(r.stripped).toBe("its XMP metadata was removed");
    expect(isAnimated(r.bytes)).toBe(true);
  });

  test("a converted image says what the original carried", async () => {
    const r = await optimiseImport(pngWithMetadata(pngBytes(300, 200)), {
      ...IMAGE_IMPORT_DEFAULTS,
      format: "webp",
    });
    expect(r.type).toBe("image/webp");
    expect(r.stripped).toBe("its EXIF and XMP metadata was removed, location included");
    expect(has(r.bytes, "Exif") || has(r.bytes, "xmpmeta")).toBe(false);
  });

  test("an AVIF with metadata keeps it, and says so", async () => {
    const avif = new Uint8Array([
      0,
      0,
      0,
      28,
      ...[..."ftypavif"].map((c) => c.charCodeAt(0)),
      ...[..."....Exif.."].map((c) => c.charCodeAt(0)),
    ]);
    const r = await optimiseImport(avif, IMAGE_IMPORT_DEFAULTS);
    expect(r.metaKept).toContain("AVIF");
    expect(r.bytes).toBe(avif);
  });
});
