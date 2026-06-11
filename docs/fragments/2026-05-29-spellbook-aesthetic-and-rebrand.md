# Spellbook aesthetic + thematic rebrand

**Date:** 2026-05-29 **Tone:** Type 2 (curiosity / "probably want this") — a
pre-release consideration **Status:** graduated to
`docs/projects/spellbook-rebrand/` (2026-05-29) — this fragment holds the fuller
aesthetic exploration the proposal references

## Context

The spells were built independently, each with its own name and mascot
(digestify, grapevine, tuskboard's mammoth, magpie's bird). Cole wants to
consider — possibly **before the first release** — whether they should share a
cohesive identity so the collection reads as _one spellbook_ rather than four
unrelated tools.

## The aesthetic (north star)

**Cute-occult.** Anime witches; warm, playful, a little adorable — but the
occultishness genuinely comes through. **Light, not dark** — not grimdark, not
death-metal. A cozy grimoire that happens to contain real magic. Fun first, with
a real thread of the arcane underneath.

This could become the manifesto's Design Philosophy section once it settles.

## The questions

- **Rename?** Do the tools have spellbook-native equivalents?
  - `grapevine` — "the vine," whispers-through-the-network; already mildly
    arcane (a scrying / whisper web). Probably the closest fit as-is.
  - `digestify` — utilitarian, least spell-y. It's a reading/divination surface;
    could become something more incantatory.
  - `tuskboard` — mammoth pun on taskboard; cute but not witchy.
  - `magpie` — a collector of shiny things (the asset-extractor); reads as a
    fetching familiar more than a spell.
- **Mascots:** keep each mascot but unify the art style/palette, or retheme
  them?
- **Cohesion mechanism:** a shared palette + type + motif (sigils? a consistent
  familiar?) so any spell's surface is recognizably from the same book.

## Cost / caution

Renaming is **mechanic-touching**: the name is the trigger
(`grimoire/trigger-registry.md`), the folder name, the `${CLAUDE_PLUGIN_ROOT}`
path, and the future `wand` argument. A rename touches all of those — do it
deliberately, **registry-first**, and **before release equity builds.** That's
why this is a pre-release item.

## Fun recursion

We have the tools to design this with: **magpie** pulls elements out of a
moodboard, **html-mockup-prototyping** can mock the unified look, and a
moodboard could seed regenerated mascots. The spellbook can help brand itself.

## Trigger for revisit

Before the first release. Pairs with the coherence pass (feedback touchpoints,
magpie's shape). Likely graduates to its own project
(`docs/projects/spellbook-rebrand/` or an interaction-design / brand doc) when
tackled.

## Related

- `grimoire/trigger-registry.md` — renames are registry-first.
- `docs/PROJECT_MANIFESTO.md` — §2 "why spells" + naming-is-the-mechanic; a
  Design Philosophy section could absorb the aesthetic.
- `docs/fragments/2026-05-29-the-wand-mage-cli.md`,
  `docs/fragments/2026-05-29-publishable-spell-creator.md` — sibling future
  directions.
