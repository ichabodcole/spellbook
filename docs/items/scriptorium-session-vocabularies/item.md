---
type: item
title:
  How should short-lived Scriptorium sessions get their profiles and relations?
description:
  Where Scriptorium's profiles and relation vocabularies should live so that
  short-lived sessions, gathering files from anywhere, have them without an
  agent recreating them each time, and whether to adopt Story Studio's single
  project folder in place of _meta.
status: stable
lifecycle: ready
id: 01a1eadc-5c28-7746-9b8c-5bb7a428ab80
kind: research
generated: { by: claude-opus-5-5, at: 2026-11-17 }
tags: [scriptorium, kit, profiles, relations, story-studio]
parent: feature/workspace-kit-follow-ups
cycle: 2026-11-research-and-safety
---

# How should short-lived Scriptorium sessions get their profiles and relations?

Profiles (`<kind>.json`) and the relation vocabulary (`_relations.json`) drive
useful UI:

- profile warnings and labels on the `type` chip;
- the link picker's meanings, inverse chips and the symmetry hint;
- soon, perhaps, editable frontmatter chips
  ([frontmatter-chip-editing](../frontmatter-chip-editing/item.md)).

Today the kit reads them from a `_meta/profiles/` folder, the nearest one
winning, and never looks above the root of the entry the human opened.

That fits Story Studio, which is built around projects. It has since moved to
one app-owned folder at the project root, `@studio/`, holding `project.md`,
`profiles/` and `conventions.md`. You reopen the same project, so its
definitions are written once.

Scriptorium is used differently. Cole, or an agent for him, opens a session over
documents from wherever they are, works through them and closes it. The session
doesn't last. If definitions belong to a folder the session happens to open,
they are either missing or an agent has to write them again for each session.
Much of what Cole reviews uses the same OKF fields every time. He wants the
definitions to drive the UI without being recreated.

**The question:** where should Scriptorium's profiles and relation vocabularies
come from, so that a short-lived session has the right ones without anyone
writing them? Should it adopt Story Studio's single project folder, `@studio` or
a name of our own, in place of `_meta/`? The answer decides where
[frontmatter-chip-editing](../frontmatter-chip-editing/item.md) gets its allowed
values. It also absorbs the location question in
[scriptorium-skill-relations-file-location](../scriptorium-skill-relations-file-location.md).

## Definition of done

- [ ] The write-up describes today's lookup in our kit, and Story Studio's
      `@studio` model, citing code.
- [ ] It compares the candidate sources against real Scriptorium use: OKF docs
      in a repo such as this one's `docs/`, loose notes, and a world folder. The
      candidates are built-in packs, a user library chosen when a session opens,
      the repo's own folder up to the git root, and the folder's own, or a mix
      layered nearest-wins.
- [ ] It makes a call on the layering, on whether the lookup may go above the
      opened entry, on the folder's name, and on how a pack is attached. It
      notes what the call means for kit parity with Story Studio.
- [ ] Cole has ruled on the open decisions, and the build work is filed as items
      with `--from item/scriptorium-session-vocabularies`.
