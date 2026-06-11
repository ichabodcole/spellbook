# Scaffold

The canonical starting material for a new spell — **not yet written, on
purpose.**

The plan is to _derive_ this from the spells, not pre-write it. Once the toolbox
spells are ported into `plugins/spellbook/skills/`, look across them for the
genuinely common patterns and consolidate those into starter templates here (a
cantrip skeleton, a conjuration skeleton — or whatever the real overlap turns
out to be). Writing it before the migration is guessing at a shape we haven't
seen.

**To start a spell today** (until this exists):

- **Clone an existing spell** of the matching kind from
  `plugins/spellbook/skills/` — the tell: a conjuration ships a
  `daemon.ts`/`server.ts`, a cantrip doesn't. The reference spells _are_ the
  templates for now.
- **Read `grimoire/house-style.md`** for the conventions.
- The **`agent-surface-bun` recipe** (in project-docs) is the canonical
  shared-shape reference — the three-actor model, the cantrip/duplex variants,
  and the Bun gotchas — until its substance graduates here.

See `docs/projects/spellbook-extraction/proposal.md` for the sequencing, and
`docs/fragments/2026-05-29-publishable-spell-creator.md` for where a shippable
scaffold could eventually go.
