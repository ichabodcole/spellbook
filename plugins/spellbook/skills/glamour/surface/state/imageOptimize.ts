// surface/state/imageOptimize.ts
// Shared image-optimization policy: ≤1200px longest edge, webp. Used by the
// browser drop path (canvas) and the agent variant path (sharp, server/cli).
export const OPTIMIZE = { maxDim: 1200, quality: 0.85 } as const;

// Bun/Node path (sharp). The browser path stays canvas-based in DropZone.
export async function optimizeImageBuffer(
  input: Uint8Array,
): Promise<{ data: Uint8Array; mime: "image/webp" }> {
  const sharp = (await import("sharp")).default;
  const data = await sharp(input)
    .resize(OPTIMIZE.maxDim, OPTIMIZE.maxDim, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: Math.round(OPTIMIZE.quality * 100) })
    .toBuffer();
  return { data: new Uint8Array(data), mime: "image/webp" };
}
