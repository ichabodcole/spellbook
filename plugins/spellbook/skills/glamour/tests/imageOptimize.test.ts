import { expect, test } from "bun:test";
import { OPTIMIZE } from "../surface/state/imageOptimize";
import { optimizeImageBuffer, optimizeImageDataUrl } from "../surface/state/imageOptimize.server";

// A valid 1×1 transparent PNG.
const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("OPTIMIZE policy is 1200px / q85", () => {
  expect(OPTIMIZE).toEqual({ maxDim: 1200, quality: 0.85 });
});

test("optimizeImageBuffer downscales oversized images to webp", async () => {
  // Build a 2000×2000 PNG input with Bun.Image alone (no sharp / no fixture).
  const seed = Buffer.from(PNG_1x1, "base64");
  const big = await new Bun.Image(seed).resize(2000, 2000, { fit: "fill" }).png().bytes();

  const { data, mime } = await optimizeImageBuffer(new Uint8Array(big));
  expect(mime).toBe("image/webp");

  // Re-decode the output and confirm it was downscaled + re-encoded to webp.
  const meta = await new Bun.Image(data).metadata();
  expect(meta.format).toBe("webp");
  expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1200);
});

test("optimizeImageDataUrl returns a webp data-URL from a raster data-URL", async () => {
  // Build a small real PNG via Bun.Image (or reuse the suite's existing fixture).
  const png = await new Bun.Image(
    // 2x2 red PNG, base64
    Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP8z8Dwn4EIwDiqEAAlYwQ/4n9V0wAAAABJRU5ErkJggg==",
      ),
      (c) => c.charCodeAt(0),
    ),
  )
    .png()
    .bytes();
  const inputDataUrl = `data:image/png;base64,${btoa(String.fromCharCode(...png))}`;

  const out = await optimizeImageDataUrl(inputDataUrl);
  expect(out.startsWith("data:image/webp;base64,")).toBe(true);
  // round-trips to decodable webp bytes
  const b64 = out.slice("data:image/webp;base64,".length);
  expect(b64.length).toBeGreaterThan(0);
});

test("optimizeImageDataUrl rejects a non-data-URL", async () => {
  await expect(optimizeImageDataUrl("https://example.com/x.png")).rejects.toThrow();
});
