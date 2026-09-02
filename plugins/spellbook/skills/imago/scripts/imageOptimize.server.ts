// scripts/imageOptimize.server.ts
// Daemon-only: native Bun.Image downscale+webp. It lives in scripts/ because
// only the daemon executes it (R1's three-way sort — the `.server.ts` suffix
// already said so); the POLICY it applies is two-sided and lives in shared/.
// Do NOT import this from browser code (Bun.Image is a Bun runtime built-in,
// absent in the browser). Browser code imports OPTIMIZE from shared/imageOptimize.
import { OPTIMIZE } from "../shared/imageOptimize";

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
