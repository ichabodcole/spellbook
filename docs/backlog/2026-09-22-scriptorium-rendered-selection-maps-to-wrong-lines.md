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

## Found (2026-09-22, branch `fix/scriptorium-selection-context`)

Reproduced on `grimoire/house-style.md`, and it was **two** causes, not one.

**1. `alignRuns` was poisoned by inter-tag whitespace.** Its comment said a
whitespace run "simply fails to match and is skipped". It did not: micromark
writes three newline text nodes between a blockquote and a following list where
the projection writes two, so the third was searched for forwards and matched a
soft line break INSIDE the list item — moving the cursor past real text. On
house-style that happened at run 317 of 987 (source line ~260); **526 runs then
aligned late or not at all**, which is the "before this point it works" Cole
saw, and why a later selection's chip showed a passage near the end. The heading
misses (`Authoring — the governing rule`) were the same bug; the
`<!-- rule-id: … -->` misses were a run whose text node carries the newlines
around the comment.

Fixed by three rules in `alignRuns`: whitespace-only runs are placed only where
the cursor already is (and otherwise move nothing); a match that skips
non-whitespace text must be confirmed by the next run following it directly (so
rendered text the projection never wrote cannot jump to a later copy of itself);
runs are matched on their trimmed text with the start backed off. House-style,
the whole grimoire, AGENTS.md and every shipped SKILL.md now align with **no
text run left unplaced**.

**2. A wrapped list item or quote reported every one of its lines.** Found by
driving the fixed build in a real browser: the source of a wrapped item repeats
the indent or `> ` on each line and the rendered text does not, so the text node
was longer in source than on screen, its segment was not `exact`, and any offset
in it resolved to the whole paragraph — `lines 260–263` for a word on line 263.
`project()` now splits such a node at its line breaks and emits each line
exactly, falling back to the old single segment if a line cannot be found.

Left alone (out of scope, no drift — each only nulls its own run now): an inline
code span that wraps across a source line, and a multi-line HTML comment.
Roughly one run per thousand on the repo's own documents.

Commits: `b6a3ea82`, `df0af6e5`.

## Acceptance Criteria

- [x] Reproduced first, on one of Cole's documents, and the failing document (or
      a minimal extract of it) committed as a `projection.ts` cell
- [x] The chip's lines match the highlighted passage on that document
- [ ] Not reproducible → say so here with what was tried; do not guess-fix

## References

- `src/scriptorium/surface/state/renderedRange.ts`
- `src/scriptorium/surface/state/projection.ts` (`alignRuns`, `toSource`)
- `src/scriptorium/surface/components/MarkdownView.tsx:141`
- Source: Operator (Spellbook workspace) →
  `Spells/Scriptorium/scriptorium-usage-notes-bugs-open-questions.md`, doc id
  `e6fc5bf1-372e-4fd7-b43f-e881deb7ec89`
