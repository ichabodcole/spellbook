// surface/state/fileIntake.ts
import { OPTIMIZE } from "./imageOptimize";
import type { ClientToServer } from "./types";

const IMG = /^image\//;

// Custom drag MIME for dragging a sidebar image INTERNALLY onto the canvas. An
// internal drag carries no dataTransfer.files (unlike an OS file drop), so the
// drag stashes the image's src here and the canvas drop reads it. Payload is
// JSON { src, name }.
export const IMAGO_IMAGE_DND = "application/x-imago-image";

// Custom drag MIME for dragging a context-library entry (style/prompt) from
// ContextLibrary into the Active-context tray in ReferenceDrawer. Payload is
// JSON { id }.
export const IMAGO_CONTEXT_DND = "application/x-imago-context";
export function readContextDrag(dt: DataTransfer): { id: string } | null {
  const raw = dt.getData(IMAGO_CONTEXT_DND);
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    if (typeof o?.id !== "string") return null;
    return { id: o.id };
  } catch {
    return null;
  }
}

export function readImagoDrag(
  dt: DataTransfer,
): { src: string; name: string; variantId?: string } | null {
  const raw = dt.getData(IMAGO_IMAGE_DND);
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    if (typeof o?.src !== "string") return null;
    // variantId is present when dragging an EXISTING library image (sidebar) —
    // lets a drop ref-select that variant instead of re-importing a duplicate.
    return {
      src: o.src,
      name: String(o.name ?? "image"),
      variantId: typeof o.variantId === "string" ? o.variantId : undefined,
    };
  } catch {
    return null;
  }
}

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
      send({ type: "ref.add", image: { src, name: f.name } });
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

// A centered ~40% fraction-space box for an image of `imgW`×`imgH` placed onto a
// base image of `baseW`×`baseH` (both natural px). The layer renders with
// preserveAspectRatio="none", so the box MUST match the image's aspect or it'd
// stretch — we contain-fit the image into a 40%×40% region of the base box (which
// preserves aspect in the base box's own pixel space) and center it. Fractions are
// of the base box, which is exactly what ImageLayer x/y/w/h mean.
export function centeredLayerBox(
  imgW: number,
  imgH: number,
  baseW: number,
  baseH: number,
): { x: number; y: number; w: number; h: number } {
  const scale = Math.min((0.4 * baseW) / imgW, (0.4 * baseH) / imgH);
  const w = (imgW * scale) / baseW;
  const h = (imgH * scale) / baseH;
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

// The pixel size of an image src (data-url or path) via createImageBitmap.
async function imageSize(src: string): Promise<{ w: number; h: number }> {
  const bmp = await createImageBitmap(await (await fetch(src)).blob());
  return { w: bmp.width, h: bmp.height };
}

// Intake for IMAGE LAYERS: images dropped ON the focused image → layer.addImage
// (collage — composites onto the focused image, distinct from image.import which
// REPLACES). baseW/baseH are the focused image's natural px (Canvas has them), so
// we compute an aspect-correct centered box client-side.
export async function addImageLayerFiles(
  files: FileList | null,
  send: (m: ClientToServer) => void,
  baseW: number,
  baseH: number,
): Promise<void> {
  for (const f of Array.from(files ?? [])) {
    if (!IMG.test(f.type)) continue;
    try {
      const src = await toWebpSrc(f);
      const box =
        baseW > 0 && baseH > 0
          ? await imageSize(src)
              .then((s) => centeredLayerBox(s.w, s.h, baseW, baseH))
              .catch(() => ({}))
          : {};
      send({ type: "layer.addImage", src, name: f.name, ...box });
    } catch (err) {
      console.error("imago: failed to add image layer", f.name, err);
    }
  }
}

// "Add as a layer" from an EXISTING image (a reference thumb or a generation) onto
// the focused image. We have neither the base nor the source pixel dims here, so we
// measure both srcs to compute an aspect-correct centered box (falls back to the
// server's default-centered box if either measure fails).
export async function addImageLayerFromSrc(
  src: string,
  name: string,
  baseSrc: string,
  send: (m: ClientToServer) => void,
): Promise<void> {
  let box: { x: number; y: number; w: number; h: number } | Record<string, never> = {};
  try {
    const [img, base] = await Promise.all([imageSize(src), imageSize(baseSrc)]);
    box = centeredLayerBox(img.w, img.h, base.w, base.h);
  } catch {
    // leave box empty → the server centers a default 40% box
  }
  send({ type: "layer.addImage", src, name, ...box });
}
