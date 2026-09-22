---
type: backlog
title:
  "Backlog — Scriptorium: a rendered-mode selection sometimes reaches the chat
  as different lines"
description:
  In rendered mode, the context the chat shows for a selection is sometimes
  other lines than the ones highlighted; seen on long real documents
tags: [scriptorium, selection, rendered-mode, bug]
status: draft
lifecycle: open
generated: { by: claude-opus-5, at: 2026-09-22 }
---

# Scriptorium: a rendered-mode selection sometimes reaches the chat as different lines

## Reported

Cole, in real use (Operator doc, 2026-09-20, §2): selecting text in the
**rendered** view sometimes puts _different lines_ in the chat's context chip —
the context that rides along with the next message. Seen on longer, more complex
real documents, not on the short fixtures. Cole has those documents and offered
them as repro material.

## Where the mapping lives

The rendered→source mapping is E51: `surface/state/renderedRange.ts` walks the
rendered text nodes and aligns them against `projection.ts`'s plain-text
projection (`alignRuns`), then `MarkdownView.tsx:141–164` reports the range on
`selectionchange` as source offsets plus `fromLine`/`toLine`. A drift on long
documents points at the alignment — a run that fails to align (a `null` start)
or aligns to an earlier repeat of the same text — rather than at the reporting.

## Acceptance Criteria

- [ ] Reproduced first, on one of Cole's documents, and the failing document (or
      a minimal extract of it) committed as a `projection.ts` cell
- [ ] The chip's lines match the highlighted passage on that document
- [ ] Not reproducible → say so here with what was tried; do not guess-fix

## References

- `src/scriptorium/surface/state/renderedRange.ts`
- `src/scriptorium/surface/state/projection.ts` (`alignRuns`, `toSource`)
- `src/scriptorium/surface/components/MarkdownView.tsx:141`
- Source: Operator (Spellbook workspace) →
  `Spells/Scriptorium/scriptorium-usage-notes-bugs-open-questions.md`, doc id
  `e6fc5bf1-372e-4fd7-b43f-e881deb7ec89`
