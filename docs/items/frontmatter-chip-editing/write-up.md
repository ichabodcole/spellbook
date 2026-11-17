---
type: write-up
title: Editing frontmatter from its chips
description:
  What the kit already has toward editing a frontmatter chip from a list of
  allowed values (profiles with enums, the chip header), and what a build still
  needs decided.
tags: [scriptorium, frontmatter, profiles]
status: draft
generated: { by: claude-opus-5-5, at: 2026-11-17 }
---

# Editing frontmatter from its chips

**Outcome:** More Research Needed (framed; not yet researched)

---

## Question

Can the human change a frontmatter value, such as `status: draft` or
`lifecycle: triage`, by clicking its chip in the rendered view and picking from
the allowed values? Is there enough in the kit to build this now? If not, what
has to be decided first?

## Current State

From a first look, not yet checked in depth:

- **The chip header.** `src/kit/document/FrontmatterHeader.tsx` renders the
  frontmatter as chips. It names `type`, `status`, `lifecycle` and `verified` as
  special, and lists every other key with its value. An app adds or restyles
  chips through the pane's `frontmatterChips` slot. The chips only display; none
  of them edits.
- **Profiles.** `src/kit/workspace/profiles.ts` reads one JSON Schema per kind
  from `_meta/profiles/<kind>.json`. The kind comes from the document's `type`,
  and the nearest folder's file wins. Profiles can declare `enum`s; the tests
  use `status: { enum: ["draft", "stable", "deprecated"] }`. Today profiles only
  produce warnings: the chip header shows the profile's label and folds its
  warnings into one amber `ProfileChip`.
- **This repo's own docs have no profiles.** The vocabularies for `status`,
  `lifecycle`, `kind` and `priority` live in `pdocs`, in `docs/SCHEMA.md` and
  the CLI's lint. `pdocs set` refuses values the lint would reject, and some
  transitions too. For example, starting a `draft` item raises an advisory.
- **The write path.** In Scriptorium the human edits the active version, and the
  file on disk changes on Save. Minor frontmatter edits on a document that isn't
  dirty are written in place. Whether that should hold for a chip change is one
  of the questions below.

## Findings

To be written.

## Recommendation

Open.

## Next Steps

1. Confirm the current state above against the code, with file:line.
2. Map the allowed-values source for both cases:
   - a world's documents, which have profiles;
   - this repo's docs, where `pdocs` holds the vocabulary. Options for this repo
     include writing `_meta/profiles/` for it, having `pdocs` export its schema
     as profiles, or a bridge the app supplies.
3. Decide the write path for a chip change, from these options:
   - an edit to the active version, like a keystroke;
   - a direct file write;
   - a call through a verb or the CLI, so rules like `pdocs set`'s run.
4. Sketch the interaction: the dropdown, disabled values with the reason, and
   undo. Use a mockup if it helps.
5. Make the call: build items, or decisions for Cole.

## Open Questions

- Should the chip offer every value in the enum, or only the transitions that
  are allowed from the current one (lifecycle has an order)?
- Does the agent hear about a chip change as an event, the way it does for a
  save?
- Is this a kit feature, available to every spell with documents, with
  Scriptorium the first to use it?

---

**Related Documents:**

- [Can a frontmatter chip be changed from the rendered view?](./item.md)
- [Scriptorium's SKILL says where the relations file goes](../scriptorium-skill-relations-file-location.md)
