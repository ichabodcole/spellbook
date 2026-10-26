---
type: item
title: Keep only the active version
description:
  One act that deletes every version of a document except the active one, for
  when a version is settled and the lineage isn't needed.
status: draft
lifecycle: triage
id: 01a1366d-7b8d-71f8-85c8-a14948b5bd8e
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-13 }
tags: [scriptorium, versions]
---

# Keep only the active version

**Cole's request, from real use (2026-10-13, in Scriptorium chat):** reviews
pile up versions. Sometimes keeping them all is useful, but once a version is
the one, the lineage isn't needed. Today that means deleting each old version by
hand (`version-delete`, one at a time, and never the active one). He wants a
shortcut that consolidates to the active version by deleting the others. He may
port it to Story Studio as well.

Shape to settle when it's shaped (not decided here):

- **Where the act lives:** a menu action on the version strip, and a CLI verb
  (or a flag on `version-delete`) so the agent can offer it in chat.
- **The confirm says what goes:** the count, and anything worth a warning, such
  as notes or chat messages that refer to a version being deleted. Story
  Studio's `versionDeleteWarnings` slot is the pattern.
- **Undo:** one undo for the whole act, consistent with E60's history arrows, or
  explicitly not undoable and the confirm says so.
- **Numbering:** whether the surviving version keeps its number (v4) or becomes
  v1.
- **Unsaved state:** what happens if the active version differs from the file on
  disk.

## Definition of done

- [ ] From the surface and from the CLI, one act leaves a document with only its
      active version, after a confirm that names what will be deleted
- [ ] The answers to the shape questions above are recorded in Scriptorium's
      decision log
- [ ] Tests cover the act, its refusal cases, and its undo (or the stated lack
      of one)
