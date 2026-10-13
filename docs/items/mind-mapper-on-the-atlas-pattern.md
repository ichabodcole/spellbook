---
type: item
title: Mind-mapper on the Atlas pattern
description:
  Whether mind-mapper should move from per-project SQLite to Atlas's shape (file
  tree, local files, JSON canvas) as a second app on the workspace kit.
status: draft
lifecycle: triage
id: 01a13647-8eba-7218-b8b2-2fe204b3233a
kind: research
generated: { by: claude-opus-5-5, at: 2026-10-13 }
tags: [mind-mapper, kit, canvas]
from: items/story-studio-port-back/write-up.md
---

# Mind-mapper on the Atlas pattern

Cole (2026-10-13), on hearing that mind-mapper would take only the kit
foundation: mind-mapper may be redesigned to follow Atlas's pattern, with a file
tree and local files bundled with a JSON canvas instead of per-project SQLite,
which fits a local-first app better. If it does, it becomes a second app on the
[workspace kit](../features/workspace-kit/feature.md)'s workspace stack, and the
JSON Canvas boards the Story Studio write-up skipped come back into scope.

The decision this feeds: whether the workspace stack has two consumers, and
whether canvas boards are ported with it.

## Definition of done

- [ ] A recommendation, with Cole's ruling: re-shape mind-mapper on the Atlas
      pattern, or keep its SQLite store
- [ ] If re-shaped: what happens to existing maps, and whether canvas boards
      join the workspace kit

## Related Documents

- [What to take back from Story Studio](./story-studio-port-back/write-up.md)
