---
type: cycle # REQUIRED (OKF §3). Do not change it — the folder decides it.
title: "[What is in play, in three or four words]"
description: "[One sentence: what this cycle is for.]"
tags: [area, area] # 2-4 kebab-case keywords
status: draft # OKF §5.4: draft | stable | deprecated. Nothing else.
lifecycle: planned # planned | active | closed | abandoned — one active at a time
started: YYYY-MM-DD
appetite: "[When it would be right to stop, in a sentence. Not a date.]"
scope:
  - project/[project-name]
  - backlog/[YYYY-MM-DD-item-name]
after: [] # cycles or projects this one waits on
generated: { by: your-name-or-model, at: YYYY-MM-DD }
---

<!--
OWNERSHIP (of this template file — not of documents created from it): it is
yours to edit. The scaffold records its hash, so a migration updates it only
while you have not touched it. Frontmatter is the contract the lint enforces;
below it is yours. See docs/SCHEMA.md → "Who owns which file".

USAGE: Copy this file to docs/cycles/ as `YYYY-MM-<slug>.md`.

A cycle is an index over work in play, not a container for it. Link the projects
and backlog items in `scope:`; leave their proposals, plans, sessions and
artifacts where they are.

Set `lifecycle: active` when work starts, and check no other cycle is already
active — the lint will tell you, but knowing before you write is cheaper.

For more guidance, see: ./README.md
-->

# [What is in play, in three or four words]

## Why now

[Two or three sentences. What makes this the work to do next, rather than any of
the other things that could be done? If the honest answer is "it was next in the
list", say so — that is also a reason.]

## Scope

One line per entry in `scope:`, saying what "done" looks like for it.

- **[project/name]** — [what shipping this means]
- **[backlog/item]** — [what shipping this means]

Out of scope, deliberately: [the neighbouring things someone would reasonably
expect to be included, and why they are not.]

## Outcome

_Written at close, not before._

[What shipped. What was cut, and why. What was learned that will change how the
next cycle is scoped. Two paragraphs is usually enough; the point is that a
reader six months from now can tell what happened without reading every
session.]

## Sessions

<!--
One line per branch, appended by `init-branch` as it opens them:

  - feat/some-branch (open)

`finalize-branch` rewrites `(open)` as `(landed YYYY-MM-DD)` when the branch
lands. Leave this section empty until the first branch; do not carry a
placeholder line into a real cycle.
-->
