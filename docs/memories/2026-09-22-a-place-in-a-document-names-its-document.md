---
type: memory
title: "A place in a document must name its document"
description:
  Scriptorium's selection and its reveal range were bare offsets, so a document
  switch applied them to the wrong text; both now carry the document and version
  they name, checked through one rule
tags: [scriptorium, selection, co-presence]
status: stable
generated: { by: claude-opus-5.5, at: 2026-09-22 }
---

# A place in a document must name its document

Scriptorium's held selection was offsets and lines, with no document. The effect
that told the daemon stamped it with whichever document was open, so after a
switch the chip read `beta.md · line 5` over alpha's words. A second value had
the same flaw: `reveal`, a range the raw editor selects when it is created, so
switching to Raw after a switch put one document's offsets on another. Both now
carry `doc` and `version`, and pass through one rule, `selectionOnScreen`,
before anything uses them.

## What to carry forward

- **A value that names a place in a text (an offset, a range, a line) must carry
  which text it names**, or something will apply it to another. Stamping it at
  the point of use, with "whatever is open now", is the defect.
- **Check it where it is read, not where the text changes.** The open document
  moves from many places, and a check at each is a check the next path forgets.
- **A request to act on a place is one shot.** Held until "the right moment", it
  replays at a moment nobody chose, such as a component re-mounting.
- **Look for the second value.** The first fix covered the selection; the
  no-stake verifier found the reveal, the same class in a neighbouring field.

**Key files:** `src/scriptorium/backend/selection.ts`,
`src/scriptorium/surface/state/selection.ts`

**Docs:** E66 in `docs/projects/scriptorium/decision-log.md`; session
`docs/projects/scriptorium/sessions/2026-09-22-a-selection-that-outlived-its-document.md`.
