// surface/state/imageOptimize.server.ts
// Server/CLI-only image downscale+webp via Bun.Image (NOT sharp — house rule for
// magpie: Bun.Image handles resize/encode/metadata natively, no native module).
// Do NOT import this from browser code. Browser code imports OPTIMIZE from
// ./imageOptimize instead.
//
// NOTE: Bun.Image has resize/encode/metadata but NO crop/extract. The eventual
// per-element bbox crop is NOT done here — see backend.ts /
// discover.ts for the // TODO(mock/build) crop note.
import { OPTIMIZE } from "./imageOptimize";

export async function optimizeImageBuffer(
  input: Uint8Array,
): Promise<{ data: Uint8Array; mime: "image/webp" }> {
  const img = new Bun.Image(input);
  const meta = await img.metadata();
  const maxSide = Math.max(meta.width ?? 0, meta.height ?? 0);
  // Downscale only — never enlarge a small asset (Bun.Image resize has no
  // withoutEnlargement option, so we compute the target dims ourselves).
  const scale = maxSide > OPTIMIZE.maxDim ? OPTIMIZE.maxDim / maxSide : 1;
  const encoded =
    scale < 1
      ? img.resize(Math.round((meta.width ?? 0) * scale), Math.round((meta.height ?? 0) * scale))
      : img;
  const data = await encoded.webp({ quality: Math.round(OPTIMIZE.quality * 100) }).bytes();
  return { data, mime: "image/webp" };
}
