import { OPTIMIZE } from "../state/imageOptimize";
import type { ClientToServer } from "../state/types";

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

export function DropZone({ send }: { send: (m: ClientToServer) => void }) {
  async function handle(files: FileList | null) {
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
        } else if (
          f.type === "text/markdown" ||
          f.name.endsWith(".md") ||
          f.type.startsWith("text/")
        ) {
          send({
            type: "context.add",
            context: { text: await f.text(), name: f.name },
          });
        }
      } catch (err) {
        console.error("glamour: failed to process dropped file", f.name, err);
      }
    }
  }
  return (
    <label
      onDrop={(e) => {
        e.preventDefault();
        handle(e.dataTransfer.files).catch((err) => console.error(err));
      }}
      onDragOver={(e) => e.preventDefault()}
      className="block border border-dashed border-[#2e2640] rounded-xl p-6 text-center text-slate-400 cursor-pointer hover:border-violet-500/40"
    >
      drop images or context files, or click to pick
      <input
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          handle(e.target.files).catch((err) => console.error(err));
          e.currentTarget.value = "";
        }}
      />
    </label>
  );
}
