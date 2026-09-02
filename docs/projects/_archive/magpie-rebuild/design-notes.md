# Magpie rebuild — design notes

**Date:** 2026-06-25 · **Origin:** surfaced live during the glamour-v2 dogfood,
when we orchestrated glamour → imago (annotate) → glamour → magpie (extract) on
the Bounty brand board and hit magpie's limits.

## The realization

Magpie was built **before** the modern Spellbook architecture (the daemon +
interactive surface + grounded-conversation pattern that glamour and imago now
share). It's currently a **two-step Python CLI** (`discover.py` → `extract.py`)
that emits a **static `gallery.html`**. That's fine for a one-shot, but it has
**no interactive surface** — no way for the user to talk to the agent about
what's working and what isn't, in the loop. Working through real extraction made
the gap obvious: magpie needs to be **built out** into a proper conjuration,
likely as its own effort.

## The suite thesis (made explicit)

Each app is built around **a type of conversation** — what you're talking about
— and the app's job is to provide the best communication channel + surface for
that conversation. The three are stages of one production pipeline AND three
distinct conversation modes:

- **imago** — _make / edit one image._ Working a single image deeply: generate,
  focus, mark, edit. Conversation = "let's get THIS image right."
- **glamour** — _discuss images & style._ A broad palette of references,
  defining a re-castable style/brand. Conversation = "what's the style, across
  many things."
- **magpie** — _extract & generate assets._ Further down the pipeline: "I have a
  composite (a brand board, a sheet) — pull one or more assets out of it, judge
  what looks good, fix what doesn't, compare model results." Conversation =
  "break this into clean, usable assets."

Magpie is the only one of the three that doesn't yet have its conversation
surface. That's the rebuild.

## What magpie's surface needs (the patterns, extraction-specific)

The same conjuration patterns as the others, specialized for extraction:

1. **Bring an image in** → the agent proposes the element breakdown (today's
   `discover` step, but live and reviewable on a canvas, not a JSON the user
   hand-edits).
2. **Select / communicate what to pull out** — confirm, drop, rename, re-type
   elements interactively; mark regions the discovery missed.
3. **Review extracted assets + judge per asset** — "this one's good, this one's
   not working" (a per-asset good/redo signal, like imago's marks but about
   extraction quality).
4. **Compare model results side by side** — the bake-off we did by hand (rembg
   vs Bria vs Ideogram, multiple backdrops) should be a first-class surface
   affordance, with **per-asset / per-type model choice**.
5. **Selective retry** — keep the assets that already work (don't regenerate),
   and re-run only the failing ones with a different model or settings. The unit
   of iteration is the individual asset, not the whole sheet.

## Technical findings from this dogfood (feed the rebuild)

- **Generative isolation vs. true crop.** nano-banana "reproduce just the logo"
  is _generative_ (drifts); magpie is _true pixel extraction_. Magpie's reason
  to exist is fidelity — preserve the real pixels. Keep that as the core;
  generative re-isolation is a fallback, not the product.
- **Removal backend should be pluggable.** Bake-off result: rembg vs media-forge
  (Bria/Ideogram) is _comparable with tradeoffs_ — media-forge edged out on the
  mascot/stickers/icons; **rembg held the flat wordmarks** (Bria tended to leave
  a dark backing). So: keep magpie's Gemini discovery, make the **removal step a
  pluggable backend** chosen per type/per asset (rembg | Bria | Ideogram | …),
  not a wholesale swap. Same "bridge the suite" logic as glamour↔media-forge.
- **Crop padding is a real bug.** When a discovered bbox hugs the object too
  tightly, the removal model has **no border context** to find the edge, and
  removal fails or leaves fringe. Magpie should **pad the bbox** before removal
  (and expose padding as a control). This is a concrete near-term fix to
  `extract.py` even before the full rebuild.
- **Backdrop matters for judging.** Cutout quality only reads against contrast —
  the surface should let you flip the asset over white / gray / black /
  transparent (we bolted this onto the comparison gallery; it should be native).
- **Static gallery → live surface.** The `gallery.html` is review-only; the
  rebuild replaces it with an interactive canvas + conversation.

## Connections

- **Bridge the suite, don't rebuild capability:** magpie ↔ media-forge
  (removal + maybe generative fill for under-padded crops); glamour ↔ magpie
  (the "open in magpie / extract assets" handoff, like the glamour↔imago handoff
  we tested).
- **Multi-agent:** the model-compare + selective-retry grunt work is exactly the
  production-agent work the lead would delegate (see the dogfood-notes
  architecture-direction entry) — the human + lead judge "good/redo"; a worker
  runs the re-cuts.

## Status / next

- **Its own project** — magpie rebuild = a conjuration with an extraction
  conversation surface. Warrants a proper proposal/plan (this note is the seed).
- **Near-term wins (pre-rebuild, cheap):** (1) pad bboxes before removal in
  `extract.py`; (2) make the removal backend pluggable (add media-forge Bria/
  Ideogram as options alongside rembg); (3) native backdrop toggle in the
  gallery. These improve magpie today without waiting for the full surface.
