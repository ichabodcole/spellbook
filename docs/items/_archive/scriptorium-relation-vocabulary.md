---
type: item
title: "Scriptorium: a relation vocabulary shown in the link picker"
description:
  "GitHub #141: a _relations.json gives each relation a label, a meaning, an
  inverse and symmetry, shown in the link picker and backlinks; the kit shipped
  relations.ts in 6.0.0, and Scriptorium's file location is undecided."
status: draft
lifecycle: dropped
id: 01a1eabe-f1fb-751c-841d-48c27bf239d7
kind: task
generated: { by: claude-opus-5-5, at: 2026-11-17 }
tags: [kit, scriptorium, links]
parent: feature/workspace-kit-follow-ups
source: "#141"
---

# Scriptorium: a relation vocabulary shown in the link picker

Filed as GitHub #141, from Story Studio's `ichabodcole/story-studio@2e24897`.
Related: #125 (relations in the picker), #127 (relation chips).

A relation in `?rel=` is only a word today. The request is a declared
vocabulary:

- A `_relations.json` with `label`, `means`, `symmetric` and `inverse` per
  relation. A wrong value breaks the file; an unknown key is a quiet warning; a
  file that doesn't parse is reported by line and column.
- The nearest file wins, per relation, from the document up to the entry's root.
- The link picker shows each relation's label and meaning, and marks relations
  used but not declared.
- "Linked from" shows the inverse as the chip.
- A `relations` verb lists the vocabulary with use counts.

On develop the kit has `src/kit/workspace/relations.ts` (`parseRelations`,
`RELATIONS_FILE = "_relations.json"`) and `rankRelations` in
`src/kit/document/linkInsert.ts`, shipped in 6.0.0. Its header still describes
Story Studio's home, `_meta/profiles/_relations.json`. The issue leaves
Scriptorium's location open, for example a set's root. Not checked against the
picker, backlinks or a `relations` verb yet.

**Dropped on filing (2026-11-17):** a check found GitHub #141 already
implemented in spellbook 6.0.0, so the issue was closed with the evidence and
there is nothing to do here.

## Definition of done

- [ ] Where Scriptorium reads its vocabulary is decided, and the SKILL says so.
- [ ] Picker labels and meanings, inverse chips in backlinks, and a `relations`
      verb are confirmed in Scriptorium, or ported.
- [ ] #141 answered and closed once released.
