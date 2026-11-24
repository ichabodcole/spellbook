---
type: item
title:
  The kit's profile and relation readers take a convention root, extra layers
  and the folder's name from the app
description:
  The kit's vocabulary lookup gains a conventionRoot hook, a list of extra
  fallback folders consulted after the walk, and an app-supplied folder name, so
  Scriptorium can read @scriptorium/profiles/ up to the git root while Story
  Studio keeps @studio.
status: draft
lifecycle: backlog
id: 01a20f78-ff9d-7399-80c2-627d1dd81705
kind: task
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [kit, profiles, relations]
blocked_by: [01a17a8e-259e-77a4-b704-af6c786e9732]
parent: feature/workspace-kit-follow-ups
from: 01a1eadc-5c28-7746-9b8c-5bb7a428ab80
---

# The kit's profile and relation readers take a convention root, extra layers and the folder's name from the app

Cole ruled on 2026-11-24
([the write-up](./scriptorium-session-vocabularies/write-up.md#decided)) that
Scriptorium's vocabularies come from four layers, nearest winning, and that its
folder is `@scriptorium/profiles/`. Today the kit's readers
(`src/kit/workspace/profiles.ts`, `relations.ts`) read `_meta/profiles/` only,
and never look above the entry the human opened.

The kit part, shared with Story Studio:

- a `conventionRoot(entryRoot)` hook the app supplies, bounding the walk, as
  Story Studio's kit has; `$ref` keeps its rule against the same lifted root;
- a list of extra folders the app supplies, consulted after the walk, each with
  an optional scope (a folder a document must be under for it to apply);
- the folder's name taken from the app, not hard-coded.

Blocked by the kit split, which moves the two readers out of `session.ts` (its
step S5).

## Definition of done

- [ ] The profile and relation passes take `conventionRoot`, the extra layers
      and the folder name from the app; with none given, behaviour is as today
      apart from the folder name.
- [ ] Within the walk, a nearer kind file still wins whole, and a relation is
      still decided per relation; a test shows an extra layer losing to the walk
      and winning where the walk has nothing.
- [ ] A test shows a scoped extra layer applying only to documents under its
      folder.
- [ ] Each profile names the file it came from, an extra layer included, so a
      warning can be traced (`profileSourceTitle`).
- [ ] The `profiles.cost` and `relations.cost` tests still pass on their own.

## Related Documents

- [How should short-lived Scriptorium sessions get their profiles and relations?](./scriptorium-session-vocabularies/item.md)
