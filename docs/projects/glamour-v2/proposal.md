# Glamour v2 — gallery-central style discovery

**Status:** Draft **Created:** 2026-06-19 **Author:** Cole Reed

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

## Technical Approach

Built on the house surface stack — a Bun daemon (`Bun.serve`, canonical state,
snapshots) + a React surface bundled by Bun, per `spell-surface-stack` and the
V1 rebuild design. **Reuse imago's proven patterns** rather than reinventing:

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

## Mining V1 (carry-forward checklist)

V1 carries detailed work the mockup didn't represent. Evaluate each for
carry-forward (the reason V1 stays in place):

- [ ] Round / batch grouping of generations
- [ ] Lightbox / aspect-ratio view (vs. the mockup's simpler enlarge)
- [ ] Cost display + per-generation cost capture
- [ ] Narration kinds (`info | working | result | error`) — what survives the
      move from a narration feed to a chat sidebar?
- [ ] The spec-module set (palette / consistency / motifs / dos-donts) and
      `recreatePrompt` + `model` — map onto the v2 style-guide sections
- [ ] Snapshot/restore + session resumption (`open --restore`)
- [ ] Image optimization on ingest (downscale + WebP / sharp)
- [ ] Correct-vs-augment feedback framing
- [ ] Terminal-handoff banner / lean-state behavior

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

## Open Questions

- **B1** — imago handoff: hard context-switch vs. embedded view? (lean hard
  switch)
- **B2** — concrete artifact format across the glamour↔imago seam.
- **G1** — generated-image metadata: fixed schema vs. freeform? (lean fixed core
  - freeform extras)

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
- V1 rebuild design (to mine):
  `docs/projects/image-style-spell/glamour-rebuild-design.md`
- Co-presence: `docs/PROJECT_MANIFESTO.md` §2; `grimoire/house-style.md`
