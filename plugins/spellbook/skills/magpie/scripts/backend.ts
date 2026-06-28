// scripts/backend.ts
// Removal-backend registry. The rebuilt magpie compares background-removal
// results from multiple backends per element; the user picks the winner. This
// file defines the contract, the (live) rembg impl, a media-forge stub for the
// next sub-phase, and a registry.
//
// IMAGE OPS NOTE: cropping the element's bbox out of the source is NOT done with
// Bun.Image (it has resize/encode/metadata but NO crop/extract). rembgBackend
// shells out to scripts/remove.py (Pillow crop + rembg) — the caller owns the
// output path (the session files dir).

import { join } from "node:path";
// ── alpha policy ─────────────────────────────────────────────────────────────
// The type-driven alpha policy lives in surface/state/alpha.ts (browser-safe, so
// the surface shares one source of truth). Re-exported here for the agent-side
// consumers (cli.ts, backend tests) that import it from this module.
import type { AlphaPolicy } from "../surface/state/alpha";
import type { Bbox } from "../surface/state/types";

export {
  ALPHA_AUTO_TYPES,
  ALPHA_FORBIDDEN_TYPES,
  type AlphaPolicy,
  shouldRemove,
} from "../surface/state/alpha";

// A region of the source to cut a transparent asset from.
export type Crop = {
  // on-disk path to the source composite (or a pre-cropped region — see crop note)
  sourcePath: string;
  // the element's pixel bbox [x1, y1, x2, y2] within the source
  bbox: Bbox;
  // element type drives whether removal even makes sense (palettes/screenshots
  // get destroyed by rembg — see magpie's Alpha Policy)
  type: string;
};

// The result of a removal pass — a cutout PNG (with alpha) the surface displays.
export type Cutout = {
  id: string;
  backend: string; // which RemovalBackend produced it
  path: string; // on-disk PNG the agent reads / the surface serves
  // TODO(mock): width/height, a preview src, timing/cost, a quality signal
};

// Optional knobs threaded through to remove.py (the extract loop honors --alpha
// / --pad / --model from the CLI verb). All have sensible defaults inside
// remove.py. `model` names a specific rembg model for the model-agnostic retry
// (omit → rembg's default u2net).
export type CutOptions = { alpha?: AlphaPolicy; pad?: number; model?: string };

export interface RemovalBackend {
  name: string;
  // Cut the bbox region out of the source into `outPath` and return the cutout.
  // The caller owns `outPath` (the session files dir). `opts` carries the
  // alpha-policy / padding the CLI extract verb passes through.
  cut(crop: Crop, outPath: string, opts?: CutOptions): Promise<Cutout>;
}

// Resolve scripts/remove.py relative to this module (not cwd).
const REMOVE_PY = join(import.meta.dir, "remove.py");

function shortId(prefix: string): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  const hex = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${hex}`;
}

// rembg backend — shells out to scripts/remove.py (Pillow crop + rembg). The
// caller passes the output location; we parse remove.py's one JSON line and
// return the cutout.
export const rembgBackend: RemovalBackend = {
  name: "rembg",
  async cut(crop: Crop, outPath: string, opts: CutOptions = {}): Promise<Cutout> {
    const [x1, y1, x2, y2] = crop.bbox;
    const args = [
      "python3",
      REMOVE_PY,
      "--source",
      crop.sourcePath,
      "--bbox",
      `${x1},${y1},${x2},${y2}`,
      "--type",
      crop.type,
      "--out",
      outPath,
    ];
    if (opts.alpha) args.push("--alpha", opts.alpha);
    if (typeof opts.pad === "number") args.push("--pad", String(opts.pad));
    if (opts.model) args.push("--model", opts.model);

    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `rembg remove.py failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`,
      );
    }
    const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
    let parsed: { out?: string; removed?: boolean };
    try {
      parsed = JSON.parse(line) as { out?: string; removed?: boolean };
    } catch {
      throw new Error(`rembg remove.py produced no parseable JSON line: ${stdout.trim()}`);
    }
    return { id: shortId("cut"), backend: "rembg", path: parsed.out ?? outPath };
  },
};

// media-forge backend — cloud background removal via the media-forge CLI (the
// same out-of-band tool imago uses). `media-forge generate bg-remove` is a
// single-image transform (prompt-less): it takes ONE image and returns a
// transparent PNG. So `crop.sourcePath` here is the element's ALREADY-CROPPED
// image (the surface's crop version), NOT the full board — the caller passes it.
// `opts.model` is the media-forge model id (e.g. fal-ai/bria/background/remove).
// We parse the job's presigned output URL and stream it to outPath.
export const mediaForgeBackend: RemovalBackend = {
  name: "media-forge",
  async cut(crop: Crop, outPath: string, opts: CutOptions = {}): Promise<Cutout> {
    const model = opts.model;
    if (!model) throw new Error("mediaForgeBackend.cut requires opts.model (a bg-remove model id)");
    const args = [
      "media-forge",
      "generate",
      "bg-remove",
      `--model=${model}`,
      `--ref=${crop.sourcePath}`,
      "--format",
      "json",
    ];
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `media-forge bg-remove failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`,
      );
    }
    let parsed: { ok?: boolean; data?: { outputs?: Array<{ presignedUrl?: string }> } };
    try {
      parsed = JSON.parse(stdout.trim().split("\n").filter(Boolean).pop() ?? "");
    } catch {
      throw new Error(`media-forge produced no parseable JSON line: ${stdout.trim()}`);
    }
    const url = parsed?.data?.outputs?.[0]?.presignedUrl;
    if (!url) throw new Error(`media-forge returned no output url: ${stdout.trim()}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`media-forge output download failed (HTTP ${res.status})`);
    await Bun.write(outPath, res);
    return { id: shortId("cut"), backend: "media-forge", path: outPath };
  },
};

// Is this a media-forge model id (a provider path like "fal-ai/bria/background/
// remove") vs a bare rembg model name (e.g. "isnet-general-use")? We route by
// SHAPE, never a hardcoded model list — media-forge's catalog drifts, so the agent
// DISCOVERS bg-remove model ids via `media-forge models list` (operations
// ["bg-remove"]) and passes the id through. The magpie CLI abstracts the
// orchestration, not the model identity.
export function isMediaForgeModel(model: string): boolean {
  return model.includes("/");
}

// The registry the daemon/surface picks backends from.
export const REMOVAL_BACKENDS: Record<string, RemovalBackend> = {
  [rembgBackend.name]: rembgBackend,
  [mediaForgeBackend.name]: mediaForgeBackend,
};

export function getBackend(name: string): RemovalBackend | undefined {
  return REMOVAL_BACKENDS[name];
}
