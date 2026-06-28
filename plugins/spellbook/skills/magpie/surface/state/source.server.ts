// surface/state/source.server.ts
// Server/CLI-only: materialize a user-dropped composite (a base64 data-URL the
// browser sent over `source.import`) onto the per-session files dir, then derive
// the canonical Source { path, size, sha }. `path` is the ABSOLUTE on-disk file
// (the agent reads + crops it); the surface renders it via /assets/<basename>.
// Do NOT import from browser code — uses node:fs + Bun.Image/CryptoHasher.

import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Source } from "./types";

// data:<mime>;base64,<payload> → raw bytes. Tolerates a missing prefix (treats
// the whole string as base64). Throws on an empty/undecodable payload.
function decodeDataUrl(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length === 0) throw new Error("empty image payload");
  return new Uint8Array(bytes);
}

// Reduce an arbitrary client-supplied filename to a safe basename: strip any
// directory components + traversal, keep a sane charset, fall back to source.png.
function sanitizeName(name: string): string {
  const base = basename(name || "").replace(/[^A-Za-z0-9._-]/g, "_");
  if (!base || base === "." || base === ".." || base.startsWith(".")) return "source.png";
  return base;
}

export async function materializeSource(
  filesDir: string,
  name: string,
  dataUrl: string,
): Promise<Source> {
  const bytes = decodeDataUrl(dataUrl);
  const safe = sanitizeName(name);
  const path = join(filesDir, safe);
  writeFileSync(path, bytes);

  const meta = await new Bun.Image(bytes).metadata();
  const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 16);
  return {
    path,
    size: [meta.width ?? 0, meta.height ?? 0],
    sha,
  };
}
