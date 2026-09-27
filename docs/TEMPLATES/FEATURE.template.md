---
type: feature # REQUIRED (OKF §3). Do not change it — the folder decides it.
title: "[Feature Title]"
description: "[One sentence: what this proposes and why.]"
tags: [area, feature] # 2-4 kebab-case keywords
status: draft # OKF §5.4: draft | stable | deprecated. Nothing else.
lifecycle: backlog # backlog | ready | active | review | done | dropped
generated: { by: your-name-or-model, at: YYYY-MM-DD }
---

<!--
OWNERSHIP (of this template file — not of documents created from it): it is
yours to edit. The scaffold records its hash, so a migration updates it only
while you have not touched it. Frontmatter is the contract the lint enforces;
below it is yours. See docs/SCHEMA.md → "Who owns which file".

USAGE: `bun scripts/pdocs/cli.ts new feature <slug>` writes this as
docs/features/<slug>/feature.md. This file is the feature: it argues for the
change, and its `lifecycle` is the feature's state. Its plan, sessions and other
documents are created beside it with `--owner feature/<slug>`.

STATE. A feature never takes `triage`: it arrives already accepted.
  backlog  accepted, and still being shaped (a draft proposal)
  ready    approved to build
  active   being built;  review  built, waiting on a reviewer
  done     delivered;    dropped  decided against. Nothing is deleted.
Who moves it: create-project or generate-proposal sets `ready` on the
owner's word; dev-kickoff sets `active`; sweep-project sets `done` or
`dropped`. Change it with `pdocs set feature/<slug> --lifecycle <state>`.
The work is tracked on items that name it: `parent: feature/<slug>`, and
`pdocs view feature <slug>` lists them.

Optional fields: `scope` (one name from `lint.scopes`) and `released_in` (the
version that shipped it, written at release).

Answer: what are we building, why, what is the approach, and what is in and out
of scope? Merge, skip or add sections as the argument needs. See the features
README: ../README.md
-->

# [Feature Title]

## Overview

[One or two paragraphs: what this feature is, and why it matters.]

## Problem Statement

What problem are we solving? What's the pain point or opportunity? Who's
affected and why does this matter?

## Proposed Solution

What's the high-level approach? Describe the major components and how they fit
together.

How will users experience this? Include concrete examples, user stories, or
scenarios that illustrate the feature in action.

[If comparing alternatives is important, discuss them here - what options were
considered and why this approach was chosen]

## Scope

**In Scope (MVP):** What's included in the first iteration?

**Out of Scope:** What are we explicitly NOT doing (at least initially)?

**Future Considerations:** What might we add later?

## Technical Approach

High-level technical strategy - how does this fit into existing architecture?
What patterns, technologies, or major components are involved?

What are the key dependencies (existing features, systems, or external
libraries)?

[If data changes are significant: What new entities or relationships are needed?
Keep high-level - detailed schemas belong in implementation plans]

[Use illustrative examples or pseudocode if helpful, but avoid production-ready
code - that belongs in implementation plans]

## Impact & Risks

**Benefits:** What value does this provide?

**Risks:** What could go wrong? How will we mitigate?

**Complexity:** [Low/Medium/High] - Why?

## Open Questions (Optional)

[Anything still undecided or needing further discussion]

## Success Criteria (Optional)

[How will we know this succeeded? What are the measurable outcomes?]

---

**Related Documents:**

- `[Research write-up](../../items/item-name/write-up.md)` (if applicable)
- `[Architecture docs](../../architecture/doc-name.md)` (if applicable)

---

## Notes

[Optional section for additional context, research notes, or meeting decisions]
