// surface/state/fileIntake.ts
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

// Drag/drop/pick intake: images → influence.add (downscaled webp, raw fallback),
// text/markdown → context.add. Best-effort per file.
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
        send({ type: "influence.add", influence: { src, name: f.name } });
      } else if (f.type.startsWith("text/") || TEXTY.test(f.name)) {
        send({
          type: "context.add",
          context: { text: await f.text(), name: f.name },
        });
      }
    } catch (err) {
      console.error("glamour: failed to process file", f.name, err);
    }
  }
}
