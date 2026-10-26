// The image import settings applied (kit-image-import-settings): `optimiseImport`
// converts to WebP at a quality, caps the longest side without ever enlarging,
// turns a photo upright by its EXIF orientation before dropping its metadata,
// and leaves alone what would not benefit (animated, AVIF, already within the
// cap, no smaller as WebP). The settings' reading and checking from the prefs.
import { describe, expect, test } from "bun:test";
import {
  describeImageImport,
  IMAGE_IMPORT_DEFAULTS,
  IMAGE_PREF_KEYS,
  type ImageImportSettings,
  imageImportPrefs,
  imagePrefRefusal,
  readImageImportSettings,
} from "../lib/imageImport.ts";
import {
  GIF_1PX,
  GIF_2_FRAMES,
  heicBytes,
  jpegBytes,
  pngBytes,
  webpBytes,
  withExifOrientation,
} from "../lib/testImages.ts";
import { isAnimated, optimiseImport } from "./images";

const settings = (s: Partial<ImageImportSettings>): ImageImportSettings => ({
  ...IMAGE_IMPORT_DEFAULTS,
  ...s,
});
const size = async (bytes: Uint8Array) => new Bun.Image(bytes).metadata();
const ascii = (bytes: Uint8Array, s: string) => Buffer.from(bytes).includes(s);

/** A PNG with an `acTL` chunk before its pixels: an animated PNG, to the eye that checks. */
const apng = (): Uint8Array => {
  const png = pngBytes(4, 4);
  const acTL = new Uint8Array([0, 0, 0, 8, ...[..."acTL"].map((c) => c.charCodeAt(0)), 0, 0, 0, 2]);
  const chunk = new Uint8Array([...acTL, 0, 0, 0, 1, 0, 0, 0, 0]);
  return new Uint8Array([...png.subarray(0, 33), ...chunk, ...png.subarray(33)]);
};

describe("the settings in the prefs", () => {
  test("absent, they are the defaults, which change nothing", () => {
    expect(readImageImportSettings({})).toEqual({ format: "keep", quality: 80, maxSide: null });
    expect(describeImageImport(readImageImportSettings({}))).toBe("kept as they come in");
  });

  test("written and read back the same", () => {
    const s = settings({ format: "webp", quality: 70, maxSide: 2048 });
    expect(readImageImportSettings(imageImportPrefs(s))).toEqual(s);
    expect(describeImageImport(s)).toBe("WebP at quality 70, longest side 2048 px");
  });

  test("a bad value is refused in words, and reads as its default when found in the file", () => {
    expect(imagePrefRefusal(IMAGE_PREF_KEYS.format, "avif")).toContain("keep or webp");
    expect(imagePrefRefusal(IMAGE_PREF_KEYS.quality, "0")).toContain("1 to 100");
    expect(imagePrefRefusal(IMAGE_PREF_KEYS.quality, "80.5")).not.toBeNull();
    expect(imagePrefRefusal(IMAGE_PREF_KEYS.maxSide, "10")).toContain("64");
    expect(imagePrefRefusal(IMAGE_PREF_KEYS.maxSide, "none")).toBeNull();
    expect(imagePrefRefusal("panes:test", "anything")).toBeNull();
    expect(
      readImageImportSettings({
        [IMAGE_PREF_KEYS.format]: "gif",
        [IMAGE_PREF_KEYS.quality]: "900",
        [IMAGE_PREF_KEYS.maxSide]: "huge",
      }),
    ).toEqual(IMAGE_IMPORT_DEFAULTS);
  });
});

describe("isAnimated", () => {
  test("finds a second GIF frame, the WebP animation flag and an APNG's acTL", async () => {
    expect(isAnimated(GIF_2_FRAMES)).toBe(true);
    expect(isAnimated(GIF_1PX)).toBe(false);
    expect(isAnimated(apng())).toBe(true);
    expect(isAnimated(pngBytes(4, 4))).toBe(false);
    const vp8x = (flags: number) =>
      new Uint8Array([
        ...[..."RIFF"].map((c) => c.charCodeAt(0)),
        30,
        0,
        0,
        0,
        ...[..."WEBPVP8X"].map((c) => c.charCodeAt(0)),
        10,
        0,
        0,
        0,
        flags,
        0,
        0,
        0,
      ]);
    expect(isAnimated(vp8x(0x02))).toBe(true);
    expect(isAnimated(vp8x(0x10))).toBe(false);
    expect(isAnimated(await webpBytes(8, 8))).toBe(false);
  });
});

describe("optimiseImport", () => {
  test("with the defaults, the bytes are the ones that came in, and nothing is said", async () => {
    const bytes = await jpegBytes(400, 200);
    const r = await optimiseImport(bytes, IMAGE_IMPORT_DEFAULTS);
    expect(r.bytes).toBe(bytes);
    expect(r.type).toBe("image/jpeg");
    expect(r.done).toBeUndefined();
    expect(r.left).toBeUndefined();
  });

  test("converts to WebP at the quality, keeping the size", async () => {
    const bytes = await jpegBytes(400, 200);
    const r = await optimiseImport(bytes, settings({ format: "webp", quality: 60 }));
    expect(r.type).toBe("image/webp");
    expect(ascii(r.bytes.subarray(8, 12), "WEBP")).toBe(true);
    expect(await size(r.bytes)).toMatchObject({ width: 400, height: 200, format: "webp" });
    expect(r.bytes.byteLength).toBeLessThan(bytes.byteLength);
    expect(r.done).toStartWith("converted from JPEG to WebP at quality 60: ");
    // A lower quality makes a smaller file.
    const high = await optimiseImport(bytes, settings({ format: "webp", quality: 95 }));
    expect(r.bytes.byteLength).toBeLessThan(high.bytes.byteLength);
  });

  test("a PNG with transparency keeps it as WebP", async () => {
    const png = pngBytes(300, 200, undefined, undefined, true);
    const r = await optimiseImport(png, settings({ format: "webp" }));
    expect(r.type).toBe("image/webp");
    // An extended WebP whose header says it has alpha, and the alpha chunk itself.
    expect(ascii(r.bytes.subarray(12, 16), "VP8X")).toBe(true);
    expect((r.bytes[20] ?? 0) & 0x10).toBe(0x10);
    expect(ascii(r.bytes, "ALPH")).toBe(true);
  });

  test("caps the longest side, in the image's own format when asked to keep it", async () => {
    const wide = await jpegBytes(400, 200);
    const r = await optimiseImport(wide, settings({ maxSide: 100, quality: 70 }));
    expect(r.type).toBe("image/jpeg");
    expect(await size(r.bytes)).toMatchObject({ width: 100, height: 50 });
    expect(r.done).toStartWith("made smaller from 400×200 to 100×50 at quality 70: ");
    const tall = pngBytes(60, 300);
    const p = await optimiseImport(tall, settings({ maxSide: 150 }));
    expect(p.type).toBe("image/png");
    expect(await size(p.bytes)).toMatchObject({ width: 30, height: 150 });
  });

  test("converts and caps at once", async () => {
    const r = await optimiseImport(
      await jpegBytes(400, 200),
      settings({ format: "webp", maxSide: 200 }),
    );
    expect(r.type).toBe("image/webp");
    expect(await size(r.bytes)).toMatchObject({ width: 200, height: 100, format: "webp" });
    expect(r.done).toStartWith(
      "converted from JPEG to WebP at quality 80, made smaller from 400×200 to 200×100: ",
    );
  });

  test("never enlarges: an image within the cap is left as it came, and says so", async () => {
    const bytes = await jpegBytes(400, 200);
    const r = await optimiseImport(bytes, settings({ maxSide: 1000 }));
    expect(r.bytes).toBe(bytes);
    expect(r.left).toBe("it is already within 1000 px");
    // Converting still happens within the cap; only the size is left.
    const w = await optimiseImport(bytes, settings({ format: "webp", maxSide: 1000 }));
    expect(await size(w.bytes)).toMatchObject({ width: 400, height: 200, format: "webp" });
    // A WebP within the cap is left whole.
    const already = await webpBytes(40, 40);
    const a = await optimiseImport(already, settings({ format: "webp", maxSide: 1000 }));
    expect(a.bytes).toBe(already);
    expect(a.left).toBe("it is already within 1000 px and WebP");
  });

  test("leaves an animated image, an AVIF, and a GIF that would need resizing", async () => {
    const webp = settings({ format: "webp", maxSide: 100 });
    const gif = await optimiseImport(GIF_2_FRAMES, webp);
    expect(gif.bytes).toBe(GIF_2_FRAMES);
    expect(gif.left).toContain("animated");
    const a = apng();
    expect((await optimiseImport(a, webp)).left).toContain("animated");
    const avif = new Uint8Array([0, 0, 0, 28, ...[..."ftypavif"].map((c) => c.charCodeAt(0))]);
    expect((await optimiseImport(avif, webp)).left).toContain("AVIF");
    // A still GIF within the cap, kept as GIF, is left as it came.
    const stillGif = await optimiseImport(GIF_1PX, settings({ maxSide: 64 }));
    expect(stillGif.bytes).toBe(GIF_1PX);
  });

  test("an image that as WebP would be no smaller is left as it came", async () => {
    // A one-pixel GIF is 43 bytes; no WebP is that small.
    const r = await optimiseImport(GIF_1PX, settings({ format: "webp" }));
    expect(r.bytes).toBe(GIF_1PX);
    expect(r.left).toStartWith("as WebP it would be no smaller");
  });

  test("bytes it cannot decode are left for the import's own checks", async () => {
    const junk = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const r = await optimiseImport(junk, settings({ format: "webp" }));
    expect(r.bytes).toBe(junk);
    expect(r.left).toContain("could not be decoded");
  });

  test("a photo is turned upright by its EXIF orientation, and its metadata is not carried", async () => {
    // Stored 400 wide and 200 high, to be shown turned: 200 wide and 400 high.
    const photo = withExifOrientation(await jpegBytes(400, 200), 6);
    expect(ascii(photo, "Exif")).toBe(true);
    const r = await optimiseImport(photo, settings({ format: "webp", maxSide: 200 }));
    expect(await size(r.bytes)).toMatchObject({ width: 100, height: 200 });
    expect(r.done).toContain("from 200×400 to 100×200");
    expect(ascii(r.bytes, "Exif") || ascii(r.bytes, "EXIF")).toBe(false);
    // Kept as JPEG and made smaller: upright too, and no EXIF (so no GPS) left.
    const j = await optimiseImport(photo, settings({ maxSide: 100 }));
    expect(await size(j.bytes)).toMatchObject({ width: 50, height: 100 });
    expect(ascii(j.bytes, "Exif")).toBe(false);
    // Left as it came, it loses its EXIF but for the orientation, so it still
    // shows upright: no camera, no location.
    const kept = await optimiseImport(photo, settings({ maxSide: 1000 }));
    expect(kept.left).toBe("it is already within 1000 px");
    expect(kept.stripped).toBe(
      "its EXIF metadata was removed, location included, but its orientation was kept",
    );
    expect(await size(kept.bytes)).toMatchObject({ width: 200, height: 400 });
  });

  test("a HEIC photo becomes WebP when asked, else JPEG, where the machine reads HEIC", async () => {
    const heic = await heicBytes(64, 32);
    if (!heic) return; // Linux: no HEIC codec, and `heicToJpeg`'s own tests cover the refusal.
    const w = await optimiseImport(heic, settings({ format: "webp" }), { heic: true });
    expect(w.type).toBe("image/webp");
    expect(w.done).toStartWith("converted from HEIC to WebP at quality 80");
    const j = await optimiseImport(heic, IMAGE_IMPORT_DEFAULTS, { heic: true });
    expect(j.type).toBe("image/jpeg");
    expect(j.done).toStartWith("converted from HEIC to JPEG at quality 90");
    const small = await optimiseImport(heic, settings({ maxSide: 32 }), { heic: true });
    expect(await size(small.bytes)).toMatchObject({ width: 32, height: 16, format: "jpeg" });
  });
});
