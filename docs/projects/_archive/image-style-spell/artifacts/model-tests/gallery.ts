#!/usr/bin/env bun
/**
 * Scrappy static gallery generator for model-test outputs.
 *
 * Scans outputs/<round>/ for images (+ manifest.json if present), and writes a
 * single self-contained outputs/gallery.html with the image list BAKED IN
 * (no fetch → works on a plain file:// double-click). Re-run after each round.
 *
 *   bun gallery.ts            # scans ./outputs, writes ./outputs/gallery.html
 *
 * The viewer: grid grouped by round → model, click an image to enlarge,
 * per-image star + note persisted to localStorage, "Export notes" → notes.json.
 * Not a spell — an in-the-moment tool. Delete freely.
 */
import { readdir } from "node:fs/promises";

const BASE = `${import.meta.dir}/outputs`;
const IMG_RE = /\.(png|jpe?g|webp|gif)$/i;

type Item = {
  round: string;
  file: string;
  src: string;
  model: string;
  style?: string;
  prompt?: string;
  seed?: string | number;
  modelId?: string;
  costMicros?: number | null;
};

// Rough per-image $ estimates (USD) at ~1MP, from model-research.md pricing.
// Fallback only — actual cost (when present) comes from `costs.ts` via the API.
const PRICE_EST: Record<string, number> = {
  "fal-ai/flux/schnell": 0.003,
  "fal-ai/flux/dev": 0.025,
  "fal-ai/flux-2/turbo": 0.008,
  "fal-ai/flux-2/klein/9b/lora": 0.01,
  "black-forest-labs/flux.2-pro": 0.03,
  "black-forest-labs/flux.2-flex": 0.05,
  "openai/gpt-image-2": 0.2,
  "fal-ai/nano-banana-2": 0.08,
  "fal-ai/gemini-3.1-flash-image-preview": 0.08,
  "google/gemini-3.1-flash-image-preview": 0.08,
  "google/gemini-2.5-flash-image": 0.039,
  "xai/grok-imagine-image/quality/text-to-image": 0.05,
  "fal-ai/recraft/v4.1/text-to-image": 0.04,
  "rundiffusion-fal/juggernaut-flux/pro": 0.035,
  "fal-ai/ernie-image/turbo": 0.01,
  "fal-ai/z-image/turbo": 0.004,
  "fal-ai/wan/v2.7/text-to-image": 0.03,
};

// Loose shape of a manifest entry as written by run.ts / costs.ts.
type GEntry = {
  file?: string;
  slug?: string;
  style?: string;
  model?: string;
  prompt?: string;
  seed?: string | number;
  costPerImageMicros?: number;
};

const rounds = (await readdir(BASE, { withFileTypes: true }))
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const items: Item[] = [];
const briefs: Record<string, string> = {};

for (const round of rounds) {
  const dir = `${BASE}/${round}`;
  // manifest (optional) gives prompt/model/style/seed per file
  let manifest: { entries?: GEntry[]; subject?: string; brief?: string } | null = null;
  try {
    manifest = await Bun.file(`${dir}/manifest.json`).json();
    briefs[round] = manifest?.subject ?? manifest?.brief ?? "";
  } catch {}
  const byFile = new Map<string, GEntry>();
  for (const e of manifest?.entries ?? []) if (e.file) byFile.set(e.file, e);

  const files = (await readdir(dir)).filter((f) => IMG_RE.test(f)).sort();
  for (const file of files) {
    const m = byFile.get(file);
    // Derive model/style from filename when manifest is missing/raced.
    // Filenames are "<model>-<style>.<ext>" (style round) or "<model>-<i>.<ext>" (single brief).
    const stem = file.replace(IMG_RE, "");
    let model = m?.slug ?? stem;
    let style = m?.style as string | undefined;
    if (!m) {
      const parts = stem.split("-");
      const last = parts[parts.length - 1] ?? "";
      if (/^\d+$/.test(last)) model = parts.slice(0, -1).join("-");
      else if (parts.length > 1) {
        style = last;
        model = parts.slice(0, -1).join("-");
      }
    }
    const modelId = m?.model;
    const costMicros = typeof m?.costPerImageMicros === "number" ? m.costPerImageMicros : null;
    items.push({
      round,
      file,
      src: `${round}/${file}`,
      model,
      style,
      prompt: m?.prompt,
      seed: m?.seed,
      modelId,
      costMicros,
    });
  }
}

const DATA = { rounds, briefs, items, priceEst: PRICE_EST };

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>glamour — model-test gallery</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, system-ui, sans-serif;
    background: #14101c; color: #e7e2f0; }
  header { position: sticky; top: 0; z-index: 5; padding: 14px 18px;
    background: #1c1530ee; backdrop-filter: blur(8px); border-bottom: 1px solid #3a2f55; }
  h1 { margin: 0 0 4px; font-size: 16px; font-weight: 600; color: #c9b8ff; }
  .sub { color: #9b8fc0; font-size: 12px; }
  .bar { margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .tab { padding: 5px 12px; border-radius: 999px; border: 1px solid #4a3d6e;
    background: #241a3c; color: #cdб7ff; cursor: pointer; font-size: 13px; }
  .tab.on { background: #6a4ddb; border-color: #6a4ddb; color: #fff; }
  .spacer { flex: 1; }
  button.act { padding: 5px 12px; border-radius: 8px; border: 1px solid #4a3d6e;
    background: #241a3c; color: #cdb7ff; cursor: pointer; font-size: 13px; }
  main { padding: 18px; }
  .brief { color: #9b8fc0; font-size: 12px; max-width: 960px; margin: 0 0 16px;
    padding: 10px 12px; background: #1c1530; border: 1px solid #2f2548; border-radius: 8px; }
  .group { margin-bottom: 26px; }
  .group h2 { font-size: 13px; font-weight: 600; color: #b9a8ec; margin: 0 0 10px;
    text-transform: lowercase; letter-spacing: .3px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; }
  .card { background: #1b1430; border: 1px solid #2f2548; border-radius: 12px; overflow: hidden;
    display: flex; flex-direction: column; }
  .card.star { border-color: #f5c451; box-shadow: 0 0 0 1px #f5c45166; }
  .thumb { aspect-ratio: 1/1; background: #0e0a18; display: flex; align-items: center; justify-content: center;
    cursor: zoom-in; overflow: hidden; }
  .thumb img { width: 100%; height: 100%; object-fit: contain; }
  .meta { padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
  .label { display: flex; align-items: center; gap: 6px; }
  .label .name { font-weight: 600; font-size: 12.5px; color: #e7e2f0; }
  .label .style { font-size: 11px; color: #8f83b3; }
  .star-btn { margin-left: auto; cursor: pointer; font-size: 16px; line-height: 1;
    background: none; border: none; color: #5a4d7e; }
  .star-btn.on { color: #f5c451; }
  textarea { width: 100%; resize: vertical; min-height: 34px; font: inherit; font-size: 12px;
    background: #120d20; color: #d8d0ec; border: 1px solid #2f2548; border-radius: 6px; padding: 5px 7px; }
  textarea::placeholder { color: #5a4d7e; }
  /* lightbox */
  #lb { position: fixed; inset: 0; background: #08060f, ; background: #08060fee; display: none;
    align-items: center; justify-content: center; z-index: 50; cursor: zoom-out; flex-direction: column; gap: 10px; padding: 24px; }
  #lb.on { display: flex; }
  #lb img { max-width: 94vw; max-height: 82vh; object-fit: contain; border-radius: 8px; }
  #lb .cap { color: #c9b8ff; font-size: 13px; max-width: 90vw; text-align: center; }
  #lb .cap .p { color: #8f83b3; font-size: 11px; margin-top: 4px; }
</style>
</head>
<body>
<header>
  <h1>glamour · model-test gallery</h1>
  <div class="sub" id="count"></div>
  <div class="bar" id="tabs"></div>
</header>
<main id="main"></main>

<div id="lb"><img id="lb-img" /><div class="cap" id="lb-cap"></div></div>

<script>
const DATA = ${JSON.stringify(DATA)};
const NOTES_KEY = "glamour-gallery:notes";
const notes = JSON.parse(localStorage.getItem(NOTES_KEY) || "{}");
function saveNotes() { localStorage.setItem(NOTES_KEY, JSON.stringify(notes)); }
function noteFor(src) { return notes[src] || (notes[src] = { star: false, note: "" }); }

let active = DATA.rounds[0];

// Per-image cost: actual micros if known, else estimate from price map.
function costOf(it) {
  if (typeof it.costMicros === "number") return { usd: it.costMicros / 1e6, actual: true };
  const est = DATA.priceEst[it.modelId];
  return est != null ? { usd: est, actual: false } : null;
}
function fmt(usd) { return "$" + usd.toFixed(usd < 0.1 ? 4 : 3); }
function sumCost(items) {
  let total = 0, anyEst = false, allKnown = true;
  for (const it of items) {
    const c = costOf(it);
    if (!c) { allKnown = false; continue; }
    total += c.usd; if (!c.actual) anyEst = true;
  }
  return { total, anyEst, allKnown };
}

function render() {
  const main = document.getElementById("main");
  main.innerHTML = "";
  const items = DATA.items.filter(i => i.round === active);
  const rc = sumCost(items);
  document.getElementById("count").textContent =
    items.length + " images · " + new Set(items.map(i=>i.model)).size + " models · round: " + active +
    " · " + fmt(rc.total) + (rc.anyEst ? " est" : " actual") + (rc.allKnown ? "" : " (some unpriced)");

  if (DATA.briefs[active]) {
    const b = document.createElement("div");
    b.className = "brief"; b.textContent = "Brief: " + DATA.briefs[active];
    main.appendChild(b);
  }

  const models = [...new Set(items.map(i => i.model))];
  for (const model of models) {
    const group = document.createElement("div");
    group.className = "group";
    const mitems = items.filter(i => i.model === model);
    const mc = sumCost(mitems);
    const h = document.createElement("h2");
    h.innerHTML = esc(model) + " <span style='color:#7a6ca6;font-weight:400'>· " + fmt(mc.total) + (mc.anyEst ? " est" : "") + "</span>";
    group.appendChild(h);
    const grid = document.createElement("div"); grid.className = "grid";
    for (const it of items.filter(i => i.model === model)) {
      grid.appendChild(card(it));
    }
    group.appendChild(grid); main.appendChild(group);
  }
}

function card(it) {
  const n = noteFor(it.src);
  const el = document.createElement("div");
  el.className = "card" + (n.star ? " star" : "");
  const thumb = document.createElement("div"); thumb.className = "thumb";
  const img = document.createElement("img"); img.src = it.src; img.loading = "lazy";
  thumb.appendChild(img);
  thumb.onclick = () => openLb(it);
  el.appendChild(thumb);

  const meta = document.createElement("div"); meta.className = "meta";
  const label = document.createElement("div"); label.className = "label";
  const name = document.createElement("span"); name.className = "name";
  name.textContent = it.style || it.file.replace(/\\.[^.]+$/, "").replace(it.model + "-", "");
  label.appendChild(name);
  const c = costOf(it);
  if (c) {
    const cs = document.createElement("span");
    cs.style.cssText = "font-size:11px;color:" + (c.actual ? "#7fcf9a" : "#8f83b3");
    cs.textContent = fmt(c.usd) + (c.actual ? "" : " est");
    cs.title = c.actual ? "actual cost" : "estimate";
    label.appendChild(cs);
  }
  const star = document.createElement("button");
  star.className = "star-btn" + (n.star ? " on" : ""); star.textContent = n.star ? "★" : "☆";
  star.onclick = () => { n.star = !n.star; saveNotes(); render(); };
  label.appendChild(star);
  meta.appendChild(label);

  const ta = document.createElement("textarea");
  ta.placeholder = "note…"; ta.value = n.note;
  ta.oninput = () => { n.note = ta.value; saveNotes(); };
  meta.appendChild(ta);
  el.appendChild(meta);
  return el;
}

function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
function openLb(it) {
  document.getElementById("lb-img").src = it.src;
  const cap = document.getElementById("lb-cap");
  cap.innerHTML = "<b>" + esc(it.model) + (it.style ? " · " + esc(it.style) : "") + "</b>" +
    (it.prompt ? "<div class='p'>" + esc(it.prompt) + "</div>" : "");
  document.getElementById("lb").classList.add("on");
}
document.getElementById("lb").onclick = () => document.getElementById("lb").classList.remove("on");

function tabs() {
  const t = document.getElementById("tabs"); t.innerHTML = "";
  for (const r of DATA.rounds) {
    const b = document.createElement("button");
    b.className = "tab" + (r === active ? " on" : ""); b.textContent = r;
    b.onclick = () => { active = r; tabs(); render(); };
    t.appendChild(b);
  }
  const sp = document.createElement("span"); sp.className = "spacer"; t.appendChild(sp);
  const exp = document.createElement("button"); exp.className = "act"; exp.textContent = "Export notes";
  exp.onclick = exportNotes; t.appendChild(exp);
}

function exportNotes() {
  const blob = new Blob([JSON.stringify(notes, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "notes.json"; a.click();
}

tabs(); render();
</script>
</body>
</html>`;

await Bun.write(`${BASE}/gallery.html`, html);
console.log(
  `Wrote ${BASE}/gallery.html  (${items.length} images across ${rounds.length} rounds: ${rounds.join(", ")})`,
);
