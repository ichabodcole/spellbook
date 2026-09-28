---
type: item
title: Upgrade project-docs to the release after scaffold 9.1.0
description:
  Take the project-docs release Cole is cutting now (after scaffold 9.1.0 /
  plugin 4.1.0); expected to carry more than version strings, so possibly its
  own cycle.
status: draft
lifecycle: backlog
id: 01a0e95a-e614-763c-85d4-2aeecc8f817e
kind: chore
generated: { by: claude-opus-5-5, at: 2026-09-28 }
---

# Upgrade project-docs to the release after scaffold 9.1.0

Cole is cutting a new project-docs release on 2026-09-28. We are on scaffold
**9.1.0** (plugin 4.1.0), refreshed the day before
([item/project-docs-9.1-refresh](project-docs-9.1-refresh.md)). Cole expects
this release to carry real changes, not only version strings, so it may want a
cycle of its own. Scope it once the release notes are out.

## Definition of done

- [ ] Read the release notes and the new `update-project-docs` skill. Find out
      whether a migration row applies, or whether this is another owned-file
      refresh (re-running the latest migration script, as for 9.1.0).
- [ ] Dry-run first. Compare the diff of `scripts/pdocs/`, the templates and the
      seeded docs against the scaffold, and make sure nothing of ours is lost.
- [ ] Both version markers name the new release and agree.
- [ ] Run the skill's Step 6 (root conventions) and Step 7 (verify), and read
      their output.
- [ ] `pdocs check` is clean and `bun run gate` is green.
- [ ] Check whether it answers
      [scaffold #182](https://github.com/ichabodcole/project-docs-scaffold-template/issues/182):
      the false "edits of yours" flag, no documented path for refreshing a
      migrated tree to a newer patch, and no prompt to point the root
      `AGENTS.md` at the CLI. Report whatever still bites.

## Notes from the last refresh

- The 9.1.0 migration script stamped the scaffold it fetched (9.0.1), not the
  release being adopted. We set the three version strings by hand.
- The new placeholder lint found one real finding in our docs.
- Land by fast-forward or a named merge; the item cites shas.
