---
type: item
title: Update project-docs from scaffold 9.0.0 to 9.1.0
description:
  Refresh the delivered pdocs layer, templates and version markers to scaffold
  9.1.0 (plugin 4.1.0); no structural migration applies to a v3.0 tree, but the
  new placeholder lint may report findings.
status: draft # OKF §5.4: draft | stable | deprecated. Nothing else.
lifecycle: ready
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

- [ ] The refresh path is established from the 4.1.0 skill, not guessed: how a
      v3.0 tree takes a newer scaffold's owned `scripts/pdocs/` layer and
      templates (the skill notes a layer refresh is `v2.8-to-v2.9`'s job;
      confirm whether that still holds, or whether 4.1.0 names another path).
      Dry-run first.
- [ ] `scripts/pdocs/` and `docs/TEMPLATES` match scaffold 9.1.0; nothing of
      ours inside them is lost (diff before and after).
- [ ] Both version markers read `9.1.0` and agree (the skill's Step 5).
- [ ] The skill's Step 6 (root-level conventions) and Step 7 (verify) are run
      and their output read.
- [ ] Whatever the new placeholder lint reports is fixed or, if it is the
      scaffold's own text, reported upstream; `pdocs check` is clean.
- [ ] `bun run gate` is green (the golden and acc wards do not read docs, but
      the gate includes `pdocs check`).
- [ ] Friction with the migration is reported to the scaffold repo (issues are
      how that team hears; 9.0.1 already fixed what we hit last time).
