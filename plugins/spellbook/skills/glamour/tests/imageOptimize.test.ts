import { expect, test } from "bun:test";
import { OPTIMIZE, optimizeImageBuffer } from "../surface/state/imageOptimize";

test("optimize policy constants are sane", () => {
  expect(OPTIMIZE.maxDim).toBe(1200);
  expect(OPTIMIZE.quality).toBeGreaterThan(0.5);
});

test("optimizeImageBuffer downscales a large image to webp under maxDim", async () => {
  const sharp = (await import("sharp")).default;
  const big = await sharp({
    create: { width: 3000, height: 2000, channels: 3, background: "#888" },
  })
    .png()
    .toBuffer();
  const { data, mime } = await optimizeImageBuffer(big);
  expect(mime).toBe("image/webp");
  const meta = await sharp(data).metadata();
  expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1200);
  expect(data.byteLength).toBeLessThan(big.byteLength);
});
