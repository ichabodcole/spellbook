---
type: item
title: Update project-docs from scaffold 9.0.0 to 9.1.0
description:
  Refresh the delivered pdocs layer, templates and version markers to scaffold
  9.1.0 (plugin 4.1.0); no structural migration applies to a v3.0 tree, but the
  new placeholder lint may report findings.
status: draft # OKF §5.4: draft | stable | deprecated. Nothing else.
lifecycle: done
id: 01a0e4e1-e70f-7198-8059-692fed0c06d8
kind: chore
generated: { by: claude-opus-5-5, at: 2026-09-27 }
---

# Update project-docs from scaffold 9.0.0 to 9.1.0

The docs tree is on scaffold **9.0.0** (`.project-docs.json`, `docs/README.md`),
from the v2.10 → v3.0 migration landed 2026-09-26. The latest is **9.1.0**
(2026-09-27), shipped with plugin **project-docs 4.1.0**.

**What changed upstream:**

- **9.0.1** (fixes): `pdocs new`, `set` and `find` write what consumers expect,
  and **the lint now reports placeholders**; the v3.0 migration handles what
  Spellbook hit during our own migration; `finalize-branch` catches SHAs cited
  in the session, commits a dirty tree and formats docs.
- **9.1.0**: plugin 4.1.0; the v3.0 migration installs scaffold 9.0.1.

**Expected size: small.** No migration row in the 4.1.0 `update-project-docs`
skill applies to a tree already on v3.0 (its last row, `v2.10-to-v3.0`, tests
for `docs/backlog` / `docs/projects`, both gone). So this is a refresh of what
the scaffold owns, not a structural migration.

## Definition of done

- [x] The refresh path is established from the 4.1.0 skill, not guessed: how a
      v3.0 tree takes a newer scaffold's owned `scripts/pdocs/` layer and
      templates (the skill notes a layer refresh is `v2.8-to-v2.9`'s job;
      confirm whether that still holds, or whether 4.1.0 names another path).
      Dry-run first.
- [x] `scripts/pdocs/` and `docs/TEMPLATES` match scaffold 9.1.0; nothing of
      ours inside them is lost (diff before and after).
- [x] Both version markers read `9.1.0` and agree (the skill's Step 5).
- [x] The skill's Step 6 (root-level conventions) and Step 7 (verify) are run
      and their output read.
- [x] Whatever the new placeholder lint reports is fixed or, if it is the
      scaffold's own text, reported upstream; `pdocs check` is clean.
- [x] `bun run gate` is green (the golden and acc wards do not read docs, but
      the gate includes `pdocs check`).
- [x] Friction with the migration is reported to the scaffold repo (issues are
      how that team hears; 9.0.1 already fixed what we hit last time).

## Done (2026-09-27)

Landed in `67198fd4`.

- **The refresh path:** re-running `migrate-v2.10-to-v3.0.ts` from plugin 4.1.0
  on our v3.0 tree. Its preflight accepts the tree; with nothing left to move it
  only refreshes what the scaffold owns (it now fetches scaffold 9.0.1). Dry run
  first: 0 moves, 0 links, 1 owned file flagged.
- **Written:** 6 files under `scripts/pdocs/`, `docs/SCHEMA.md`,
  `docs/features/README.md`, `docs/cycles/TEMPLATE.md` (seeded, updated), and
  `docs/.pdocs-seed.json` (two stale records for our PROJECT-LEDGER and
  SPRINT-OUTCOME templates dropped: the scaffold never shipped them). Nothing of
  ours was lost.
- **9.1.0, not 9.0.1:** the script sets the markers to the scaffold it
  installed, 9.0.1. Scaffold 9.1.0 differs from 9.0.1 only in three version
  strings (both markers and the CLI's `VERSION`), checked with
  `gh api …/compare`, so those three were set to 9.1.0 by hand and the tree
  matches 9.1.0 byte for byte.
- **Placeholder lint:** one real finding, fixed: the acc cycle's session record
  still carried the template's `tags: [area, feature]`.
- **Step 6:** docs pointer and Branch Landing Policy present. **The
  Documentation CLI pointer was missing** from root `AGENTS.md` (it never
  mentioned `pdocs`); recommended to Cole per the skill, and added on his
  go-ahead as `## Documentation CLI`.
- **Step 7:** CLI answers `9.1.0`, `pdocs check` clean, no shipped tests, no
  tsconfig reach, biome and prettier leave `scripts/pdocs/` alone. Gate: 2993
  pass, 0 fail.

**Friction reported upstream** on Cole's go-ahead, 2026-09-27, as
[ichabodcole/project-docs-scaffold-template#182](https://github.com/ichabodcole/project-docs-scaffold-template/issues/182):
the Plan phase called `docs/SCHEMA.md` "edits of yours" though it is
byte-identical to scaffold 9.0.0's; there is no row for refreshing a v3.0 tree
to a newer patch; and nothing but the optional Step 6 row prompts a project to
point its root agent file at the CLI (Cole's addition).
