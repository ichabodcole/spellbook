// An image's pixel size from its header: what the rendered view reserves for an
// embed before its bytes arrive. Real files, made by the test helpers and
// `Bun.Image`, never downloaded.
import { describe, expect, test } from "bun:test";
import { IMAGE_HEAD_BYTES, type ImageType, imageSize, sniffImage } from "./docFormat.ts";
import { GIF_1PX, jpegBytes, pngBytes, webpBytes } from "./testImages.ts";

const sizeOf = (bytes: Uint8Array) =>
  imageSize(bytes.subarray(0, IMAGE_HEAD_BYTES), sniffImage(bytes) as ImageType);

describe("an image's size from its header", () => {
  test("PNG, JPEG, WebP and GIF", async () => {
    expect(sizeOf(pngBytes(40, 30))).toEqual({ width: 40, height: 30 });
    expect(sizeOf(await jpegBytes(90, 120))).toEqual({ width: 90, height: 120 });
    expect(sizeOf(await webpBytes(33, 21))).toEqual({ width: 33, height: 21 });
    expect(sizeOf(GIF_1PX)).toEqual({ width: 1, height: 1 });
  });

  test("lossless WebP and AVIF, where the machine can write them", async () => {
    const png = pngBytes(50, 20);
    for (const make of [
      () => new Bun.Image(png).webp({ lossless: true }).bytes(),
      () => new Bun.Image(png).avif().bytes(),
    ]) {
      let bytes: Uint8Array;
      try {
        bytes = await make();
      } catch {
        continue; // no encoder here
      }
      expect(sizeOf(bytes)).toEqual({ width: 50, height: 20 });
    }
  });

  test("a header cut short or not where it should be is no size", () => {
    expect(imageSize(pngBytes(40, 30).subarray(0, 8), "image/png")).toBeNull();
    expect(imageSize(new Uint8Array(64), "image/jpeg")).toBeNull();
    expect(imageSize(new Uint8Array(64), "image/webp")).toBeNull();
  });
});
