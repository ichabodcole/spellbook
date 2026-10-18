---
type: item
title: A document with no frontmatter is offered a block to add
description:
  "Bring E35 to the kit path: a verb returns a suggested frontmatter block and
  the pane offers it into the buffer, as the shipped meta.suggest does."
status: draft
lifecycle: triage
id: 01a14dc5-70c3-7762-8b0a-db667fbc47c8
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-17 }
tags: [scriptorium, kit, frontmatter]
parent: feature/workspace-kit
---

# A document with no frontmatter is offered a block to add

E35: when a document has no frontmatter, the shipped header offers "Add a
block", which puts a suggested block into the editor for the human to keep or
change. The shipped daemon answers `meta.suggest` for it.

On the kit path, `suggestMeta` exists (`backend/kit/wiki.ts`), but it only feeds
`meta-init`, which writes the file. No verb returns a block for the editor, and
the kit's document header has no such offer.

This item brings it across: an app verb that returns the suggested block, and an
offer in the pane, through `frontmatterChips` or a small header slot, that puts
it into the editor unsaved.

## Definition of done

- [ ] With `SCRIPTORIUM_KIT=1`, a document with no frontmatter offers "Add a
      block". Taking it puts the suggested block into the editor, unsaved, and
      the file is untouched until Save.
- [ ] The suggested block matches what the shipped app suggests for the same
      document.
- [ ] Any kit change is a generic slot, offered back on kit-parity.
