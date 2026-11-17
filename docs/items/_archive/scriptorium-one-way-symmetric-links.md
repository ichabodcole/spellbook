---
type: item
title: "Scriptorium: hint at symmetric relations written one way"
description:
  "GitHub #142: link-check hints, outside its count, at a symmetric relation
  written from one end only; the kit shipped oneWaySymmetric in 6.0.0,
  unconfirmed in Scriptorium."
status: draft
lifecycle: dropped
id: 01a1eabe-f281-76c1-a9e9-065794d432a1
kind: task
generated: { by: claude-opus-5-5, at: 2026-11-17 }
tags: [kit, scriptorium, links]
blocked_by: [01a1eabe-f1fb-751c-841d-48c27bf239d7]
parent: feature/workspace-kit-follow-ups
source: "#142"
---

# Scriptorium: hint at symmetric relations written one way

Filed as GitHub #142, from Story Studio's `ichabodcole/story-studio@2e24897`. It
needs a vocabulary that says which relations are symmetric
([scriptorium-relation-vocabulary](scriptorium-relation-vocabulary.md), #141).
Related: #129 (link health in the status bar).

The hint: `A → B ?rel=contrasts-with`, where `contrasts-with` is symmetric and
`B` has no link back to `A` with the same relation.

- It is raised only where the vocabulary in force at both ends says symmetric.
- Self-links are skipped; a pair is reported once; a link with several relations
  is checked per relation; only links that resolve count.
- It is informational. It sits outside the link-check count, in its own section
  ("Symmetric links written one way"), and is never a doctor finding. Each entry
  opens the link at its range.

On develop the kit has `oneWaySymmetric` (`src/kit/workspace/relations.ts`),
used by `linkCheck` in `session.ts`, shipped in 6.0.0. Not checked in
Scriptorium yet.

**Dropped on filing (2026-11-17):** a check found GitHub #142 already
implemented in spellbook 6.0.0, so the issue was closed with the evidence and
there is nothing to do here.

## Definition of done

- [ ] In Scriptorium, a one-way symmetric link shows in its own link-check
      section and status mark, outside the count.
- [ ] Anything missing is ported or filed.
- [ ] #142 answered and closed once released.
