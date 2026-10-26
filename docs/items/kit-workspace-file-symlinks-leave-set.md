---
type: item
title: A file symlink pointing outside a set shows its target as a document
description:
  Mirrored sets no longer follow directory symlinks, but a symlinked file whose
  target is outside the set still shows as a document, and search, meta, graph
  and Save reach the outside file through it.
status: draft
lifecycle: triage
id: 01a175d7-739f-73e9-9cce-b1af05b79081
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-25 }
parent: feature/workspace-kit-follow-ups
from: items/kit-workspace-symlinked-sets.md
---

# A file symlink pointing outside a set shows its target as a document

Found by the verifier of
[kit-workspace-symlinked-sets](./kit-workspace-symlinked-sets.md) (2026-10-25).
That item stopped mirrored sets from following directory symlinks, so a link can
no longer show a whole outside folder or loop. A symlinked **file** whose target
is outside the set still shows as a document: `filelink.md -> outside/secret.md`
appears in `state`, `meta` and `graph`, and `search` finds the outside text
through it. Save would write through it.

Smaller than the folder case, since it can't loop or list a tree, and someone
made the link on purpose. But it is the same kind of leak, and Cole ruled on
2026-10-25 that it gets its own item.

## Definition of done

- [ ] Decide the policy for file symlinks that leave the set (hide, show as a
      link the human can open as its own set, or allow read-only), and say it in
      the item.
- [ ] Search, meta, graph and Save follow the policy; tested with an outward
      file link and an inward one.
- [ ] Offered on kit-parity.

## Related Documents

- [Mirrored sets follow symlinks out of the workspace and through loops](./kit-workspace-symlinked-sets.md)
