// surface/state/fileIntake.ts
// Browser drop/file → daemon intake. The user drops the composite board image
// onto the surface; we read it as a base64 data-URL and hand it to the daemon
// over `source.import`. The daemon materializes the bytes onto the session files
// dir (full resolution — the AGENT reads + crops the source), derives Source
// { path, size, sha }, and emits `source.added` so the agent runs discover.
//
// NOTE: unlike the conversation image-attach path, we do NOT downscale here — the
// source must stay full-res so per-element crops are pixel-accurate.
import type { ClientToServer } from "./types";

const IMG = /^image\//;

// Read a File as a base64 data-URL (data:<mime>;base64,<payload>). The wire form
// the daemon's materializeSource decodes.
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(r.error ?? new Error("read failed"));
    r.readAsDataURL(file);
  });
}

// Import one dropped/picked composite: read it, send `source.import`. The shell's
// dropzone calls this; the daemon does the rest.
export async function importDroppedFile(
  file: File,
  send: (m: ClientToServer) => void,
): Promise<void> {
  if (!IMG.test(file.type)) return;
  const dataUrl = await fileToDataUrl(file);
  send({ type: "source.import", name: file.name, dataUrl });
}

// Convenience for the FileList drop targets (Conversation composer, dropzones):
// import the first image in the list (a board is a single composite).
export async function processFiles(
  files: FileList | null,
  send: (m: ClientToServer) => void,
): Promise<void> {
  for (const f of Array.from(files ?? [])) {
    if (!IMG.test(f.type)) continue;
    try {
      await importDroppedFile(f, send);
    } catch (err) {
      console.error("magpie: failed to import file", f.name, err);
    }
    return; // one composite per drop
  }
}
