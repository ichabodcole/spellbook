# Magpie — Background-Removal Phase (design)

_2026-06-26 · phase 3 of the magpie rebuild (after intake+canvas and slices)._
_Seed: `design-notes.md`. Sketches: `prototype/bg-removal-mockup-v2.html`
(chosen), `prototype/bg-removal-mockup.html` (A/C explorations)._

## Goal

The slices phase produces validated **raw crops** (one per element, box-exact).
This phase turns the alpha-eligible ones into **transparent cutouts**, lets the
user review them against backdrops, and — for any that don't come out clean —
asks for a different removal until one looks right. The terminal output is a set
of chosen cutouts (transparent PNGs) + the kept-whole crops.

The thesis carried over from the rest of magpie: **co-presence, with the human
judging and the agent doing.** Here that lands as a sharp division of labor:

> **The human judges _results_; the agent picks _models_.**

## Locked decisions (from scoping)

1. **Layout: gallery + contextual detail sidebar + expand-in-place. No modal.**
   - Main area: a **gallery grid** of cutouts on a chosen backdrop swatch.
   - Right sidebar: the **detail of the selected item** — a vertical **version
     strip** (history of removal attempts) + the "try a different removal"
     action + flag.
   - **Expand** a single item → it fills the gallery canvas; the sidebar stays
     open. (A browse-only lightbox may ride along later; not in V1.)
2. **Human judges results, agent picks models.**
   - "Try a different removal" is a **model-agnostic** signal (single button; a
     batch version on flagged items). The agent decides which model to try.
   - The result lands in the item's **version strip**; the human selects the
     best-looking one. **Selecting a version IS choosing it** (one click, no
     separate "Use").
   - Model names surface ONLY as labels on produced versions (dynamic). **No
     model menu for the human.** A human-facing picker is an optional "maybe
     later," not the default.
3. **Models are an agent-owned concern, never baked into the UI.** Adding a
   model must require no app change. (See contract: the retry imperative carries
   no model; the agent chooses.)
4. **Type-driven alpha policy stays.** `auto` removes
   illustration/sticker/icon/wordmark; **palette/screenshot/typography are "kept
   whole"** (flat color would be destroyed) — shown in the gallery with a "kept
   whole" note + an override.
5. **Flagging drives the batch.** Flag the cutouts that aren't working → one
   action re-removes all flagged (agent's model discretion), same shape as the
   slices phase's flag→batch.
6. **Backdrop swatches** (white / gray / black / checker=transparent) preview
   alpha; they travel into the detail + expanded views. `backdrop.set` already
   exists (ambient).

## Surface

Reuses the slices layout grammar (canvas-area + rail) but repurposed:

```
┌ header ── 🐦 magpie · background removal ─── magpie picks models · connected ─┐
├──────────────────────────────────────────────┬──────────────────────────────┤
│ GALLERY (or EXPANDED item)                    │ DETAIL — selected item       │
│  toolbar: backdrop swatches · N flagged →     │  identity · expand ⤢         │
│           "Try a different removal on N"       │  [ big preview on backdrop ] │
│  ┌────┐ ┌────┐ ┌────┐                          │  VERSIONS (history):         │
│  │▓▓▓▓│ │▒▒▒▒│ │░░░░│  ← cutouts on backdrop   │   ◌ crop      (raw)          │
│  └────┘ └────┘ └────┘    flag corner + chip    │   ● rembg     slight halo    │
│  ...                                           │   ○ bria      clean   ✓active│
│                                                │  [ Try a different removal ] │
│                                                │  ⚑ Flag this                 │
└──────────────────────────────────────────────┴──────────────────────────────┘
```

**Gallery item card**: cutout on the current backdrop; a **flag** toggle
(corner); a chip showing the chosen version's model; a "N versions" hint; expand
⤢. Click selects it into the detail sidebar; the flag is a separate gesture
(flag ≠ select).

**Detail sidebar**: identity, a large preview of the chosen version on the
backdrop, the **version strip** (each row = one attempt: a thumbnail on the
backdrop, the model label + `local`/`cloud` kind, its note, a radio/active
marker), the model-agnostic **Try a different removal** button (+ caption), and
a **Flag** toggle. Kept-whole items show a "no alpha" explainer + override
instead of a strip.

**Expanded**: the selected item fills the gallery area (big, on the backdrop);
the sidebar stays. "Back to gallery" + the same detail controls.

## Interaction model

- **Remove backgrounds** (first pass): from the gallery toolbar (or per item),
  the agent removes alpha-eligible crops → each gets a first removal version.
  Kept-whole types are skipped.
- **Review**: flip backdrop swatches; eyeball each cutout. Expand for a close
  look.
- **Not working?** Flag it (or several). The gallery surfaces **"Try a different
  removal on N"**. Or, per item in the detail, **"Try a different removal"**.
  Either is model-agnostic → the agent picks an unused model and runs it.
- **New result** appears in the version strip (with a processing shimmer — reuse
  the `ActivityBars` wave). When it lands, the human **clicks the version they
  like** → it becomes the chosen/active cutout everywhere.
- **Done** when each kept item has a chosen version the user is happy with.

## Contract changes

Today (slices phase) an element has a single `cutout: { path, backend, rev }`
and a `reslice` flag. This phase generalizes the cutout into a **version list**
— and the raw crop becomes simply **version 0** (`model: "crop"`):

```ts
// one produced asset for an element — a crop (model:"crop") or a removal result
export type ElementVersion = {
  id: string; // stable id (the chosen pointer references this)
  model: string; // "crop" | "rembg" | "bria" | "ideogram" | …(agent-defined)
  kind?: "raw" | "local" | "cloud"; // for the label chip; agent-supplied
  path: string; // on-disk PNG, served via /assets
  rev: number; // cache-bust (re-runs of the same model overwrite in place)
  note?: string; // short quality note the agent may attach
};

export type Element = {
  // …id, name, type, bbox, status…
  versions: ElementVersion[]; // was: cutout?  (crop = versions[0])
  chosenVersionId?: string; // which version is active (default: the crop)
  flagged?: boolean; // was: reslice — "needs another pass"
  //   (re-slice in slices phase, re-remove here)
};
```

Notes:

- **`cutout` → `versions[]`** is the one breaking change. Migration is small:
  the slices phase writes `versions: [{ id, model:"crop", path, rev }]` and sets
  `chosenVersionId` to it. The rail's thumbnail reads the chosen version.
- **`reslice` → `flagged`** (rename for the now-shared meaning). The batch
  action is phase-contextual: re-slice (crop) vs re-remove (alpha).
- **No model registry in state is required** for V1 (human never picks). If we
  later want a human-facing picker, add `models?: ModelInfo[]` then — out of
  scope now.

**Imperatives (ClientToServer → agent SSE), all model-agnostic:**

- `removeBg { ids?: string[] }` — remove backgrounds for these alpha-eligible
  elements (absent → all eligible). Agent picks the model per element, runs it,
  appends a version, sets `chosenVersionId`. (Or fold into `extract` with a
  `mode: "remove"`; the cli already has `extract --remove`. Decide at build.)
- `retryRemoval { ids: string[] }` — "try a different removal" on these
  (flagged) items. Agent picks an **unused** model at its discretion, appends a
  new version. The carried payload is **just ids** — never a model.
- `version.choose { id, versionId }` — the human selected a version → set
  `chosenVersionId` (ambient: mutate + broadcast, NO agent push, per the
  imperatives-only rule).
- `element.flag { id, flagged }` — generalizes `element.mark` (ambient).
- `backdrop.set` — already exists (ambient).

`removeBg` / `retryRemoval` are imperatives (agent does work) → emitted to the
agent. `version.choose`, `element.flag`, `backdrop.set` are ambient → browser
only, read from `/state` when the next imperative fires (per the codified
imperatives-only contract).

## Scripts / agent side

- **Already built:** `scripts/remove.py` (Pillow crop + rembg, alpha policy,
  `--pad`), `scripts/backend.ts` (`rembgBackend.cut`, `shouldRemove`), and
  `cli extract --remove` (→ backend `"rembg"`). The local path largely exists;
  this phase wires it to the version model and the surface.
- **Agent model discretion:** on `retryRemoval`, the agent inspects an element's
  existing versions (which models were tried) and picks an unused one. For V1
  the available set is rembg (local) + the media-forge cloud backends
  (Bria/Ideogram) — the agent knows these out-of-band; the surface never does.
- **Cloud backends (Bria/Ideogram via media-forge):** auth/cost live at the MCP
  layer (house rule). Not the automatic default, but **exercised during the
  workflow dogfood** to validate the model-agnostic retry path (see Decisions).

## Build sub-steps (phased within the phase)

1. **Contract migration** — `cutout → versions[]` + `chosenVersionId`,
   `reslice → flagged`; update reduce.ts + slices-phase writes + tests. (Pure,
   no UI.)
2. **First removal pass** — `removeBg` imperative + cli wiring; rembg versions
   appended; chosen set. Gallery grid renders chosen version on a backdrop.
3. **Detail sidebar** — selection → version strip; `version.choose`
   (select-by-result); the kept-whole explainer.
4. **Retry loop (model-agnostic)** — `flagged` + `retryRemoval` (agent picks an
   unused model); processing shimmer in the strip; batch on flagged from the
   gallery toolbar. Built model-agnostic so any backend the agent has plugs in.
5. **Expand-in-place** — single item takes over the gallery area, sidebar stays.
6. **Workflow dogfood incl. other models** — run the full flow together;
   deliberately exercise a non-rembg model on selected items (Bria/Ideogram via
   media-forge, agent's discretion) to validate extraction-and-swap end to end —
   this is a _test step_, not a deferred feature.

Each sub-step is dogfooded before the next (the established rhythm). The
slices→gallery→extraction transition (step 2's entry) is expected to iterate.

## Decisions (resolved 2026-06-26)

- **V1 scope — rembg is the automatic first pass; other models are NOT stubbed,
  they're exercised in testing.** Build the automatic removal on **rembg** (the
  local tooling we already have). But the model-agnostic **retry path is real,
  not deferred**: when we run the dogfood workflow together, exercising a
  _different_ model on selected items is **part of the test** — even if the
  rembg results look fine, we'll pick some gallery items and have the agent run
  another model to validate the full extraction-and-swap flow and the interface.
  Rationale: precisely _because_ nothing is baked in, the agent brings whatever
  models it has (rembg local + cloud via media-forge) at its discretion; we must
  prove that round-trip works, not just the local default. So: **code the
  automatic pass against rembg; build `retryRemoval` to be genuinely
  model-agnostic; test it with real other models in the workflow.**
- **`removeBg` is a new imperative** (not a `mode` on `extract`). The cli
  already supports the underlying `--remove`; the imperative stays
  model-agnostic.
- **Explicit, not auto.** Entering the gallery does NOT auto-run removal — an
  explicit trigger does (don't bake in behavior we haven't validated; add auto
  later only if we find we want it). **The slices → gallery → extraction
  transition itself is unsettled** — button, a conversation prompt, or something
  else — and is expected to **iterate during the build** as we feel how one mode
  flows into the next. Lean explicit at each seam.
- **Lightbox: deferred.** Expand-in-place covers the focused-look need; a
  browse-only flip-through can come later if wanted.

## Testing

- reduce.ts: version add/choose/flag mutators; the `cutout→versions` migration
  shape; kept-whole skip.
- daemon.integration: `removeBg`/`retryRemoval` ARE imperatives (emit + busy);
  `version.choose`/`element.flag` are ambient (mutate + gesture, NO agent event)
  — mirror the slices-phase pattern.
- A pad/box invariant already holds from slices (crop = box). Removal versions
  inherit the crop bounds.
