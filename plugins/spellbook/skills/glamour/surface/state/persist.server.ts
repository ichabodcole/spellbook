import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultState, type GlamourState, type LibraryItem } from "./types";

const EXT_BY_MIME: Record<string, string> = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
};

export function saveDataUrl(dir: string, id: string, dataUrl: string): string {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m || !dir) return "";
  const mime = (m[1] ?? "application/octet-stream").toLowerCase();
  const body = m[3];
  const buf = m[2] ? Buffer.from(body, "base64") : Buffer.from(decodeURIComponent(body), "utf8");
  const ext = EXT_BY_MIME[mime] ?? "bin";
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const path = join(dir, `${safeId}.${ext}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, buf);
    return path;
  } catch {
    return "";
  }
}

export function saveText(dir: string, id: string, name: string, text: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_") || `${id}.md`;
  const path = join(dir, `${id}-${safe}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, text, "utf8");
    return path;
  } catch {
    return "";
  }
}

export function materializeItem(filesDir: string, item: LibraryItem): void {
  if (item.src) {
    const p = saveDataUrl(filesDir, item.id, item.src);
    if (p) item.path = p;
  } else if (item.text) {
    const p = saveText(filesDir, item.id, item.title, item.text);
    if (p) item.path = p;
  }
}

export function saveSnapshot(snapshotsDir: string, sessionId: string, state: GlamourState): void {
  try {
    mkdirSync(snapshotsDir, { recursive: true });
    writeFileSync(join(snapshotsDir, `${sessionId}.json`), JSON.stringify(state));
  } catch {
    /* persistence is best-effort */
  }
}

export function loadSnapshot(path: string, title: string, intent: string): GlamourState {
  const snap = JSON.parse(readFileSync(path, "utf8")) as Partial<GlamourState>;
  // Merge over defaults so older snapshots gain new top-level fields.
  const merged = { ...defaultState(title, intent), ...snap } as GlamourState;
  // Normalize style-guide sections so snapshots predating newer per-section
  // fields (prompts, colors) still satisfy the current shape.
  merged.styleGuide = merged.styleGuide.map((s) => ({
    ...s,
    prompts: s.prompts ?? [],
    colors: s.colors ?? [],
  }));
  return merged;
}
