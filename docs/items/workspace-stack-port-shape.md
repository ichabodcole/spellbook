---
type: item
title: How to port the workspace stack
description:
  "Shape the workspace-stack port before its cycle opens: which Story Studio
  commit to port from now that its kit adopted a new workspace model, how to
  split 44k lines into cycles, and where Scriptorium's wiki layer and kept
  features plug in."
status: draft
lifecycle: triage
id: 01a138d7-624c-766c-bce7-d6ac23d90ee7
kind: research
generated: { by: claude-opus-5-5, at: 2026-10-13 }
tags: [kit, scriptorium, story-studio]
parent: feature/workspace-kit
---

# How to port the workspace stack

Workspace Kit's foundation cycle landed on 2026-10-13. Next is the workspace
stack: `workspace`, `chat`, `context`, `document` and `shell`, about 44k source
lines in Story Studio against Scriptorium's 20k. It is too large to plan from
the feature alone. Three questions need answering first:

- **The port base.** Story Studio's kit has moved 11 commits past `fd06b41`.
  Among them:
  - our links fixes, ported back (`027d7a3`), which we want;
  - a new workspace model: the workspace is set explicitly, its top level
    becomes the context, and files are copied in (`a8776ab`, `6b3d943`,
    `7afe5d9`, `bc88014`).

  The feature listed "the workspace holds the files" as Story-specific and out
  of scope, and E71 rules a different shape for Scriptorium. So is the new model
  separable from the kit, or is it now core?

- **The split.** How the stack divides into cycles that each leave Scriptorium
  working, following the port order (`workspace` → `chat`, `context` →
  `document` → `shell`) and the evolutions placed in it.
- **The seams.** Where Scriptorium's wiki layer plugs in (links, trust tiers,
  `meta.*`, `move.plan`, `hide`, `set.make`, the map). And how the features
  Scriptorium must keep come across: E53 and E65's waiting marks, E64's floating
  composer, the links-cycle extraction, and E71.

The answer feeds Cole's ruling on the port base and the workspace model, and the
next cycle's scope.

## Definition of done

- [ ] A write-up that answers the three questions with evidence from both
      codebases, and recommends a port base and a cycle split
- [ ] Cole has ruled on the port base and the workspace model
- [ ] The next cycle is drafted from the ruling
