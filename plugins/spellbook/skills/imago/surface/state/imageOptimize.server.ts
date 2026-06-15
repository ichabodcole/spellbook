// surface/state/imageOptimize.server.ts
// Server/CLI-only: sharp-based image downscale+webp. Do NOT import this from
// browser code (sharp is a native module). Browser code imports OPTIMIZE from
// ./imageOptimize instead.
import sharp from "sharp";
import { OPTIMIZE } from "./imageOptimize";

export async function optimizeImageBuffer(
  input: Uint8Array,
): Promise<{ data: Uint8Array; mime: "image/webp" }> {
  const data = await sharp(input)
    .resize(OPTIMIZE.maxDim, OPTIMIZE.maxDim, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: Math.round(OPTIMIZE.quality * 100) })
    .toBuffer();
  return { data: new Uint8Array(data), mime: "image/webp" };
}
