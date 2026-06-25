// Server/CLI-only: the project-scoped style store. Do NOT import from browser
// code (filesystem access). Styles live under ${home}/styles/${projectKey}/,
// keyed to the checkout where the spell was cast.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CanonImg, CanonicalRef, LibraryItem, SavedStyle, StyleSection } from "./types";

const EXT_BY_MIME: Record<string, string> = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
};

// A stable, filesystem-safe key: sanitized base name + a short hash of the full
// absolute path (so two checkouts with the same folder name don't collide).
export function projectKey(projectDir: string): string {
  const base = basename(projectDir).replace(/[^a-zA-Z0-9_-]/g, "_") || "root";
  let h = 5381;
  for (let i = 0; i < projectDir.length; i++) h = ((h << 5) + h + projectDir.charCodeAt(i)) >>> 0;
  return `${base}-${h.toString(36)}`;
}

export function stylesDir(home: string, key: string): string {
  return join(home, "styles", key);
}

export function saveStyle(
  home: string,
  key: string,
  args: {
    id: string;
    label: string;
    text: string;
    sections: StyleSection[];
    canonicalItems: LibraryItem[];
    createdAt: number;
  },
): SavedStyle {
  const dir = stylesDir(home, key);
  mkdirSync(dir, { recursive: true });
  const canonical: CanonicalRef[] = [];
  for (const it of args.canonicalItems) {
    if (!it.path || !existsSync(it.path)) continue;
    const ext = EXT_BY_MIME[it.mime] ?? "bin";
    const file = `${args.id}-${it.id}.${ext}`;
    try {
      writeFileSync(join(dir, file), readFileSync(it.path));
      canonical.push({ id: it.id, title: it.title, file, mime: it.mime });
    } catch {
      /* skip an unreadable blob */
    }
  }
  const style: SavedStyle = {
    id: args.id,
    label: args.label,
    text: args.text,
    sections: args.sections,
    canonical,
    createdAt: args.createdAt,
    archived: false,
  };
  writeFileSync(join(dir, `${args.id}.json`), JSON.stringify(style));
  return style;
}

export function loadTray(home: string, key: string): SavedStyle[] {
  const dir = stylesDir(home, key);
  if (!existsSync(dir)) return [];
  const out: SavedStyle[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as SavedStyle);
    } catch {
      /* skip a corrupt record */
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

export function setStyleArchived(
  home: string,
  key: string,
  id: string,
  archived: boolean,
): boolean {
  const path = join(stylesDir(home, key), `${id}.json`);
  if (!existsSync(path)) return false;
  try {
    const style = JSON.parse(readFileSync(path, "utf8")) as SavedStyle;
    style.archived = archived;
    writeFileSync(path, JSON.stringify(style));
    return true;
  } catch {
    return false;
  }
}

export function materializeCanon(home: string, key: string, style: SavedStyle): CanonImg[] {
  const dir = stylesDir(home, key);
  const out: CanonImg[] = [];
  for (const ref of style.canonical) {
    try {
      const bytes = readFileSync(join(dir, ref.file));
      out.push({
        title: ref.title,
        src: `data:${ref.mime};base64,${bytes.toString("base64")}`,
      });
    } catch {
      /* skip a missing blob */
    }
  }
  return out;
}
