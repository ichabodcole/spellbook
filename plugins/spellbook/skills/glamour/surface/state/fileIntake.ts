import { OPTIMIZE } from "./imageOptimize";
import type { ClientToServer } from "./types";

const IMG = /^image\//;
const TEXTY = /\.(md|markdown|mdx|txt|json|ya?ml)$/i;

async function downscaleToWebp(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, OPTIMIZE.maxDim / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
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

export async function processFiles(
  files: FileList | null,
  send: (m: ClientToServer) => void,
): Promise<void> {
  for (const f of Array.from(files ?? [])) {
    try {
      if (IMG.test(f.type)) {
        let src: string;
        try {
          src = await downscaleToWebp(f);
        } catch {
          src = await readAsDataUrl(f);
        }
        const isWebp = src.startsWith("data:image/webp");
        send({
          type: "item.add",
          item: {
            kind: "ref",
            title: f.name,
            src,
            mime: isWebp ? "image/webp" : f.type || "application/octet-stream",
          },
        });
      } else if (f.type.startsWith("text/") || TEXTY.test(f.name)) {
        send({
          type: "item.add",
          item: {
            kind: "context",
            title: f.name,
            text: await f.text(),
            mime: "text/markdown",
          },
        });
      }
    } catch (err) {
      console.error("glamour: failed to process file", f.name, err);
    }
  }
}
