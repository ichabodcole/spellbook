---
type: item
title: Upgrade project-docs to the release after scaffold 9.1.0
description:
  Take the project-docs release Cole is cutting now (after scaffold 9.1.0 /
  plugin 4.1.0); expected to carry more than version strings, so possibly its
  own cycle.
status: stable
lifecycle: done
id: 01a0e95a-e614-763c-85d4-2aeecc8f817e
kind: chore
generated: { by: claude-opus-5-5, at: 2026-09-28 }
cycle: 2026-09-project-docs-next-release
---

# Upgrade project-docs to the release after scaffold 9.1.0

Cole is cutting a new project-docs release on 2026-09-28. We are on scaffold
**9.1.0** (plugin 4.1.0), refreshed the day before
([item/project-docs-9.1-refresh](project-docs-9.1-refresh.md)). Cole expects
this release to carry real changes, not only version strings, so it may want a
cycle of its own. Scope it once the release notes are out.

## Definition of done

- [x] Read the release notes and the new `update-project-docs` skill. Find out
      whether a migration row applies, or whether this is another owned-file
      refresh (re-running the latest migration script, as for 9.1.0).
- [x] Dry-run first. Compare the diff of `scripts/pdocs/`, the templates and the
      seeded docs against the scaffold, and make sure nothing of ours is lost.
- [x] Both version markers name the new release and agree.
- [x] Run the skill's Step 6 (root conventions) and Step 7 (verify), and read
      their output.
- [x] `pdocs check` is clean and `bun run gate` is green.
- [x] Check whether it answers
      [scaffold #182](https://github.com/ichabodcole/project-docs-scaffold-template/issues/182):
      the false "edits of yours" flag, no documented path for refreshing a
      migrated tree to a newer patch, and no prompt to point the root
      `AGENTS.md` at the CLI. Report whatever still bites.

## Notes from the last refresh

- The 9.1.0 migration script stamped the scaffold it fetched (9.0.1), not the
  release being adopted. We set the three version strings by hand.
- The new placeholder lint found one real finding in our docs.
- Land by fast-forward or a named merge; the item cites shas.

**Also to report upstream (2026-09-28):** `pdocs check` passes a frontmatter
with a duplicate key. `started:` appeared twice in
`docs/cycles/2026-09-scriptorium-from-real-use-2.md`, and a fresh agent reading
the tree caught it where the lint did not.

## Done (2026-10-02)

Adopted scaffold **9.4.0** (plugin 4.4.0) in `074560b5`; Cole approved this
item's content the same day.

- **Case 3** of the 4.4.0 skill: behind, no migration row applies. Re-ran
  `migrate-v2.10-to-v3.0.ts`, dry run first (0 moves). It refreshed
  `scripts/pdocs/` and the owned READMEs and `SCHEMA.md`, updated 15 unedited
  seeded templates, added `cycles/_archive/`, and set both markers to 9.4.0
  itself (no hand edit this time). The lines removed from owned READMEs are the
  scaffold's own rewording.
- Step 6: all three root conventions satisfied. Step 7: CLI answers `9.4.0`, no
  shipped tests, no tsconfig reach, biome and prettier leave `scripts/pdocs/`
  alone. The pre-commit hook already runs `pdocs check`. `pdocs check` clean;
  gate 3199 pass, 0 fail.
- [Scaffold #182](https://github.com/ichabodcole/project-docs-scaffold-template/issues/182)
  is closed, and none of its three complaints recurred.
- **Still bites:** a duplicate frontmatter key passes `pdocs check`. Probed with
  `lifecycle:` twice: `docs-lint: clean`. Reported on Cole's go-ahead as
  [scaffold #190](https://github.com/ichabodcole/project-docs-scaffold-template/issues/190).
