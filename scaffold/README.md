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

- ⛔ **Follow
  [`docs/playbooks/scaffolding-a-spell-playbook.md`](../docs/playbooks/scaffolding-a-spell-playbook.md)**
  — register item **F1**, the derivation this directory's plan asks for, written
  2026-09-10 from all eight spells.
- ⛔ **Do NOT clone a spell and read its skill folder for the structure.** This
  section used to say _"the tell: a conjuration ships a `daemon.ts`/`server.ts`,
  a cantrip doesn't"_, and **that tell is false of all eight spells** since the
  backend convergence closed (2026-09-09): what ships at
  `plugins/spellbook/skills/<spell>/scripts/` is a **launcher** either way —
  three code lines importing a built artifact — and the spell itself is authored
  at `src/<spell>/{backend,surface}/`. The kind decides none of the structure.
- **Read `grimoire/house-style.md`** for the conventions.
- The **`agent-surface-bun` recipe** (in project-docs) is the canonical
  shared-shape reference — the three-actor model, the cantrip/duplex variants,
  and the Bun gotchas — until its substance graduates here.

**What a template tree here would still have to generate**, and the condition
for writing it, are ruled in
[`docs/projects/scaffolding-a-spell/decision-log.md`](../docs/projects/scaffolding-a-spell/decision-log.md)
(**S3**): not yet — the condition is one real spell walking the playbook and
reporting which steps were mechanical.

See `docs/projects/spellbook-extraction/proposal.md` for the sequencing, and
`docs/fragments/2026-05-29-publishable-spell-creator.md` for where a shippable
scaffold could eventually go.
