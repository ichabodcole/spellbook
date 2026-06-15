// surface/state/fileIntake.ts
import { OPTIMIZE } from "./imageOptimize";
import type { ClientToServer } from "./types";

const IMG = /^image\//;

async function downscaleToWebp(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, OPTIMIZE.maxDim / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  const ctx2d = c.getContext("2d");
  if (!ctx2d) throw new Error("no 2d context");
  ctx2d.drawImage(bmp, 0, 0, c.width, c.height);
  const url = c.toDataURL("image/webp", OPTIMIZE.quality);
  if (!url.startsWith("data:image/webp")) throw new Error("no webp");
  return url;
}
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

// Downscale an image File to a webp data URL, falling back to the raw data URL.
async function toWebpSrc(f: File): Promise<string> {
  try {
    return await downscaleToWebp(f);
  } catch {
    return await readAsDataUrl(f);
  }
}

// Drag/drop/pick intake for REFERENCES: images → ref.add (a reference staged for
// the next generation), downscaled to webp with a raw fallback. Non-images are
// ignored. The drop target (drawer/composer) is what makes these references.
export async function processFiles(
  files: FileList | null,
  send: (m: ClientToServer) => void,
): Promise<void> {
  for (const f of Array.from(files ?? [])) {
    if (!IMG.test(f.type)) continue;
    try {
      const src = await toWebpSrc(f);
      send({ type: "ref.add", reference: { src, name: f.name } });
    } catch (err) {
      console.error("imago: failed to process file", f.name, err);
    }
  }
}

// Intake for WORKING IMAGES: images dropped on the canvas → image.import (the
// server makes a one-variant "import" batch and focuses it). Same downscale path
// as processFiles; the drop target (canvas, not the drawer) is what makes these
// durable working images instead of references.
export async function importFiles(
  files: FileList | null,
  send: (m: ClientToServer) => void,
): Promise<void> {
  for (const f of Array.from(files ?? [])) {
    if (!IMG.test(f.type)) continue;
    try {
      const src = await toWebpSrc(f);
      send({ type: "image.import", image: { src, name: f.name } });
    } catch (err) {
      console.error("imago: failed to import file", f.name, err);
    }
  }
}
