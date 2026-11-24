---
type: item
title:
  Scriptorium sessions get vocabularies from the repo, the user and a built-in
  project-docs pack
description:
  Scriptorium supplies the git-root lift, the @scriptorium/profiles/ folder, a
  global ~/.scriptorium/profiles/ layer and a built-in project-docs pack
  attached by .project-docs.json and bounded by its docsRoot, and its SKILL says
  where the files go.
status: draft
lifecycle: backlog
id: 01a20f79-002c-7149-a5f6-5dbe22bf6ab0
kind: task
generated: { by: claude-opus-5-5, at: 2026-11-24 }
tags: [scriptorium, profiles, relations]
parent: feature/workspace-kit-follow-ups
from: 01a1eadc-5c28-7746-9b8c-5bb7a428ab80
blocked_by: [01a20f78-ff9d-7399-80c2-627d1dd81705]
---

# Scriptorium sessions get vocabularies from the repo, the user and a built-in project-docs pack

Cole ruled on 2026-11-24
([the write-up](./scriptorium-session-vocabularies/write-up.md#decided)) how a
short-lived Scriptorium session gets its profiles and relation vocabulary
without anyone writing them each time. This is Scriptorium's half, on top of
[kit-profile-layers](./kit-profile-layers.md):

1. The folder's own `@scriptorium/profiles/`, walked up from the document.
2. The same walk continued above the opened entry, to the git root and never
   further (`conventionRoot` = `gitRootOf(entryRoot) ?? entryRoot`).
3. A global `$SCRIPTORIUM_HOME/profiles/` (`~/.scriptorium/profiles/`), always
   in force.
4. Built-in packs. The first is `project-docs`, attached when
   `.project-docs.json` is found between the document and the git root, and
   applying only to documents under that file's `docsRoot` (default `docs`).
   Scriptorium reads that file and never writes it; `lint.types` is not read.

The pack holds the pdocs kinds (`item`, `feature`, `cycle`, `write-up`, `plan`,
`design-resolution`, `test-plan`, `session`, `report`) with `status`,
`lifecycle`, `kind` and `priority` as enums in workflow order.

## Definition of done

- [ ] In a session over this repo's `docs/`, an item shows the pack's profile
      with no profile file written anywhere, and its header names it as
      built-in.
- [ ] A `type: item` file outside `docsRoot`, or in a folder with no
      `.project-docs.json` up to the git root, gets no pack profile.
- [ ] A file in `~/.scriptorium/profiles/` applies in every session, and loses
      to a repo's `@scriptorium/profiles/`.
- [ ] No profile above the git root is read, and for an entry outside any git
      repo none above the entry root.
- [ ] The pack covers the pdocs kinds above only; a repo's `lint.types` extras
      (here `release`, `memory`, `lesson`) get no pack profile.
- [ ] A ward test fails when the pack's kinds or enums drift from
      `scripts/pdocs/lint/registry.ts` and `rules.ts`.
- [ ] SKILL.md says where vocabulary files go and what the layers are, and
      `profiles` and the doctor list which layer each file came from.

## Related Documents

- [How should short-lived Scriptorium sessions get their profiles and relations?](./scriptorium-session-vocabularies/item.md)
