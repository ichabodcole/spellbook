# Publishing the ability to create spells (a shippable spell-creator)

**Date:** 2026-05-29 **Tone:** Type 2 (curiosity / "probably valuable, not ready
yet") **Status:** captured spark, not yet a project

## Context

The marketplace publishes the spells, but not the ability to _make_ one —
`inscribe` is a repo-dev skill, deliberately not shipped. Cole likes the idea of
also publishing a **spell-creator** so a user, in any project, can create a
spell where they are, then merge it back into the Spellbook repo when it's
proven and generalizable enough.

## The idea

A shippable skill — the inscriber / spell-creator — that carries the creation
methodology, starter templates, and scaffolding code (and maybe its own HTML
surface) so anyone can go problem → prototype → spell without this repo. The
ability to _create_ spells is itself a capability the marketplace can share —
aligned with, but distinct from, the spells themselves.

The cross-project flow: "I have an idea for a spell" → make it in-place in
whatever project you're in → upstream it into Spellbook (a PR) when it earns its
keep. Sharing the **craft**, not just the artifacts.

## Open

- Is it `inscribe` published, or a separate skill? `inscribe` is the seed — the
  repo-dev version of exactly this methodology.
- Does it need its own surface (an HTML spell-creation UI)?
- The merge-back workflow — how a spell born elsewhere comes home.
- It depends on the **scaffold** existing (you need templates to ship) — so this
  is downstream of the migration + scaffold derivation.

## Trigger for revisit

After the spells migrate and a real `scaffold/` exists. Cole: "not sure I'm
ready to do that yet." Graduate to a project when ready.

## Related

- `.claude/skills/inscribe/SKILL.md` — the repo-dev seed of this.
- `docs/fragments/2026-05-29-the-wand-mage-cli.md` — sibling "share a
  capability" idea (the mage's instrument).
- `scaffold/` — the templates a shippable creator would carry.
