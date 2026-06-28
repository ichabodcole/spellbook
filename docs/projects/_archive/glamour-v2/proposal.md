# Glamour v2 — gallery-central style discovery

**Status:** Archived (Implemented 2026-06-25) — cut over to the main glamour
spell via commit `22f22ab`; all slices + Slice 3.5 cleanup + Slice 5 landing
screen shipped, fresh-agent gate cleared. Live:
`plugins/spellbook/skills/glamour/`. **Created:** 2026-06-19 **Updated:**
2026-06-21 **Author:** Cole Reed

---

## Overview

Glamour v2 is a **clean rebuild** of the glamour spell on a new surface model:
the **gallery is the workspace** and a structured **style guide** is the output.
It reframes glamour from "an image studio that overlaps imago" into a distinct
_method-spell_ — the structured discovery of a re-castable visual style — that
**delegates deep image work to imago** rather than re-implementing it.

This is not a refactor of the shipped glamour (V1). V1 stays in place as a
reference to mine; v2 is built fresh and replaces it once it lands. The design
rationale and the decision trail live in the investigation
(`docs/projects/image-style-spell/glamour-reframe-investigation.md`); the
converged surface is the mockup
(`docs/projects/image-style-spell/artifacts/unified-library-mockup.html`).

## Problem Statement

Three problems, established in the investigation:

1. **The duplication treadmill.** As glamour needs to give richer direction, it
   keeps absorbing imago features (annotate-to-steer, edit-a-region). Imago is
   already a capable image engine; glamour was on a path to become a second one.
2. **V1's shape is a pipeline, not a board.** V1 is a strict forward-only phase
   flow (`gather → analysis → direction → prompts → variants → spec`) with
   per-phase text-input forms and one-way narration. By the project's own
   co-presence rule, that's "the form reasserting itself." Jumping back means
   re-entering a phase rather than just pointing at an image and talking.
3. **No persistent, project-scoped library.** Every V1 session is an island;
   styles you've created don't persist, and there's no way to reuse a prior
   style as a reference.

## Proposed Solution

A gallery-central surface where talking about images _is_ the work. Full model
in the investigation's **"Surface model — resolved via mockup"** section;
summary:

- **Gallery is the board; chat is a sidebar.** The center is a library of images
  and text; the conversation runs alongside it.
- **One unified library spanning media.** Reference images, context documents,
  and generated images are co-equal tiles in one faceted grid (filters:
  References / Context / Generated / Styles). Selecting a text item grounds a
  message exactly like selecting an image.
- **Selection = grounding.** What's selected is what the next message is about.
  Direct manipulation (star, like, editable detail fields) + a chat sidebar —
  not stage-gated forms.
- **Persistent details fly-out** (imago pattern) shows any tile's metadata;
  enlarging swaps the grid for one large image, sidebar unchanged. Generated
  images carry **first-class generation metadata** (model, prompt, seed, cost +
  custom).
- **Zoom in/out is a co-presence lens.** Full palette → a focused mini-gallery →
  an enlarged single. **Either party scopes the set** (human: "focus these";
  agent: pushes a subset). When the agent scopes, it gets a **contextual-ask
  drawer** distinct from chat ("here are four — which reads most like X?").
- **No phases.** The structured output is a **"Style guide" view** that fills in
  (section status: empty → forming → agreed); maturity is read from the
  artifact, not a stepper. The agent assembles it from the conversation; the
  human corrects it there.
- **Project-scoped styles tray.** Past styles are **not auto-loaded**; they live
  in a tray scoped to the checkout where the spell was cast, and are
  **deliberately brought in** as references. A style is a compound "canonical
  shape" (text + canonical images).
- **imago handoff (intent-based).** Glamour holds the loop while converging on
  the _style_; the moment you want to perfect one _specific image_, hand it to
  imago and the perfected result returns as a canonical image in the guide.

### How users experience it

Open glamour in a project → drop refs / context docs, or bring in an existing
project style as an anchor. Talk about what you like (select tiles to ground);
the agent annotates images and assembles a style guide as you go. Ask for a
batch; the agent generates and may pull a few into focus with a question. React;
the guide firms up. When one image deserves perfection, jump to imago and come
back. End with a codified, re-castable style saved to the project's tray.

## Scope

**In Scope (MVP):**

- Gallery-central surface (React + Bun, house surface stack).
- Unified library (image + text + generated + style tiles) with type facets.
- Selection-as-grounding; details fly-out with editable dual annotations
  (agent + human) and generated-image metadata.
- Zoom/focus lens (full → mini-gallery → enlarged), human- **and**
  agent-initiated, with the focus-mode agent drawer.
- Style-guide view that the agent assembles and the human corrects (no phases).
- Project-scoped styles tray with deliberate bring-in; styles as compound
  shapes; non-destructive (archive/restore, not delete) — the imago lesson.
- Lightweight probe generation via the shared media-forge primitive.
- Snapshot/restore of a session.

**Out of Scope (initially):**

- The imago handoff _plumbing_ (artifact format on the wire, who-opens-imago).
  v2 designs the seam's _shape_; the wire format is a follow-on (open questions
  B1/B2).
- A shared cross-spell library/store (L1 resolved against it for now).
- Composition / orchestration machinery ("a working") — earned later
  (investigation Decision E).
- Attaching an identifying image to a text item.

**Future Considerations:** the imago handoff implementation; the composition
pattern + its manifesto entry; cross-spell artifact interchange.

## Build Sequencing

v2 is built as **vertical slices**, not one monolithic plan. Each slice is
independently usable end-to-end and gets its own implementation plan
(`writing-plans`) + review pass. The MVP scope above is the union of slices 1–4;
the slice boundaries are where the build is sequenced and reviewed.

Throughout the build, **V1 stays installed and working** as the fallback. v2
only replaces V1 once it passes the success criteria below (fresh-agent + ward)
— so no slice has to be feature-complete-vs-V1 to be merged and dogfooded.

1. **Skeleton + unified library.** Bun daemon (HTTP + WebSocket + SSE + POST
   `/cmd`), the shared `types.ts` contract, the React shell, the unified library
   grid (ref / context / gen tiles with type facets), the persistent details
   fly-out, and snapshot/restore. Ports V1's proven spine (channels, lean state,
   persistence, image optimization). Deliverable: drop refs/context, see them as
   tiles, inspect a tile, resume a session.
2. **Conversation + grounding + style guide.** The chat sidebar,
   select-to-ground deixis (selection = what the next message is about), and the
   agent-assembled **Style-guide view** that fills in (section status: empty →
   forming → agreed). Deliverable: talk about selected tiles; watch the style
   guide materialize and correct it. The co-presence heart.
3. **Generation + focus lens.** media-forge probe generation with round / batch
   grouping, generated-image metadata (G1), and the **zoom/focus co-presence
   lens** (full → mini-gallery → enlarged) — human-initiated _and_
   agent-initiated, with the focus-mode agent drawer. Deliverable: ask for a
   batch, react to it, either party scopes a focus set.
4. **Project-styles tray.** The project-scoped tray (styles not auto-loaded),
   deliberate bring-in, and styles as compound "canonical shapes" (text +
   canonical images). Non-destructive archive/restore. Deliverable: save a
   codified style to the project; bring a prior style into a new session.

The imago-handoff seam (B1/B2) and composition are **not** slices — they remain
out of MVP (designed in shape only; see Open Questions).

## Technical Approach

Built on the house surface stack — a Bun daemon (`Bun.serve`, canonical state,
snapshots) + a React surface bundled by Bun, per `spell-surface-stack` and V1's
proven channel/state patterns. **Reuse imago's proven patterns** rather than
reinventing:

- A single shared `types.ts` contract for all channels (the V1 keystone, kept).
- Lean state projection (agent reads disk paths, not inlined blobs).
- **Ambient vs. imperative events** — board moves (select, focus) mutate state;
  only imperatives (say, generate, etc.) emit agent events.
- Non-destructive library (archive/restore) and externalized generated images on
  disk (snapshot leanness) — both imago lessons V1 lacked.

The state model centers on a **unified library of items** (kind: ref | context |
gen | style) with per-item metadata + annotations, a **focus set** (the zoom
lens, with owner), a **style guide** (sections with status), and a
**project-scoped style tray**. This is a meaningfully different state shape than
V1's phase/influences/variants model — hence a rebuild, not a refactor.

**Key dependency:** media-forge (generation), as today.

## Mining V1 (carry-forward calls)

V1 turned out to be a **mature, shipped conjuration** — all nine items below are
implemented there (`GlamourState`, HTTP + WebSocket + SSE + POST `/cmd`, ~19 CLI
verbs). That makes V1 a rich mine of proven code; each item's call is resolved
below, with the slice it lands in.

- **Round / batch grouping** — **Carry.** V1 tags each variant with a `round`
  that increments on clear; v2 keeps round grouping for generation batches.
  _(Slice 3.)_
- **Lightbox / aspect-ratio view** — **Adapt (simplify).** V1 had no real aspect
  metadata; v2 uses the mockup's simpler **enlarge** (grid swaps for one big
  image, details fly-out unchanged). No separate lightbox component. The Slice-3
  refinement adds **gallery traversal in the enlarged view** — prev/next
  controls and left/right arrow-key nav that cycle through the whole
  (faceted/selected) image set from wherever you opened it, so the human can
  flip through the gallery without dropping back to the grid. _(Slice 1 enlarge;
  traversal + refinement in 3.)_
- **Cost display + per-generation cost** — **Adapt (upgrade).** V1's `cost` is
  only a cumulative display string. v2 captures cost **per generation** as a
  typed metadata field (part of G1); cumulative is a derived sum. _(Slice 3.)_
- **Narration kinds (`info | working | result | error`)** — **Carry, remapped.**
  V1's one-way narration feed becomes the **chat sidebar**; the four kinds
  survive as message kinds (agent status vs. result vs. error still read
  differently). _(Slice 2.)_
- **Spec modules + `recreatePrompt` + `model`** — **Carry, remapped.** V1's four
  modules (palette / consistency / motifs / dos-donts) + `understanding` map
  onto the v2 **style-guide sections**; `recreatePrompt` + `model` live in
  generation metadata and the style's "recreate" affordance. _(Slice 2 sections;
  3 metadata.)_
- **Snapshot/restore + resumption (`open --restore`)** — **Carry as-is.**
  Debounced snapshot, restore by session-id or path, on-disk path
  re-materialization so the agent's by-path reads survive a restore. Proven;
  copy. _(Slice 1.)_
- **Image optimization on ingest** — **Carry, upgraded.** Browser canvas
  downscale + WebP on drop; server-side downscale + WebP for data-URLs (1200px /
  q85). v2 drops V1's `sharp` dependency for the native **`Bun.Image`** API
  (stable since Bun 1.3.14 — no native build step). _(Slice 1.)_
- **Correct-vs-augment feedback framing** — **Carry.** V1's
  `mode: "correct" | "augment"` on direction/notes is the right primitive for
  grounded feedback; keep it on v2's selection-grounded messages. _(Slice 2.)_
- **Terminal-handoff banner / lean-state** — **Split.** **Lean-state projection
  carries** (essential — the agent reads disk paths, not inlined blobs; Slice
  1). The **handoff banner defers** — it becomes the imago seam (B1/B2, out of
  MVP).

**Also carry (V1 extras the checklist didn't name):** the SSE event tail with
replayable `?since=<id>` for agent monitoring (Slice 1);
single-canonical-variant enforcement → reframed as the style guide's "canonical
images" (Slice 4); session-discovery tmpfiles, idle timeout, debounced
persistence (Slice 1, ops). **Drop:** V1's `advancePhase` auto-stepping (v2 has
no phases). **Reconsider:** V1 lets only the _user_ add influences/contexts — v2
keeps that for refs/context tiles, but the agent owns **generated** tiles (it
produces them); spelled out in the ambient-vs-imperative event design.

## Impact & Risks

**Benefits:** ends the duplication treadmill; gives glamour a distinct,
co-presence-true identity; adds the persistent project-scoped style library;
makes the surface match how style discovery actually feels (messy, free-form,
image-centric).

**Risks:**

- **D1 — orientation without a stepper.** Provisionally addressed by the mockup
  (gallery accretion + style-guide solidity + focus drawer), but a real build is
  the true test. Watch for users feeling lost.
- **Rebuild cost / regression.** A fresh build can drop V1 niceties — the mining
  checklist is the mitigation.
- **Seam ambiguity.** The imago handoff is designed in shape only; leaving the
  wire format unspecified risks a hand-wavy boundary. Mitigation: keep the
  handoff out of MVP and spec it once B1/B2 are settled.

**Complexity:** High — new state model + surface, multiple novel interactions
(zoom lens, unified library, agent-driven focus).

## Resolved Decisions

- **G1 — generated-image metadata: fixed core + freeform extras.** A typed core
  the surface understands — `model`, `prompt`, `seed`, `cost` (captured
  per-generation, unlike V1's cumulative-only string) — plus an open
  `custom: Record<string, string>` for the mockup's "add custom field"
  affordance. Lands in Slice 3.

## Parked enhancements (from Slice-1 dogfooding, 2026-06-22)

Captured during the first hands-on session — desirable, not yet scheduled to a
slice. Recorded here so they aren't lost; promote to a slice when prioritized.

- **Item tags — human _and_ agent.** The `tags: string[]` field already exists
  on `LibraryItem` (Slice 1 contract) but is unsurfaced. Surface it as editable
  tags in the details fly-out (human tagging), and let the **agent** tag items
  it ingests or generates (a `tags` command / annotation) — agent tagging
  becomes a lightweight way to **relate images to each other** (group by motif,
  subject, palette) that the gallery can then facet/filter on. Pairs naturally
  with the existing kind facets. _(No slice yet; smallest home would extend the
  fly-out + add an agent tag verb.)_
- **Gallery traversal in the lightbox** — see the Lightbox mining entry above
  (folded into the Slice-3 focus-lens refinement: prev/next + arrow-key cycling
  through the set).
- **Gallery thumbnail size control.** A small/medium/large toggle group that
  scales the grid tiles, so the human can trade scan-density for detail. The
  gallery is the primary scanning surface, so cheap size control has outsized
  value. _(No slice yet; pure surface state — grid column/size class driven by a
  toggle.)_
- **Aspect-ratio (masonry) gallery mode — experiment.** An alternative to the
  square thumbnails that lays images out in their **native aspect ratio**,
  packed to fit well together (masonry/justified layout), so you read what's
  actually in each image at a glance. Keep the square grid as the default (even,
  easy to scan); this is a second view mode worth prototyping, not a
  replacement. Lower priority than the size control. _(No slice yet;
  experimental — a layout variant over the same library.)_
- **Vision metadata on images (from 2026-06-23 Slices 1–3 dogfooding).** Two
  related asks: (1) **auto-analyze on drop** — run a vision pass automatically
  when an image lands so its description is just there (today it's
  agent-initiated via the existing `agent` annotation, which already renders in
  the details fly-out — demoed live, only the auto-trigger is missing); and (2)
  **re-reference by description, not pixels** — use the stored description as a
  cheap text proxy when grounding on an image again, so the agent reads the
  description instead of re-ingesting the full image. (2) touches the
  grounding + lean-state contract (an item could ground as text _or_ image) and
  is a real token / quick-reference win — wants a short design note before
  building. See `sessions/2026-06-23-slices1-3-dogfood-feedback.md`. _(No slice
  yet.)_

## Open Questions (deferred — tied to the imago seam, out of MVP)

- **B1** — imago handoff: hard context-switch vs. embedded view? (lean hard
  switch)
- **B2** — concrete artifact format across the glamour↔imago seam.

## Success Criteria

- A glamour session runs end-to-end on the gallery-central surface — refs +
  context in, conversation + grounded selection, agent-assembled style guide,
  probe generation with focus, a codified style saved to the project tray —
  without phase walls.
- The duplication line holds: no canvas/layer/annotation-depth re-implementation
  (that stays imago's).
- A previously-defined project style can be brought in as a reference in a new
  session.
- Fresh-agent + ward pass before it replaces V1.

## References

- Investigation (rationale + decision trail):
  `docs/projects/image-style-spell/glamour-reframe-investigation.md`
- Converged surface mockup:
  `docs/projects/image-style-spell/artifacts/unified-library-mockup.html`
- **V1 code (the mine):** `plugins/spellbook/skills/glamour/` — `surface/state/`
  (types, image optimization), `scripts/server.ts` (channels, lean state,
  snapshot/restore), `scripts/cli.ts` (verbs).
- V1 field data:
  `docs/projects/image-style-spell/artifacts/glamour-dogfood-hollowbrook.md`,
  `…/artifacts/glamour-dryrun-v3-findings.md`.
- **Superseded** (pre-reframe, pipeline-shaped — useful only for its
  agent-buildability principles + dogfood punch-list):
  `docs/projects/image-style-spell/glamour-rebuild-design.md` and the
  `…/plans/2026-06-10-glamour-rebuild-*` plans.
- Co-presence: `docs/PROJECT_MANIFESTO.md` §2; `grimoire/house-style.md`
