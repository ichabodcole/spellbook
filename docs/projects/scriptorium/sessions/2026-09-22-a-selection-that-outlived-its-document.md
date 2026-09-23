---
type: session
title: "A selection that outlived its document — 2026-09-22"
description:
  The chip carried a passage from one document under another's name, and a
  search jump's range could do the same. Both now carry the document and version
  they name, and a switch clears them in the surface and the daemon
tags: [scriptorium, selection, co-presence, verification]
status: stable
generated: { by: claude-opus-5.5, at: 2026-09-22 }
---

# A selection that outlived its document — 2026-09-22

Part of
[Scriptorium from real use](../../../cycles/2026-09-scriptorium-real-use.md), as
an unplanned fifth branch. The fourth is
[a note that says it is with the agent](./2026-09-22-a-note-that-says-it-is-with-the-agent.md).

## What this was

Branch 4's reviewer of record found it with a real mouse. Select in `alpha.md`,
click `beta.md`, and the chip read `beta.md · v1 · line 5` over alpha's words.
The daemon held the same, so a `say` would have sent alpha's text as beta's. It
predates that branch. It breaks the cycle's appetite ("the context chip always
matches the selection"), so Cole chose to fix it in-cycle. It is edge 0 of
`docs/backlog/2026-09-22-scriptorium-selection-edges-the-review-found.md`.

## The rule

**When the document text on screen changes, the held selection is cleared, in
the surface and in the daemon.** It is the orchestrator's reading of Cole's
"keep the UX model simple" and of branch 1's ruling that clearing the chip
clears the selection.
[E66](../decision-log.md#e66--a-selection-belongs-to-the-text-it-was-made-in)
records it. Another document and another version both count. The selection is
dropped, never re-labelled, and going back does not revive it. No flow was found
where someone selects in one document and means to ask about it from another.

## The cause

The surface's selection was offsets and lines with no document of its own. The
effect that tells the daemon stamped it with whatever document was open when it
ran, so a switch sent the old passage under the new name. The verifier then
found a second value with the same flaw: `reveal`, the range a search jump or a
note click asks the raw editor to select. Nothing cleared it, and the editor
applies it whenever it is created, so switching to Raw put one document's
offsets on another.

## The fix

- **One rule, `selectionOnScreen`** (`backend/selection.ts`), used by both
  halves: a value naming a place is kept only while its document and version are
  the ones on screen.
- **Surface.** The held selection and a pending reveal both carry `doc` and
  `version`. A switch clears the selection (and its paint) through
  `applySelectionEvent`, and drops the reveal through `revealAfter`. A reveal is
  also spent once applied, and dropped when the human chooses something else.
- **Daemon.** Every read of the selection goes through the rule, and a `select`
  for text not on screen is refused. The read in `say` is a backstop no test can
  reach, and the code says so.

## Review

One no-stake agent (`general-purpose`, tools `*`, fresh) verified and reviewed
together, which is proportionate for a fix this size. It drove the branch with
real mouse input. The chip and `/state` agreed on every path E66 lists, a `say`
right after a switch carried no selection, and the mutants were caught. **It
found the reveal bug**, on two paths the first pass had called checked. The fix
went in on this branch, test first, and was re-driven with the verifier's repro.

## Known and not built

The verifier's other finds predate the branch. They are filed as edges 5–7 in
the same backlog item, which stays open:

- a second tab on the same session wipes the daemon's selection while the first
  tab's chip still shows it;
- choosing the already-active version in the version menu leaves the chip with
  no highlight;
- after following a link, the context tree still highlights the previous
  document.

## Verification

`bun run gate` on the final tree, run unpiped: exit 0, and the committed `dist/`
reproduces.

## What to exercise, next time the app is open

1. **Select a passage, then open another document** by any route (the list, a
   search result, a link). The chip should be empty, and a message should carry
   no passage.
2. **Jump to a search hit in rendered view, open another document, switch to
   Raw.** Nothing should be selected there.
3. **Clear the chip with its X, then switch rendered → raw.** The passage should
   not come back.
