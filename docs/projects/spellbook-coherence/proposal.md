# Spellbook Coherence Pass — make the migrated set production-coherent

**Status:** Draft **Created:** 2026-05-29 **Author:** Cole Reed (with familiar)

---

## Overview

The four spells are migrated, typed, and green (see
[spellbook-extraction](../spellbook-extraction/proposal.md)). But they were
brought over as-is, and the migration + the fresh-agent dogfood
([findings](../../../grimoire/fresh-agent/2026-05-29-inscribe-ward-findings.md))
surfaced gaps between "the code runs" and "the set feels coherent and meets the
standards we've since written." This project closes those gaps before a release.

## Problem Statement

The spells predate the grimoire's conventions and Spellbook's tooling, so
several things are now inconsistent with the standards they ought to meet — and
a couple of structural questions (magpie's runtime, the type-check gate) only
became answerable once real spells were in the repo.

## Scope

1. **Feedback touchpoints (house-style requirement).** Only digestify has a
   feedback touchpoint (re-pointed to this repo during migration). grapevine,
   bounty, and magpie lack one. Add the structured touchpoint to each `SKILL.md`
   (agent friction + human-surface prompt where applicable), routed to GitHub
   issues against this repo. Per `grimoire/house-style.md` → "Every spell ships
   a feedback touchpoint."
2. **Magpie's interface.** Magpie is headless Python (`discover.py` /
   `extract.py` via Gemini/OpenRouter) — not a Bun surface. Per the "abstract
   over tools so the agent focuses on one thing" principle, evaluate a thin Bun
   front that orchestrates the Python behind one interface (vs. leaving it as a
   documented Python CLI). Outcome also nuances the house-style "keep the client
   thin / Bun-served" rule → _Bun-first, may orchestrate other runtimes behind
   one interface._
3. **Stand up the `tsc --noEmit` typecheck gate.** Deferred until spells
   existed; they do now. Adding it will surface pre-existing strict-mode errors
   (e.g. `noUncheckedIndexedAccess` on `m[1]`, lib-name issues) the migration
   typing pass left out of scope. Decide the strictness, fix or scope the
   findings, and wire it into the `check` script + pre-commit gate.
4. **Validate-or-trim the seed grimoire rules.** The `(seed)` rows in
   `grimoire/decay-ledger.md` were written before any spell existed here. Now
   they can be checked against real spells — the subtraction pass per "Start
   minimal; subtract before you test." Keep what the spells actually walk; trim
   what they don't.

## Out of Scope

- The **rebrand** ([spellbook-rebrand](../spellbook-rebrand/proposal.md)) —
  separate pre-release chapter.
- The **wand** and **publishable spell-creator** (post-release fragments).

## Impact & Risks

**Benefits:** the migrated set meets its own standards; magpie stops being the
odd-one-out; the type gate catches a class of bugs the lint gate can't; the
grimoire stops carrying unvalidated rules.

**Risks:** low. The touchpoints + grimoire trim are mechanical; the magpie
interface and tsc strictness are the two judgment calls.

**Complexity:** Low–Medium (item 2 and item 3's strictness are the only real
decisions).

## Open Questions

- Magpie: thin Bun wrapper, or leave it a documented Python CLI?
- How strict should the `tsc` gate be (full strict vs. a pragmatic subset)?

---

**Related Documents:**

- [spellbook-extraction proposal](../spellbook-extraction/proposal.md)
- [fresh-agent findings (inscribe + ward)](../../../grimoire/fresh-agent/2026-05-29-inscribe-ward-findings.md)
- `grimoire/house-style.md`, `grimoire/decay-ledger.md`
