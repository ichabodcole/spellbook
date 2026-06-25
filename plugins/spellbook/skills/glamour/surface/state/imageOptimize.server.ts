// Server/CLI-only: native Bun.Image downscale + webp. Do NOT import from browser
// code (the browser drop path uses <canvas>). Requires Bun >= 1.3.14.
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

// Decode a base64 data-URL, optimize the raster, re-encode as a webp data-URL.
// Used by the CLI `gen` verb (the agent posts a media-forge image with no
// browser <canvas> available). Throws on a non-base64-data-URL input.
export async function optimizeImageDataUrl(dataUrl: string): Promise<string> {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) throw new Error("optimizeImageDataUrl: expected a base64 data-URL");
  const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  const { data } = await optimizeImageBuffer(bytes);
  let bin = "";
  for (const b of data) bin += String.fromCharCode(b);
  return `data:image/webp;base64,${btoa(bin)}`;
}
