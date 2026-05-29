# Spellbook Rebrand — unify the spells under one cute-occult aesthetic

**Status:** Draft **Created:** 2026-05-29 **Author:** Cole Reed (with familiar)

---

## Overview

The spells were built independently, each with its own name and mascot. For the
collection to read as _one spellbook_ rather than a themed toolbox, they should
share a cohesive identity. This is a **pre-release** chapter — renames are
cheapest now (single user, no install equity). Graduated from
[the aesthetic fragment](../../fragments/2026-05-29-spellbook-aesthetic-and-rebrand.md),
which holds the fuller exploration.

## Problem Statement

Four disparate names and mascots don't add up to a spellbook. Cohesion is the
product here — the parts need to feel like spells from the same book.

## Proposed Solution

A unifying **cute-occult** aesthetic — anime witches; warm, playful, a little
adorable, but the occultishness genuinely comes through; **light, not dark**. A
cozy grimoire that contains real magic. (Full north-star description in the
fragment.) Applied along three fronts:

- **Names:** evaluate each spell for a spell-native name. Initial read —
  `grapevine` is the closest fit (a whisper/scrying web, keep); `digestify` and
  `tuskboard` are the utilitarian puns most likely to want renaming; `magpie`
  reads as a fetching familiar.
- **Mascots:** unify art style + palette (and decide reuse-existing vs.
  retheme).
- **Cohesion motif:** a shared visual language (palette, type, sigil/motif) so
  any spell's surface is recognizably from the same book.

## Scope

**In scope:** the aesthetic direction (lock it), per-spell rename decisions,
mascot/identity unification plan.

**Out of scope (until decided here):** the actual implementation — renaming
(registry-first), regenerating mascots, restyling surfaces — which follows once
the direction is set.

## Impact & Risks

**Benefits:** the collection finally reads as a spellbook; cohesive identity
before release equity locks names in.

**Risks:** renames are **mechanic-touching** — the name is the trigger
(`grimoire/trigger-registry.md`), the folder name, the `${CLAUDE_PLUGIN_ROOT}`
path, and the future `wand` argument. Do renames **registry-first** and before
release. (Detail in the fragment's "Cost / caution.")

**Complexity:** Medium — mostly design/decision; the rename mechanics are
straightforward but must be done deliberately.

## Open Questions

- Which spells actually get renamed, and to what?
- Reuse existing mascots in a unified style, or retheme them?
- Does the aesthetic graduate into the manifesto's Design Philosophy section?

---

**Related Documents:**

- [Aesthetic + rebrand fragment](../../fragments/2026-05-29-spellbook-aesthetic-and-rebrand.md)
  (origin + full exploration)
- `grimoire/trigger-registry.md` (renames are registry-first)
- `docs/PROJECT_MANIFESTO.md` (§2 "why spells"; naming-is-the-mechanic)

---

## Notes

We can design this with our own tools: **magpie** to pull elements from a
moodboard, **html-mockup-prototyping** to mock the unified look, a moodboard to
seed regenerated mascots. The spellbook helps brand itself.
