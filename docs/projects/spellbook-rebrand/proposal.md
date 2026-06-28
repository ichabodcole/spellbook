# Spellbook Rebrand — unify the spells under one cute-occult aesthetic

**Status:** In Progress (Naming Complete — tuskboard → bounty shipped; Visual
Cohesion Deferred) **Created:** 2026-05-29 **Updated:** 2026-06-27 **Author:**
Cole Reed (with familiar)

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

- **Names:** evaluate each spell for a spell-native name. Resolved so far —
  `grapevine` (a whisper/scrying web), `magpie` (a fetching familiar), and
  `digestify` are all **kept**: they already read as spells you cast.
  `tuskboard` was the one outlier — it named the furniture, not the spell — and
  is renamed to `bounty` (done; see Decisions Log). No further renames are
  planned unless a spell's name later proves a poor fit.
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

## Decisions Log

- **2026-05-30 — `tuskboard` → `bounty` (done).** First rename executed. The old
  name was a pun on the furniture (a task _board_ with a mammoth tusk), which
  read as an object rather than a spell. `bounty` (a bounty board) is the
  D&D-native name for an assignable task board whose entries move through stages
  — assignment and flow are baked into the metaphor, and it sits cleanly beside
  `grapevine`/`magpie`. Done registry-first per the risk note: trigger-registry,
  marketplace tags, spell tables, folder, and all `${CLAUDE_PLUGIN_ROOT}` paths
  updated; 28 tests green. Shipped together with a new **Review** column (a soft
  human-verification gate) on the board. Mascot/visual identity (the mammoth) is
  untouched — folded into the mascot front below.
- **2026-05-30 — keep `digestify`, `grapevine`, `magpie` (no rename).** The
  remaining three names already read as spells you cast ("cast digestify,"
  "summon a grapevine"). `digestify` was briefly flagged as a utilitarian pun,
  but it names the _act_ (digest → a reading/divination surface), not the
  furniture, so it stays. The name front of the rebrand is now **closed** unless
  a name later proves a poor fit in use; remaining rebrand work is purely
  mascot/visual cohesion.

## Open Questions

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
