---
type: item
title: Mirrored sets follow symlinks out of the workspace and through loops
description:
  A directory symlink pointing outside the workspace shows its files in a
  mirrored set, and symlink loops are walked until the 2000-entry cap, listing
  alias paths as separate documents. Inherited from Story Studio's tree.ts.
status: stable
lifecycle: ready
id: 01a13c65-0307-737d-bd5b-d00816a2d5cf
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-14 }
tags: [kit, workspace]
parent: feature/workspace-kit-follow-ups
priority: medium
cycle: 2026-10-release-6
---

# Mirrored sets follow symlinks out of the workspace and through loops

Found by the finalize review of the
[workspace-daemon cycle](../cycles/_archive/2026-10-workspace-daemon.md)
(2026-10-14). The tree code is the same as Story Studio's `tree.ts`.

- A directory symlink inside a mirrored set that points outside the workspace
  shows that folder's files as documents in the set.
- Loops such as `self -> .` and `up -> ..` are walked about 39 levels deep,
  until the 2000-entry cap. Each alias path, like `self/self/…/x.md`, is listed
  as its own document. The walk always ends.

## Definition of done

- [ ] A mirrored set either doesn't follow directory symlinks, or follows only
      those that stay inside the workspace. Say which.
- [ ] A loop is visited once.
- [ ] Tests cover an outward symlink and a loop.
- [ ] Offered to Story Studio on `kit-parity`.
