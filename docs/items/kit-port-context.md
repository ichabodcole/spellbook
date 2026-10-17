---
type: item
title: Port Story Studio's context pane into the kit, without copy-in
description:
  Port packages/kit/src/context from 027d7a3 plus d7ef948, a538a2e, 0ff5698 and
  the context halves of bbc54fd, ae08f10 and 4e6d4d4, leaving out the copy-in
  commits, so sets are still added from where they live.
status: stable
lifecycle: triage
id: 01a14bca-14ab-7119-bc8a-05b2b7dcd676
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-17 }
tags: [kit, story-studio, context]
parent: feature/workspace-kit
cycle: 2026-10-panes
---

# Port Story Studio's context pane into the kit, without copy-in

Context comes from `027d7a3`, the same base as the workspace stack, plus the
commits we want since then, in this order:

1. `d7ef948`: "New set" at the root, "New folder" inside a set;
2. `a538a2e`: two CI races in `daemonClient.test` made to hold;
3. `0ff5698`: a pending edit is sent before a version switch;
4. the context halves of `bbc54fd` (`selected`, `onSelect`, `onAddRef`,
   `AddRefItem`, the tree multi-select), `ae08f10` and `4e6d4d4`.

A trial in a scratch repo applied all of them cleanly except `bbc54fd` in
`ContextSidebar.tsx`. That hunk only adds props, so it needs a small merge by
hand.

**Left out on purpose:** Story Studio's copy-in model. Its files are brought
into one project workspace, while ours are edited where they live and sets are
added from anywhere. That means leaving out:

- `6b3d943` (`copyIn`, `CopyInAnswer`, the `picked` prop);
- `7afe5d9` (`folderDrop.ts`, a dropped folder becomes a set at the root);
- `83ea109`'s comment in `model.ts`;
- the "copy it in" wording.

We keep `onAddPath` and `027d7a3`'s rule that dropping a folder is refused, with
a pointer to the picker that links it. Where "New set at the root" assumes a
single root, the wording is ours to fix.

## Definition of done

- [ ] `src/kit/context` is `027d7a3`'s, with the six commits above applied and
      the copy-in commits left out, on Spellbook's names. Its tests pass.
- [ ] Adding a path adds a set where the path lives. No context code copies a
      file anywhere.
- [ ] The tree multi-select and "Add as reference" send refs the daemon accepts,
      as `kit-port-via-refs` stored them.
- [ ] The port-back note names what we left out and why, for kit-parity.
