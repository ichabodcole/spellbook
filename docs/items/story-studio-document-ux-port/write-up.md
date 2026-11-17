---
type: write-up
title: Story Studio document UX, since the last scan
description:
  Candidates from Story Studio's document UX since 2026-10-12, with a take,
  take-later or skip call on each.
tags: [scriptorium, story-studio, ux]
status: draft
generated: { by: claude-opus-5-5, at: 2026-11-17 }
---

# Story Studio document UX, since the last scan

**Outcome:** More Research Needed (framed; the scan has not run yet)

---

## Question

Which document-UX changes has Story Studio made since the 2026-10-12 scan that
Scriptorium should take, take later, or skip? The answer decides which items to
file for the next feature cycle, after the bugs-only `2026-10-bugs-after-6`.

In scope: the UI and interaction patterns Scriptorium shares with Story Studio.
That means the document pane, versions, notes, chat, the right column, the tree
and navigation. Out of scope:

- Story Studio's own areas: projects, boards and canvas, stages, audio and
  packaging.
- Kit bug fixes, which come back over `kit-parity`.

## Current State

- **Story Studio** lives at `~/Projects/dreamwood/story-studio`. Its cycles are
  in `docs/cycles/_archive/`, and its features (for example `outstanding-inbox`)
  are in `docs/features/_archive/`. It has made about 966 commits since
  2026-10-12.
- **The last scan** was
  [What to take back from Story Studio](../_archive/story-studio-port-back/write-up.md).
  Its candidates were carried by the Workspace Kit feature, which ended with the
  Scriptorium cutover on 2026-10-22. Anything it already decided, this scan
  doesn't repeat.
- **The paradigms are diverging.** Since 2026-10-17 Story Studio has been built
  around plugins and projects, and its project and file-tree model is moving
  away from Scriptorium's sets. Each candidate has to be judged against
  Scriptorium's own model, not copied.
- **Scriptorium today** runs on Spellbook's kit (`src/kit/`). Its right column
  has text tabs. It has no inbox: waiting notes and versions show only in their
  own panes.

## Findings

### Evidence

Story Studio cycles closed since 2026-10-12 that look like they touch document
UX, as a starting list:

| Cycle (closed)                               | Why look                                                                                                                                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2026-10-composer` (10-14)                   | "Talk to the agent from anywhere"                                                                                                                                                                          |
| `2026-10-keeping-up` (10-22)                 | "The app keeps up with you"                                                                                                                                                                                |
| `2026-10-order-by-hand` (10-22)              | Ordering by hand, and the agent's words                                                                                                                                                                    |
| `2026-10-quieter-controls` (10-24)           | Control density and chrome                                                                                                                                                                                 |
| `2026-10-caret-cues` (10-25)                 | Cues at the caret, in the editor                                                                                                                                                                           |
| `2026-11-the-agents-modes` (11-01)           | Agent modes as the human sees them                                                                                                                                                                         |
| `2026-11-agent-paper-cuts` (11-05)           | Agent-facing surface fixes                                                                                                                                                                                 |
| `2026-11-navigation-and-image-use` (11-12)   | Navigation                                                                                                                                                                                                 |
| `2026-11-inbox-and-copies` (11-13)           | **The inbox**: `3539a3e1` (popover and top-bar button), `523e4834` (one row per document's agent versions), `365f91ea` (owed notes go to the inbox), `221163b6` (leave an agent version without taking it) |
| `2026-11-links-and-colors-that-hold` (11-16) | **Icon tabs in the right column** (`416160b2`); history entries keep their place (`33d7d81d`)                                                                                                              |

The scan should read each cycle's Scope and Outcome, not only its title.

### Key Observations

- Cole reports that the inbox has helped in real use. It answers "what still
  needs me?" across versions, notes and agent actions. That fits the house rule
  that a warning needs an action: each inbox row is an act to take.
- Some of the inbox's rows are Story Studio's own (map and board offers,
  `a49e538b` and `bbd79c40`). The part Scriptorium could take is the inbox
  itself plus its rows for documents, versions and notes.

### Options Considered

Each candidate gets one of three calls: take, take later, or skip.

## Recommendation

Open until the scan runs.

## Next Steps

1. Read the Scope and Outcome of each cycle in the table, and skim the rest of
   the list for anything about documents that the titles hide.
2. For each candidate, record:
   - Story Studio's evidence: the commit, and the paths in its kit.
   - What Scriptorium has today.
   - Whether it is in the kit (a port) or in Story Studio's app (needs a
     rework).
   - How big it is.
   - A proposed call.
3. Show Cole the calls, using the screenshots or a mockup where it helps.
4. File the candidates he takes as items with
   `--from item/story-studio-document-ux-port`, then close this item.

## Open Questions

- Does the inbox belong in Spellbook's kit, for every spell that has documents,
  or only in Scriptorium?
- Do icon tabs depend on Story Studio's per-item-type columns, or do they work
  on their own?
- How much of Story Studio's newer kit (`packages/kit`) has drifted from ours?
  This decides whether a candidate can be ported or has to be rebuilt.

---

**Related Documents:**

- [Which of Story Studio's new document UX should Scriptorium take?](./item.md)
- [What to take back from Story Studio](../_archive/story-studio-port-back/write-up.md)
