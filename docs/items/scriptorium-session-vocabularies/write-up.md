---
type: write-up
title: Vocabularies for short-lived sessions
description:
  Where profiles and relation vocabularies come from for Scriptorium's
  short-lived sessions: built-in packs, a user library, the repo, or the folder,
  and how that sits beside Story Studio's @studio.
tags: [scriptorium, profiles, relations]
status: draft
generated: { by: claude-opus-5-5, at: 2026-11-17 }
---

# Vocabularies for short-lived sessions

**Outcome:** More Research Needed (framed; not yet researched)

---

## Question

Where should Scriptorium's profiles and relation vocabularies come from, so that
a session that doesn't last, gathering files from anywhere, has the right
definitions without an agent writing them each time? Should Scriptorium adopt
Story Studio's single project folder instead of `_meta/`?

## Current State

From a first look on 2026-11-17, to be confirmed:

- **Our kit.**
  - `src/kit/workspace/profiles.ts` reads `_meta/profiles/<kind>.json`, matched
    by a document's `type`. The nearest folder wins, looking up only to the root
    of the context entry, "so a profile outside the folder the user opened
    cannot leak in".
  - `_`-prefixed files there are not kinds: shared `$ref` files,
    `_relations.json` (`relations.ts`) and the reserved `_world.json`.
  - Profiles produce warnings only.
- **Scriptorium.**
  - It registers no profiles of its own.
  - It has frontmatter verbs (`meta`, `meta-init`, `meta-set`, `find`) in
    `src/scriptorium/backend/kit/wiki.ts`.
  - It finds git roots (`gitRoot.ts`).
  - This repo's `docs/` has no profiles; its vocabularies live in `pdocs`.
- **Story Studio.**
  - One project folder, `@studio/`, holds `project.md`, `profiles/` (kinds plus
    `_relations.json`, `_markers.json` and `_world.json`) and `conventions.md`.
    Introduced in `f09d9225`, "the project's own folder, @studio, with a surface
    for it".
  - Projects are reopened, so definitions persist.

## Findings

To be written.

### Options Considered

The candidate sources, which may be layered with the nearest winning:

1. **Built-in packs that ship with Scriptorium.** For example, OKF: `type`,
   `status`, `title`, `description`, `tags`.
2. **A user library** (for example `~/.scriptorium/profiles/<pack>/`). A pack is
   chosen when a session opens (`open --profile <pack>`), or set as a default.
3. **The repo's own folder**, found by looking up from the opened files to the
   git root or a marker folder. For this repo, `pdocs` could generate it from
   its own schema.
4. **The folder's own** `_meta/profiles/`, renamed or not, which is today's
   behaviour.

Also: attaching a pack explicitly, or matching it automatically from the
frontmatter (`type: item` matching a known pack).

## Recommendation

Open.

## Next Steps

1. Confirm the current state with file:line, on both sides.
2. Read Story Studio's `@studio` decisions: commits `c9505695` and `f09d9225`,
   and the item `studio-folder-move-pins-root-links`.
3. Walk the three uses (repo OKF docs, loose notes, a world folder) through each
   option.
4. Bring the open decisions to Cole, then file the build items.

## Open Questions

- Should the lookup go above the opened entry, and only as far as the git root?
  That would relax a deliberate guard.
- What should the folder be called: `@studio`, an `@`-name of our own, or
  `_meta` kept?
- Is a pack attached explicitly, or matched automatically?
- Can a profile express allowed transitions, such as lifecycle order, or only
  enums?

---

**Related Documents:**

- [How should short-lived Scriptorium sessions get their profiles and relations?](./item.md)
- [Can a frontmatter chip be changed from the rendered view?](../frontmatter-chip-editing/item.md)
