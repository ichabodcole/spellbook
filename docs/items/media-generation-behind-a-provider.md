---
type: item
title: Image generation sits behind a provider anyone can supply
description:
  imago and glamour call media-forge's CLI directly; find how coupled they are,
  and whether a provider interface would let someone plug in another image
  service (fal.ai or their own) instead.
status: draft
lifecycle: triage
id: 01a1794b-420b-773f-bf08-e462b7a8c707
kind: research
generated: { by: claude-opus-5-5, at: 2026-10-26 }
---

# Image generation sits behind a provider anyone can supply

Cole, 2026-10-26, while ruling on the 6.0.0 README: media-forge is his own image
service and he will keep using it, but the spells should not be coupled to it.
Someone else should be able to plug in their own generation service (fal.ai
directly, or anything with the capabilities) as a plugin or extension, the way a
provider conforms to an interface.

The question: how coupled are the spells to media-forge today, and what would a
provider interface look like that media-forge is one implementation of? The
answer feeds whether to build that seam, and where.

A first look (2026-10-26, not yet the investigation):

- imago's and glamour's servers do not call media-forge. Generation happens on
  the agent's side, so the coupling is mostly in the instructions:
  `glamour/SKILL.md` (11 mentions), `imago/SKILL.md` (5) and
  `imago/references/mediaforge.md`, which tell the agent to run the
  `media-forge` CLI. glamour's `gen` verb takes the image the agent made.
- magpie already has a seam of this shape: `src/magpie/backend/backend.ts`
  defines a background-removal backend contract with a registry, a live `rembg`
  implementation and a media-forge stub.
- The README says media-forge isn't published yet, so today imago and glamour
  cannot generate for anyone but Cole.

## Definition of done

- [ ] Every place a spell depends on media-forge is listed, code and
      instructions, with what each needs from it (generate, edit, background
      removal, models).
- [ ] A recommendation: whether a provider interface is worth building, what it
      would cover, and where it would live (the kit, each spell, or the agent's
      instructions), with magpie's backend registry weighed as a precedent.
