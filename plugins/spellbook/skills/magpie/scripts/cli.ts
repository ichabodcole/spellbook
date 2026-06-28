#!/usr/bin/env bun

// magpie CLI — thin, stateless wrapper around the per-session daemon's HTTP
// surface (server.ts). One HTTP round-trip per verb. `tail` streams SSE user
// events as JSONL for Monitor to wrap (a `grounding` anchor line first).
//
// Lifecycle:
//   bun cli.ts open [--title ..] [--intent ..] [--restore <id>] [--timeout S] [--no-open]
//   bun cli.ts tail [--since N]            # SSE user events → JSONL (Monitor this)
//   bun cli.ts state [--full|--lean]       # lean state snapshot (default lean)
//
// Driving the surface (POST /cmd):
//   bun cli.ts say [text...] [--stdin]                 # post agent dialogue (text or piped stdin)
//   bun cli.ts ask <text...> [--options "a|b|c"]       # ask the user (in-thread)
//   bun cli.ts status on [text...] | status off        # the working spinner
//   bun cli.ts source <imagePath>                      # set the composite under review (computes sha + size)
//   bun cli.ts cmd [--stdin]                            # POST a raw AgentCommand JSON body (from stdin)
//   bun cli.ts close | info | sessions | help
//
// `--stdin` reads the body from stdin so natural-language text is never inlined
// into a shell-parsed arg. Payload on stdout, liveness/echo on stderr.
//
// All verbs target the most recent session by default; pass --session <id>.

import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newId } from "../surface/state/reduce";
import type { Element } from "../surface/state/types";
import { chosenVersion } from "../surface/state/versions";
import {
  type AlphaPolicy,
  isMediaForgeModel,
  mediaForgeBackend,
  rembgBackend,
  shouldRemove,
} from "./backend";
import { DiscoverError, discover } from "./discover";

// Swallow EPIPE (a downstream `head`/Monitor closing our stdout shouldn't crash).
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
});

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = join(SCRIPT_DIR, "server.ts");

type Session = {
  url: string;
  port: number;
  session_id: string;
  title: string;
  files_dir?: string;
};

function die(msg: string): never {
  process.stderr.write(`magpie: ${msg}\n`);
  process.exit(2);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function printJson(data: unknown) {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}

function sessionFilePath(session?: string): string {
  return session ? join(tmpdir(), `magpie-${session}.json`) : join(tmpdir(), "magpie-latest.json");
}

function readSession(session?: string): Session | null {
  try {
    return JSON.parse(readFileSync(sessionFilePath(session), "utf8")) as Session;
  } catch {
    return null;
  }
}

function requireSession(session?: string): Session {
  const s = readSession(session);
  if (!s) die("no running magpie session — run: cli.ts open");
  return s;
}

async function api(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}

// Split argv into positionals + flags. `--flag value`, `--flag=value`, or boolean.
export function parseArgs(args: string[]): {
  pos: string[];
  flags: Record<string, string | boolean>;
} {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const body = a.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

// Read all of stdin as text (Bun.stdin). Used by `--stdin` so NL text isn't a
// shell-parsed arg.
async function readStdin(): Promise<string> {
  return (await Bun.stdin.text()).trim();
}

async function postCmd(session: string | undefined, msg: Record<string, unknown>) {
  const s = requireSession(session);
  const { status } = await api(s.port, "POST", "/cmd", msg);
  if (status !== 200) die(`cmd failed (HTTP ${status}) — is the session still alive?`);
  printJson({ ok: true, sent: msg.type });
}

// ── verbs ───────────────────────────────────────────────────────────

async function cmdOpen(flags: Record<string, string | boolean>) {
  const args = ["run", SERVER_SCRIPT];
  if (flags.title) args.push("--title", String(flags.title));
  if (flags.intent) args.push("--intent", String(flags.intent));
  if (flags.timeout) args.push("--timeout", String(flags.timeout));
  if (flags.restore) args.push("--restore", String(flags.restore));
  if (flags["no-open"]) args.push("--no-open");

  const prevId = readSession()?.session_id;
  // Detached node:child_process (not Bun.spawn) so the daemon SURVIVES this CLI
  // process exiting — the house pattern for a standing daemon. cwd pinned to the
  // skill root so Bun finds bunfig.toml (registers bun-plugin-tailwind).
  const proc = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: process.env,
    cwd: join(SCRIPT_DIR, ".."),
  });
  proc.unref();

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await sleep(80);
    const s = readSession();
    if (s && s.session_id !== prevId) {
      try {
        const r = await fetch(`http://127.0.0.1:${s.port}/state`);
        if (r.ok) {
          printJson(s);
          return;
        }
      } catch {
        /* not up yet */
      }
    }
  }
  die("magpie server failed to start within 5s");
}

async function cmdState(session?: string, full = false) {
  const s = requireSession(session);
  const { status, data } = await api(s.port, "GET", `/state${full ? "" : "?lean=1"}`);
  if (status !== 200) die(`state failed (HTTP ${status})`);
  printJson(data);
}

async function cmdTail(session: string | undefined, sinceArg: number) {
  let since = sinceArg;
  let delay = 250;
  let stopped = false;
  let boundId = session;
  let grounded = false;
  const stop = () => {
    stopped = true;
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopped) {
    const s = readSession(boundId);
    if (!s) {
      if (grounded) process.exit(0); // our pinned session went away → done
      process.stderr.write("# no session yet, retrying…\n");
      await sleep(delay);
      delay = Math.min(delay * 2, 5000);
      continue;
    }
    if (!boundId) boundId = s.session_id; // pin to the first session we resolved
    if (!grounded) {
      grounded = true;
      // grounding anchor — parseable + visible in a Monitor; names the binding.
      process.stdout.write(
        `${JSON.stringify({ type: "grounding", session_id: s.session_id, port: s.port })}\n`,
      );
    }
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${s.port}/events?since=${since}`);
    } catch {
      await sleep(delay);
      delay = Math.min(delay * 2, 5000);
      continue;
    }
    if (!res.ok || !res.body) {
      await sleep(delay);
      delay = Math.min(delay * 2, 5000);
      continue;
    }
    delay = 250;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        break;
      }
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      for (let sep = buf.indexOf("\n\n"); sep >= 0; sep = buf.indexOf("\n\n")) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const dataLines: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) {
            process.stderr.write(": magpie-keepalive\n");
            continue;
          }
          if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) continue;
        const payload = dataLines.join("\n");
        try {
          const ev = JSON.parse(payload) as { id?: number; type?: string };
          if (typeof ev.id === "number" && ev.id > since) since = ev.id;
          process.stdout.write(`${payload}\n`);
          if (ev.type === "closed") process.exit(0);
        } catch {
          /* skip malformed frame */
        }
      }
    }
    await sleep(delay);
  }
}

function cmdInfo(session?: string) {
  const s = readSession(session);
  if (!s) die("no running magpie session");
  printJson(s);
}

function cmdSessions() {
  // Mirror persist.server's snapshot dir resolution (avoid importing node:fs path
  // logic twice): $MAGPIE_HOME/snapshots or ~/.magpie/snapshots.
  const home = process.env.MAGPIE_HOME ?? join(process.env.HOME ?? "", ".magpie");
  const dir = join(home, "snapshots");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    process.stdout.write("no saved sessions\n");
    return;
  }
  type Row = { id: string; title: string; elements: number; mtime: number };
  const rows: Row[] = [];
  for (const f of files) {
    const path = join(dir, f);
    try {
      const st = JSON.parse(readFileSync(path, "utf8"));
      rows.push({
        id: f.replace(/\.json$/, ""),
        title: st.title,
        elements: Array.isArray(st.elements) ? st.elements.length : 0,
        mtime: statSync(path).mtimeMs,
      });
    } catch {
      /* skip unreadable snapshot */
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  for (const r of rows) {
    process.stdout.write(`${r.id}  ${r.elements} elements  — ${r.title}\n`);
  }
  if (!rows.length) process.stdout.write("no saved sessions\n");
}

// `source <imagePath>` — compute sha256[:16] + pixel size (Bun.Image) and post
// source.set. The agent runs discover separately; this just registers the board.
async function cmdSource(session: string | undefined, imagePath: string) {
  const file = Bun.file(imagePath);
  if (!(await file.exists())) die(`image not found: ${imagePath}`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 16);
  const meta = await new Bun.Image(bytes).metadata();
  await postCmd(session, {
    type: "source.set",
    path: imagePath,
    size: [meta.width ?? 0, meta.height ?? 0],
    sha,
  });
}

// `element-add --bbox "x1,y1,x2,y2" [--name ..] [--type ..]` — agent boxes a
// region incrementally (source pixels). Mirrors the user's "mark a missed region".
async function cmdElementAdd(session: string | undefined, flags: Record<string, string | boolean>) {
  const raw = typeof flags.bbox === "string" ? flags.bbox : "";
  const parts = raw.split(",").map((n) => parseInt(n.trim(), 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    die('usage: element-add --bbox "x1,y1,x2,y2" [--name <name>] [--type <type>]');
  }
  const element: Record<string, unknown> = { bbox: parts };
  if (typeof flags.name === "string") element.name = flags.name;
  if (typeof flags.type === "string") element.type = flags.type;
  await postCmd(session, { type: "element.add", element });
}

// `discover` — read /state for source.path, run discover.ts on it, build the
// Element[] (status "proposed", bbox from the manifest's bbox_pixel), and POST
// elements.set. The whole discover→breakdown loop in one shot (for the agent or a
// tester). Requires OPENROUTER_API_KEY in the environment.
async function cmdDiscover(session?: string) {
  const s = requireSession(session);
  const { status, data } = await api(s.port, "GET", "/state");
  if (status !== 200) die(`state failed (HTTP ${status})`);
  const src = (data as { state?: { source?: { path?: string } } }).state?.source;
  const path = src?.path;
  if (!path) die("no source set — drop a composite (or run: source <imagePath>) first");
  let manifest: Awaited<ReturnType<typeof discover>>;
  try {
    manifest = await discover(path);
  } catch (e) {
    if (e instanceof DiscoverError) die(`discover failed: ${e.message}`);
    throw e;
  }
  const elements: Element[] = manifest.elements.map((e) => ({
    id: newId("e"),
    name: e.name,
    type: e.type,
    bbox: e.bbox_pixel,
    status: "proposed",
  }));
  const cost = manifest.cost_usd ? ` — $${manifest.cost_usd.toFixed(4)}` : "";
  process.stderr.write(`magpie: discovered ${elements.length} element(s) on ${path}${cost}\n`);
  await postCmd(session, { type: "elements.set", elements });
}

// Mirror remove.py's safe_filename so the cutout filename is stable + traversal-
// safe (the surface serves it via /assets/<basename>).
function sanitize(name: string): string {
  const cleaned = Array.from(name || "")
    .map((c) => (/[A-Za-z0-9\-_.]/.test(c) ? c : "_"))
    .join("")
    .replace(/^\.+/, ""); // no hidden dotfiles
  return cleaned || "element";
}

// The on-disk filename for a version: each MODEL gets its own file so versions
// don't overwrite each other and don't collide in the browser cache (two versions
// at the same URL would show a stale image). The raw crop keeps the bare
// `<name>.png`; every removal model is suffixed `<name>.<model>.png`.
export function cutoutFilename(name: string, backend: string): string {
  return `${sanitize(name)}${backend === "crop" ? "" : `.${backend}`}.png`;
}

// `extract [--ids a,b] [--remove] [--alpha auto|all|none] [--pad N]` — cut a
// slice for every non-dropped element (or just `--ids`, on re-cut). DEFAULT is
// CROP-ONLY (a raw Pillow slice, no background removal → backend label "crop").
// `--remove` switches on rembg background removal (--alpha auto → backend
// "rembg") for the next phase; an explicit `--alpha` overrides the policy.
// Reads /state for source.path + elements, cuts each via rembgBackend (→
// remove.py), and posts the result back with element.addVersion. Sets the busy
// spinner around the loop; per-element progress → stderr, summary → stdout.
async function cmdExtract(session: string | undefined, flags: Record<string, string | boolean>) {
  const s = requireSession(session);
  if (!s.files_dir) die("session has no files_dir — cannot materialize cutouts");

  // Policy: crop-only by default; --remove flips to rembg (auto); --alpha wins.
  let alpha: AlphaPolicy = flags.remove === true ? "auto" : "none";
  if (typeof flags.alpha === "string") {
    if (!["auto", "all", "none"].includes(flags.alpha)) {
      die(`--alpha must be auto|all|none (got ${flags.alpha})`);
    }
    alpha = flags.alpha as AlphaPolicy;
  }
  // The version label = the removal MODEL: "crop" (no removal), "rembg" (rembg's
  // default u2net), or a specific rembg model name on a retry (--model, e.g.
  // isnet-general-use). Each label → its own file (cutoutFilename) so versions
  // coexist + don't cache-collide; addVersion upserts by this label.
  const reqModel = typeof flags.model === "string" ? flags.model : undefined;
  // Route by id SHAPE, never a hardcoded model list: a media-forge id is a
  // provider path (has "/"); a bare name is a rembg model. The agent discovers
  // media-forge bg-remove ids via `media-forge models list` and passes one here.
  const useMediaForge = reqModel ? isMediaForgeModel(reqModel) : false;
  const rembgModel = reqModel && !useMediaForge ? reqModel : undefined;
  // The version label (its strip row + filename). Friendly: explicit --label wins;
  // else for a media-forge path id use the segment after the vendor; else the
  // model name. crop-only has no model.
  const explicitLabel = typeof flags.label === "string" ? flags.label : undefined;
  const label =
    alpha === "none"
      ? "crop"
      : (explicitLabel ??
        (useMediaForge ? ((reqModel as string).split("/")[1] ?? "cloud") : (reqModel ?? "rembg")));
  // Default pad = 0: the slice must match the box the user drew (WYSIWYG). The box
  // IS the padding control — drag a handle out for breathing room. (remove.py's own
  // default is 8, so we MUST pass an explicit 0, not undefined.) --pad overrides.
  const pad = typeof flags.pad === "string" ? parseInt(flags.pad, 10) : 0;
  if (Number.isNaN(pad)) die("--pad must be a number");
  const idFilter =
    typeof flags.ids === "string"
      ? new Set(
          flags.ids
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
        )
      : undefined;

  const { status, data } = await api(s.port, "GET", "/state");
  if (status !== 200) die(`state failed (HTTP ${status})`);
  const st = (data as { state?: { source?: { path?: string }; elements?: Element[] } }).state;
  const sourcePath = st?.source?.path;
  if (!sourcePath) die("no source set — drop a composite (or run: source <imagePath>) first");
  let elements = (st?.elements ?? []).filter((e) => e.status !== "dropped");
  if (idFilter) elements = elements.filter((e) => idFilter.has(e.id));
  // When REMOVING, never touch alpha-forbidden types (palette / screenshot /
  // typography) — they stay whole by policy. Skip them so we don't write a
  // mislabeled, redundant "removal" version that's really just the crop.
  let keptWhole = 0;
  if (alpha !== "none") {
    const before = elements.length;
    elements = elements.filter((e) => shouldRemove(e.type, alpha));
    keptWhole = before - elements.length;
  }
  if (!elements.length) {
    die(
      keptWhole > 0
        ? `nothing to remove — ${keptWhole} selected element${keptWhole === 1 ? " is a" : "s are"} kept-whole type${keptWhole === 1 ? "" : "s"} (palette/screenshot/typography)`
        : idFilter
          ? "no matching extractable elements for --ids"
          : "no extractable elements (all dropped or none discovered)",
    );
  }

  await api(s.port, "POST", "/cmd", { type: "status", busy: true, text: "extracting…" });
  let done = 0;
  let failed = 0;
  try {
    for (const el of elements) {
      const outPath = join(s.files_dir, cutoutFilename(el.name, label));
      try {
        // Cloud (media-forge) runs on the element's existing crop image (single-
        // image transform); rembg crops the bbox from the source itself.
        const cutout = useMediaForge
          ? await mediaForgeBackend.cut(
              {
                sourcePath: join(s.files_dir, cutoutFilename(el.name, "crop")),
                bbox: el.bbox,
                type: el.type,
              },
              outPath,
              { model: reqModel },
            )
          : await rembgBackend.cut({ sourcePath, bbox: el.bbox, type: el.type }, outPath, {
              alpha,
              pad,
              model: rembgModel,
            });
        await api(s.port, "POST", "/cmd", {
          type: "element.addVersion",
          id: el.id,
          // addVersion upserts by model (bumps rev → cache-bust) and clears the
          // flag; crop = raw, rembg model = local, media-forge = cloud.
          version: {
            id: newId("v"),
            model: label, // "crop" | "rembg" | <rembg model> | <media-forge label>
            kind: label === "crop" ? "raw" : useMediaForge ? "cloud" : "local",
            path: cutout.path,
            rev: 0,
          },
          choose: true,
        });
        done++;
        process.stderr.write(`magpie: cut ${el.name} (${el.type}, ${label}) → ${cutout.path}\n`);
      } catch (e) {
        failed++;
        process.stderr.write(
          `magpie: cut FAILED for ${el.name}: ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    }
  } finally {
    await api(s.port, "POST", "/cmd", { type: "status", busy: false });
  }
  printJson({ ok: true, cut: done, failed, total: elements.length, keptWhole, model: label });
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );
}

type ManifestAsset = {
  name: string;
  type: string;
  model: string;
  kind: string | null;
  bbox: number[];
  file: string;
  crop: string | null;
};

// A self-contained contact sheet (magpie cream identity) — open in a browser, no
// deps. Backdrop toggle (checker/white/gray/black) to judge transparency, and
// type filters built from the taxonomy we tagged during the run. `a.file` is the
// in-zip path (assets/<name>.png).
function buildGalleryHtml(title: string, assets: ManifestAsset[]): string {
  const types = [...new Set(assets.map((a) => a.type))].sort();
  const typeChips = ["all", ...types]
    .map((t) => {
      const n = t === "all" ? assets.length : assets.filter((a) => a.type === t).length;
      return `<button class="chip${t === "all" ? " active" : ""}" data-filter="${escapeHtml(t)}">${escapeHtml(t)} <span class="n">${n}</span></button>`;
    })
    .join("");
  const cards = assets
    .map(
      (a) => `      <figure class="card" data-type="${escapeHtml(a.type)}">
        <div class="thumb"><img src="${escapeHtml(a.file)}" alt="${escapeHtml(a.name)}"></div>
        <figcaption>
          <span class="name">${escapeHtml(a.name)}</span>
          <span class="meta">${escapeHtml(a.type)} · ${escapeHtml(a.model)}${a.kind ? ` (${escapeHtml(a.kind)})` : ""}</span>
        </figcaption>
      </figure>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(title)} — magpie assets</title>
<style>
  :root { --cream:#f6f1e7; --ink:#14181b; --line:#e2d9c6; --indigo:#5b5bf0; }
  body { font-family:-apple-system,system-ui,sans-serif; background:var(--cream); color:var(--ink); margin:0; padding:28px; }
  h1 { font-size:20px; font-weight:700; margin:0; } .count { color:#9a8f78; font-weight:400; }
  .toolbar { display:flex; gap:18px; align-items:center; flex-wrap:wrap; margin:16px 0 4px; }
  .group { display:flex; gap:6px; align-items:center; }
  .label { font-size:11px; color:#9a8f78; text-transform:uppercase; letter-spacing:.04em; }
  /* backdrop = color swatches (not words); transparent = a mini checker square */
  .sw { width:22px; height:22px; padding:0; border:1px solid var(--line); border-radius:5px; cursor:pointer; box-sizing:border-box; }
  .sw.active { outline:2px solid var(--indigo); outline-offset:1px; }
  .sw.checker { background-color:#fff;
    background-image:linear-gradient(45deg,#c9c9c9 25%,transparent 25%),linear-gradient(-45deg,#c9c9c9 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#c9c9c9 75%),linear-gradient(-45deg,transparent 75%,#c9c9c9 75%);
    background-size:8px 8px; background-position:0 0,0 4px,4px -4px,-4px 0; }
  /* size = a small S/M/L segmented control */
  .seg { font:inherit; font-size:12px; padding:4px 9px; border:1px solid var(--line); background:#fffdf8; color:var(--ink); cursor:pointer; }
  .seg:first-child { border-radius:6px 0 0 6px; } .seg:last-child { border-radius:0 6px 6px 0; } .seg+.seg { border-left:none; }
  .seg.active { background:var(--indigo); color:#fff; border-color:var(--indigo); }
  .chip { font:inherit; font-size:12px; padding:4px 10px; border:1px solid var(--line); border-radius:999px; background:#fffdf8; color:var(--ink); cursor:pointer; }
  .chip.active { background:var(--indigo); color:#fff; border-color:var(--indigo); }
  .chip .n { opacity:.6; margin-left:2px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(170px,1fr)); gap:10px; margin-top:16px; }
  body[data-size="sm"] .grid { grid-template-columns:repeat(auto-fill,minmax(132px,1fr)); }
  body[data-size="lg"] .grid { grid-template-columns:repeat(auto-fill,minmax(264px,1fr)); gap:14px; }
  .card { background:#fffdf8; border:1px solid var(--line); border-radius:10px; overflow:hidden; min-width:0; }
  .thumb { height:160px; display:flex; align-items:center; justify-content:center; background-color:#fff;
    background-image:linear-gradient(45deg,#e7e0d2 25%,transparent 25%),linear-gradient(-45deg,#e7e0d2 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#e7e0d2 75%),linear-gradient(-45deg,transparent 75%,#e7e0d2 75%);
    background-size:16px 16px; background-position:0 0,0 8px,8px -8px,-8px 0; }
  body[data-size="sm"] .thumb { height:112px; } body[data-size="lg"] .thumb { height:240px; }
  body[data-bg="white"] .thumb { background:#fff!important; background-image:none!important; }
  body[data-bg="gray"] .thumb { background:#8a8a8a!important; background-image:none!important; }
  body[data-bg="black"] .thumb { background:#111!important; background-image:none!important; }
  .thumb img { max-width:88%; max-height:88%; object-fit:contain; }
  figcaption { padding:7px 9px; display:flex; flex-direction:column; gap:1px; min-width:0; }
  .name, .meta { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .name { font-size:12.5px; font-weight:600; } .meta { font-size:11px; color:#6f6c66; }
</style></head><body data-bg="checker" data-size="md">
  <h1>🐦 ${escapeHtml(title)} <span class="count">— ${assets.length} asset${assets.length === 1 ? "" : "s"}</span></h1>
  <div class="toolbar">
    <div class="group"><span class="label">Backdrop</span>
      <button class="sw checker active" data-bg-btn="checker" title="Transparent"></button>
      <button class="sw" data-bg-btn="white" style="background:#ffffff" title="White"></button>
      <button class="sw" data-bg-btn="gray" style="background:#8a8a8a" title="Gray"></button>
      <button class="sw" data-bg-btn="black" style="background:#111111" title="Black"></button>
    </div>
    <div class="group"><span class="label">Size</span>
      <button class="seg" data-size-btn="sm" title="Small">S</button>
      <button class="seg active" data-size-btn="md" title="Medium">M</button>
      <button class="seg" data-size-btn="lg" title="Large">L</button>
    </div>
    <div class="group"><span class="label">Type</span>${typeChips}</div>
  </div>
  <div class="grid">
${cards}
  </div>
  <script>
    var body=document.body;
    function wire(sel, apply){ document.querySelectorAll(sel).forEach(function(b){ b.addEventListener('click', function(){
      apply(b);
      document.querySelectorAll(sel).forEach(function(x){ x.classList.toggle('active', x===b); });
    }); }); }
    wire('[data-bg-btn]', function(b){ body.dataset.bg=b.dataset.bgBtn; });
    wire('[data-size-btn]', function(b){ body.dataset.size=b.dataset.sizeBtn; });
    var cards=[].slice.call(document.querySelectorAll('.card'));
    wire('[data-filter]', function(b){ var t=b.dataset.filter;
      cards.forEach(function(c){ c.style.display=(t==='all'||c.dataset.type===t)?'':'none'; }); });
  </script>
</body></html>
`;
}

// `export [--ids a,b]` — build the downloadable asset bundle from each element's
// CHOSEN version: stage clean-named PNGs (+ the raw crop when the chosen is a
// removal) + manifest.json + gallery.html, zip into the session files dir, and
// post bundle.set so the surface offers it via /assets/<name>. Resolves version
// files by BASENAME in files_dir (robust to stale absolute paths after a restore).
async function cmdExport(session: string | undefined, flags: Record<string, string | boolean>) {
  const s = requireSession(session);
  if (!s.files_dir) die("session has no files_dir — cannot build a bundle");
  const idFilter =
    typeof flags.ids === "string"
      ? new Set(
          flags.ids
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
        )
      : undefined;

  const { status, data } = await api(s.port, "GET", "/state");
  if (status !== 200) die(`state failed (HTTP ${status})`);
  const st = (data as { state?: { title?: string; elements?: Element[] } }).state;
  let elements = (st?.elements ?? []).filter((e) => e.status !== "dropped");
  if (idFilter) elements = elements.filter((e) => idFilter.has(e.id));
  if (!elements.length) die(idFilter ? "no matching elements for --ids" : "no assets to export");
  const title = st?.title ?? "magpie";

  const stageDir = join(s.files_dir, "bundle-stage");
  const zipName = "magpie-bundle.zip";
  let result: { count: number } | null = null;
  let failure: string | null = null;
  // The `export` imperative set status.busy on receipt; clear it (and clean the
  // stage dir) on EVERY exit path — otherwise the Export overlay sticks.
  try {
    rmSync(stageDir, { recursive: true, force: true });
    // Folderize: final chosen assets under assets/, raw crops under crops/ — so a
    // whole folder can be grabbed without parsing mixed files. crops/ is created
    // lazily (only if some item has a separate raw crop).
    const assetsDir = join(stageDir, "assets");
    const cropsDir = join(stageDir, "crops");
    mkdirSync(assetsDir, { recursive: true });

    const manifest: ManifestAsset[] = [];
    for (const el of elements) {
      const chosen = chosenVersion(el);
      if (!chosen) continue;
      const chosenFile = join(s.files_dir, basename(chosen.path));
      if (!existsSync(chosenFile)) {
        process.stderr.write(`magpie export: missing file for ${el.name} (${chosen.model})\n`);
        continue;
      }
      const fileBase = `${sanitize(el.name)}.png`;
      copyFileSync(chosenFile, join(assetsDir, fileBase));
      // the raw crop too, but only when the chosen is a removal (else it's the
      // same image as the asset). Same base name, in crops/.
      let cropPath: string | null = null;
      if (chosen.model !== "crop") {
        const cropFile = join(s.files_dir, cutoutFilename(el.name, "crop"));
        if (existsSync(cropFile)) {
          mkdirSync(cropsDir, { recursive: true });
          copyFileSync(cropFile, join(cropsDir, fileBase));
          cropPath = `crops/${fileBase}`;
        }
      }
      manifest.push({
        name: el.name,
        type: el.type,
        model: chosen.model,
        kind: chosen.kind ?? null,
        bbox: el.bbox,
        file: `assets/${fileBase}`,
        crop: cropPath,
      });
    }
    if (!manifest.length) throw new Error("no chosen assets found to export (files missing?)");

    writeFileSync(
      join(stageDir, "manifest.json"),
      JSON.stringify({ title, count: manifest.length, assets: manifest }, null, 2),
    );
    writeFileSync(join(stageDir, "gallery.html"), buildGalleryHtml(title, manifest));

    // zip into files_dir (outside the stage so the archive isn't self-included).
    const zipPath = join(s.files_dir, zipName);
    rmSync(zipPath, { force: true });
    const proc = Bun.spawn(["zip", "-r", "-q", zipPath, "."], {
      cwd: stageDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [zerr, zcode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (zcode !== 0) throw new Error(`zip failed (exit ${zcode}): ${zerr.trim()}`);

    await api(s.port, "POST", "/cmd", {
      type: "bundle.set",
      name: zipName,
      count: manifest.length,
    });
    process.stderr.write(`magpie: bundled ${manifest.length} asset(s) → ${zipPath}\n`);
    result = { count: manifest.length };
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
    await api(s.port, "POST", "/cmd", { type: "status", busy: false });
  }

  if (failure || !result) die(`export failed: ${failure ?? "unknown"}`);
  printJson({ ok: true, bundle: zipName, count: result.count });
}

const HELP = `magpie — a standing review surface for extracting assets from a composite image.

  open   [--title ..] [--intent ..] [--no-open] [--timeout S] [--restore <id|path>]
  sessions                            list saved (resumable) sessions
  tail   [--since N]                  SSE user events → JSONL (wrap with Monitor)
  state  [--full]                     lean state snapshot (add --full for raw)
  say    [text...] [--stdin]          post agent dialogue (text args OR piped stdin)
  ask    <text...> [--options "a|b|c"]   ask the user a question (in-thread)
  status on [text...] | status off    show/hide the "magpie working" spinner
  source <imagePath>                  register the composite under review (computes sha + size)
  discover                            run discover on the current source → post the breakdown (needs OPENROUTER_API_KEY)
  extract [--ids a,b] [--remove] [--alpha auto|all|none] [--pad N] [--model <m>] [--label <name>]
          cut slices (crop-only; --remove adds rembg). --model = a rembg model name (isnet-general-use,
          birefnet-general, …) OR a media-forge bg-remove model id (a provider path like
          fal-ai/bria/background/remove — DISCOVER via \`media-forge models list\`, never hardcode);
          --label sets the version's friendly strip label (defaults sensibly)
  export [--ids a,b]                  build magpie-bundle.zip — assets/ (chosen finals) + crops/ (raw crops) + manifest.json + gallery.html (backdrop toggle + type filters)
  element-add --bbox "x1,y1,x2,y2" [--name ..] [--type ..]   box a region (source px)
  element-remove <id>                 retract a boxed region
  cmd    [--stdin]                    POST a raw AgentCommand JSON body from stdin
  close | info | help

  Add --session <id> to target a specific session (default: most recent).`;

async function main(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv;
  const { pos, flags } = parseArgs(rest);
  const session = typeof flags.session === "string" ? flags.session : undefined;

  switch (verb) {
    case "open":
      await cmdOpen(flags);
      break;
    case "tail":
      await cmdTail(session, typeof flags.since === "string" ? parseInt(flags.since, 10) : -1);
      break;
    case "state":
      await cmdState(session, flags.full === true);
      break;
    case "say": {
      const text = flags.stdin === true ? await readStdin() : pos.join(" ");
      if (!text) die("usage: say <text...> | say --stdin");
      await postCmd(session, { type: "say", text });
      break;
    }
    case "ask": {
      if (!pos.length) die('usage: ask <text...> [--options "a|b|c"]');
      const msg: Record<string, unknown> = { type: "ask", text: pos.join(" ") };
      if (typeof flags.options === "string") {
        msg.options = flags.options
          .split("|")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      await postCmd(session, msg);
      break;
    }
    case "status":
      await postCmd(session, {
        type: "status",
        busy: pos[0] === "on",
        text: pos.slice(1).join(" "),
      });
      break;
    case "source":
      if (!pos.length) die("usage: source <imagePath>");
      await cmdSource(session, pos[0]);
      break;
    case "discover":
      await cmdDiscover(session);
      break;
    case "extract":
      await cmdExtract(session, flags);
      break;
    case "export":
      await cmdExport(session, flags);
      break;
    case "element-add":
      await cmdElementAdd(session, flags);
      break;
    case "element-remove":
      if (!pos.length) die("usage: element-remove <id>");
      await postCmd(session, { type: "element.remove", id: pos[0] });
      break;
    case "cmd": {
      // POST a raw AgentCommand JSON body (from stdin) — the escape hatch for
      // commands carrying NL text or rich payloads (e.g. elements.set).
      const raw = flags.stdin === true ? await readStdin() : pos.join(" ");
      if (!raw) die("usage: cmd --stdin  (pipe a JSON AgentCommand body)");
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw);
      } catch {
        die("cmd: body is not valid JSON");
      }
      await postCmd(session, body);
      break;
    }
    case "close":
      await postCmd(session, { type: "close" });
      break;
    case "info":
      cmdInfo(session);
      break;
    case "sessions":
      cmdSessions();
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(`${HELP}\n`);
      break;
    default:
      die(`unknown verb "${verb}" — run: cli.ts help`);
  }
  return 0;
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}

export { main };
