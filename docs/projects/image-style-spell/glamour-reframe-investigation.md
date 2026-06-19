# Investigation: glamour — reframe as a method-spell in a composable suite

Status: **design-exploration** (recommendations + open forks; pre-spec) · Mode:
evaluative (what glamour _is_ vs. imago, where the boundary falls, how the
surface should behave) · Date: 2026-06-19

## Summary

This started as "transfer imago's persistent context library into glamour" and
opened into a more fundamental question: **as imago matured into a capable image
engine (canvas, layers, annotation, refs-as-assets, edit loop), is glamour
quietly on a path to re-implementing it?** The conclusion is that glamour should
**not** grow into a second image engine. Glamour and imago are different _kinds_
of spell:

- **Glamour is about the _style_.** It is a structured discovery method whose
  durable output is a re-castable **style guide + canonical images**. A
  generated image inside glamour is _evidence about a style_ — a probe you react
  to so the agent can refine its theory of what you're after.
- **Imago is about the _image_.** It is a general-purpose image workspace whose
  output is a _specific perfected image_. A generated image in imago _is the
  deliverable_ — you annotate, mask, layer, and edit it.

The key clarification that dissolves the duplication worry: **the shared
primitive is media-forge, not imago.** Both spells call the same generation tool
under the hood, so glamour generating illustrative probes is _not_ duplicating
imago. What glamour must not duplicate is the **canvas depth** — layers,
annotation, masking, edit-this-region, refs-as-assets. That is imago's exclusive
domain.

From that split, three further design questions followed (interaction model,
phase structure, and how spells hand off / compose). This document records the
recommendations where the conversation converged and flags the open forks.

**Throughout, one guardrail applies (the project's own rule):** _the newest
spell is the baseline, not the mandate._ Imago is the reference for what's
possible, not a template to clone. Glamour legitimately leans more structured
and sequential than imago, and the recommendations preserve that lean rather
than erasing it.

## Decision context

- **Decision A — ownership split.** What is irreducibly glamour once you
  subtract everything imago already does? → **Glamour owns the structured
  discovery method, structured preference-context on influences, lightweight
  probe generation, and the durable style-guide output. Imago owns the deep
  image workspace.**
- **Decision B — the handoff cutoff.** At what point does a glamour session hand
  off to imago? → **Intent, not capability: glamour holds the loop while you're
  _converging on the style_; the moment you want to _perfect one specific
  image_, you go to imago, and its result returns as a canonical image in the
  guide.**
- **Decision C — interaction model.** Keep per-phase text-input forms, or move
  to a conversation? → **A grounded conversation spine + select-to-ground
  (deixis), with the agent assembling the style guide as the shared work-object
  the human corrects. Phases supply ambient context, not walls.**
- **Decision D — phase structure.** Keep glamour's discrete forward-only phases?
  → **Recommended: phases as the _maturity of the artifact_, not _modes of the
  UI_ — one evolving workspace whose guide materializes as the conversation
  produces it. Conservative fallback: keep discrete phases but make them
  non-linear and revisitable.**
- **Decision E (deferred) — composition.** Should there be a general
  orchestration mechanism for "spells that work together"? → **Not now.
  Concrete-first: work the glamour↔imago seam for real; let the composition
  pattern (and any manifesto entry) extract only after it proves itself.**

**Drivers, in priority order:** (1) stop the duplication treadmill — don't let
glamour re-grow imago's canvas; (2) co-presence — both surfaces are shared
work-objects, not forms to submit; (3) preserve glamour's distinct identity (a
_method_ producing a _style_), don't homogenize it toward imago; (4) house-style
— self-contained spells, no cross-spell code imports, Bun-bundled,
agent-as-runtime; (5) concrete-first — earn the composition abstraction, don't
design it in the air.

## What the two spells actually are today

Grounded in architecture profiles of both (2026-06-18/19).

**Imago** — a Bun daemon holding `ImagoState`: batches (generations),
conversation messages, a **unified context library** (a `library` of
`ContextEntry` items, plus `activeContextIds` and non-destructive
archive/restore), per-variant marks and **layer containers** with undo/redo,
refs-as-assets. Three channels (WebSocket to the surface, SSE imperatives to the
agent, HTTP `/cmd` from the agent). A **conversation is the spine**; images are
artifacts keyed by variant; marks are durable metadata; the agent proposes and
the human reacts on the shared object. This is a mature co-presence workspace.

**Glamour** — a Bun daemon holding `GlamourState`: `influences` (each with
`aspects`, `starred`, `note`, `read`), `contexts`, `direction`, `prompts`,
`variants`, and a structured `spec` (toggleable modules: palette, consistency,
motifs, dos/donts). A **strict forward-only phase flow**
(`gather → analysis → direction → prompts → variants → spec`; `advancePhase()`
cannot go backward). Input is **per-phase text fields**; agent→human is a
**one-way narration feed** (explicitly "not a chat" per the rebuild design). No
persistent cross-session library — every session is an island. Generated
variants are inlined as base64 in the snapshot (bloat).

The overlap is the thin "generate variants and iterate" middle — and that is
exactly where glamour would keep absorbing imago features (annotate-to-steer,
edit-a-region) if left on its current path. That gradient is the thing this
reframe is meant to stop.

## Decision A — the ownership split

**Glamour owns:**

- The **structured discovery conversation** — the method that turns influences
  into a theory of the style.
- **Structured preference-context on influences** — "here's what I like about
  _this_ one; this is my favorite of the group." This is glamour's _native input
  affordance_ and the bones already exist (`starred`, `note`, `aspects` per
  influence). It should be **deepened in glamour and deliberately NOT grown in
  imago** — imago leaves this in chat because imago doesn't need a
  theory-of-style; glamour does.
- **Lightweight probe generation** — quick, disposable images via media-forge to
  test a direction. Not a canvas; a reaction surface.
- The **durable output** — the style guide + canonical images.

**Imago owns:** the deep image workspace — canvas, layers, annotation, masking,
edit-this-region, refs-as-assets — for perfecting a _specific_ image.

**Shared:** media-forge (the generation primitive) and the artifact library (the
interchange medium — see below).

## Decision B — the handoff cutoff (intent, not capability)

You are in glamour as long as you are **converging on the style**: probes,
reactions ("yes more like that / no, too saturated"), which edit the _style
guide_, not any single image. The handoff to imago triggers when intent shifts
to **perfecting one specific image** — annotate it, mask it, edit a region.
Imago's perfected result returns as a **canonical image** in glamour's guide.

Data flow across the seam:

- **Glamour → imago:** a style guide / direction (+ optional seed prompt or
  reference) — "generate within this established style."
- **Imago → glamour:** a perfected/canonical image (+ optionally a captured
  style) — lands in the guide as a canonical image or a confirmed style entry.

**Open question B1:** Is the handoff a hard context-switch (the agent opens an
imago session, you move there, you come back) or is there ever an _embedded_
imago view inside glamour? Recommendation leans hard switch (simplest, respects
self-contained spells); embedding is a much larger surface question. Flagged,
not decided.

**Open question B2:** What is the concrete artifact format on the wire? The
style guide already has structure (`understanding` + spec modules); imago's
library entries are `ContextEntry`. The seam likely reuses these, but the exact
mapping (a glamour spec module ⇄ an imago style entry) needs a concrete pass.

## Decision C — interaction model (grounded conversation, not forms)

The "old-app smell" is precisely the **submit-form-gated-to-a-stage**: a text
field you fill and send, valid only _now_, in _this_ phase. Phases providing
_context_ are not the smell; focus is fine.

The move splits into two separable capabilities — imago has both, glamour has
neither:

1. **Continuity** — one running conversation thread vs. per-phase snippets.
2. **Grounding (deixis)** — the ability to point at an object and say "_this_
   one," which kills the "is that what you're referring to?" problem.

A chat bar gives #1. It does **not** automatically give #2 — and #2 is the real
magic. So glamour needs a universal conversation **plus select-to-ground**:
click an influence (or your favorite, or a spec section) → your next message is
_about that_. The phase supplies _ambient_ context on top (imago's pattern: the
agent reads current focus/selection when its move comes).

Where the structured data then comes from: **not forms — the agent distills the
conversation into the style guide, and the human corrects it on the board.**
Today the human hand-keys fields per phase; in the co-presence model the agent
_assembles_ the artifact (direction, spec modules, canonical picks) from the
conversation, and the human watches it being built and corrects it directly. All
structure is retained; it just stops being hand-keyed into stage-gated forms.

**Open question C1:** Glamour's existing per-influence structured fields
(`starred`/`note`/`aspects`) are _good_ structured input — do those stay as
direct-manipulation affordances (click a star, type a note on the card)
alongside the conversation, or do they also become conversational? Likely
**both**: direct manipulation for the influence cards, conversation for
everything synthetic. Needs confirming.

## Decision D — phase structure (maturity, not mode)

**Recommended: phases as the maturity of the artifact.** One evolving workspace
the whole time; the "phases" become _how filled-in the style guide is_ —
sections that materialize as the conversation produces them:

- Start: intent + reference files; the guide is mostly empty.
- Talk + ground → the agent fills an **emerging understanding** (forming, not
  firm).
- Enough understanding → the agent proposes a **direction**; you correct it.
- Enough direction → generation becomes _useful_, so probes turn on (offered or
  asked). Never a gate you "reach" — an affordance that lights up when there's
  something worth probing.
- Reactions firm the direction → the agent crystallizes the **spec**.

You read "where am I" by **looking at the guide and seeing what's solid vs.
still fuzzy**, not from a stepper. The soft order doesn't vanish — it moves from
_UI-enforced_ to _agent-and-artifact-enforced_ (the agent sequences
conversationally: "I don't have enough yet to call a direction — tell me what's
pulling you about these refs first"). No forward-only walls; you can always drop
a new reference, revise direction, or generate more.

**Conservative fallback:** keep discrete phases but make them **non-linear and
revisitable** — same screens, no walls. Lower-risk, but it leaves the
form-per-screen shape mostly intact, so it only partially addresses Decision C.

**Caveat (the guardrail):** even in the maturity model, glamour keeps a _defined
shape_ the guide grows into (understanding → direction → spec sections). That
structure is glamour's identity. We're changing _how you move through it_, not
deleting it. This is where glamour stays deliberately more structured than
imago.

**Open question D1:** Does the maturity model risk the human feeling _lost_
without an explicit "what do I do next" cue? The mitigation is the agent's
conversational sequencing + a visibly-incomplete guide, but this is the biggest
UX risk of the recommended option and should be prototyped before committing.

## The library question, revisited

The original prompt — "give glamour a persistent context library" — resolves
into something larger: the persistent library is plausibly the **interchange
medium between spells**, a durable store of reusable artifacts (styles,
canonical images, contexts) any spell can read and write. Glamour's style guide
→ an imago context-library style; an imago canonical image → a glamour
influence. So the original instinct wasn't wrong; it was one spell's view of a
shared concept.

**Open question L1:** Does the shared library live as a real cross-spell store
(a new shared concept, with its own home and ownership), or does each spell keep
its own library and the _agent_ shuttles artifacts between them at handoff time?
The latter is more consistent with self-contained spells + agent-as-runtime and
is the recommended starting point; a genuinely shared store is a bigger
architectural commitment to earn later.

## Decision E (deferred) — composition / "super spells"

The broader idea — a suite of specialized spells that work together without
duplicating functionality, cast as a coordinated "working" — is real and
probably **manifesto-level** (it extends §8 "how many at the table?" and the
parked `liaison` concept from _multiple agents/humans at one board_ to _multiple
boards in one working_). But the key realization keeps it from needing new
machinery now: **composition lives at the agent layer, not the code layer.**
Spells stay self-contained zip-and-run surfaces with no cross-spell imports; the
agent is the runtime that casts several and shuttles artifacts between them. A
"super spell" is the agent running a _play_ across surfaces.

Per driver (5), we **earn** this by doing glamour↔imago concretely first. The
composition pattern, its manifesto entry, and whatever it's named (candidates
floated: a _working_, a _rite_, a _circle_) extract only after the concrete seam
proves them.

## Consolidated open questions

- **B1** — handoff: hard context-switch vs. embedded imago view? (lean hard
  switch)
- **B2** — concrete artifact format across the glamour↔imago seam (spec module ⇄
  style entry mapping).
- **C1** — do per-influence structured fields stay as direct manipulation
  alongside the conversation? (lean both)
- **D1** — does the maturity model leave the human without a "what next" cue?
  (biggest UX risk; prototype it)
- **L1** — shared cross-spell library vs. per-spell + agent-shuttled handoff?
  (lean per-spell + shuttle to start)

## Recommended next step

The cheapest way to de-risk the recommended direction is a **scrappy throwaway
mockup** of the maturity-model glamour surface (conversation spine + grounded
selection + a living style guide that fills in), to feel the D1 risk before
committing — exactly the role the earlier imago canvas mockup played. After
that, a focused spec on the first concrete slice (most likely: the
grounded-conversation + assembled-guide core, _not_ the full bundle), with the
glamour↔imago handoff specced as its own follow-on once B1/B2 are settled.

## References

- Glamour rebuild design (the deliberate V1 exclusions this revisits):
  `docs/projects/image-style-spell/glamour-rebuild-design.md`
- Imago unified context library (the library model + non-destructive
  archive/restore lesson):
  `docs/backlog/2026-06-16-imago-unified-context-library.md`
- Co-presence (the shared-workspace shape this applies):
  `docs/PROJECT_MANIFESTO.md` §2; `grimoire/house-style.md` (shared-workspace
  rule)
- Architecture profiles of imago + glamour: this session (2026-06-18/19)
