// surface/state/imageOptimize.server.ts
// Server/CLI-only: native Bun.Image downscale+webp. Do NOT import this from
// browser code (Bun.Image is a Bun runtime built-in, absent in the browser).
// Browser code imports OPTIMIZE from ./imageOptimize instead.
import { OPTIMIZE } from "./imageOptimize";

export async function optimizeImageBuffer(
  input: Uint8Array,
): Promise<{ data: Uint8Array; mime: "image/webp" }> {
  const data = await new Bun.Image(input)
    .resize(OPTIMIZE.maxDim, OPTIMIZE.maxDim, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: Math.round(OPTIMIZE.quality * 100) })
    .bytes();
  return { data: new Uint8Array(data), mime: "image/webp" };
}
