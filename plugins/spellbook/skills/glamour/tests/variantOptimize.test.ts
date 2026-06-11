// tests/variantOptimize.test.ts
import { expect, test } from "bun:test";
import sharp from "sharp";
import { optimizeVariantSrc } from "../scripts/server";

test("optimizeVariantSrc downscales a large PNG data-url to a webp data-url ≤1200px", async () => {
  const png = await sharp({
    create: { width: 2000, height: 1500, channels: 3, background: "#c43c3c" },
  })
    .png()
    .toBuffer();
  const src = `data:image/png;base64,${png.toString("base64")}`;
  const out = await optimizeVariantSrc(src);
  expect(out.startsWith("data:image/webp;base64,")).toBe(true);
  const outBuf = Buffer.from(out.slice("data:image/webp;base64,".length), "base64");
  const meta = await sharp(outBuf).metadata();
  expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1200);
  expect(outBuf.byteLength).toBeLessThan(png.byteLength);
});

test("optimizeVariantSrc passes non-data-url src through unchanged", async () => {
  const url = "https://example.com/x.png";
  expect(await optimizeVariantSrc(url)).toBe(url);
});
