---
type: cycle # REQUIRED (OKF §3). Do not change it — the folder decides it.
title: "[What is in play, in three or four words]"
description: "[One sentence: what this cycle is for.]"
tags: [area, area] # 2-4 kebab-case keywords
status: draft # OKF §5.4: draft | stable | deprecated. Nothing else.
lifecycle: planned # planned | active | closed | abandoned — one active at a time
started: YYYY-MM-DD
appetite: "[When it would be right to stop, in a sentence. Not a date.]"
after: [] # cycles or features this one waits on: cycle/<slug>, feature/<slug>
generated: { by: your-name-or-model, at: YYYY-MM-DD }
---

<!--
OWNERSHIP (of this template file — not of documents created from it): it is
yours to edit. The scaffold records its hash, so a migration updates it only
while you have not touched it. Frontmatter is the contract the lint enforces;
below it is yours. See docs/SCHEMA.md → "Who owns which file".

ONCE WRITTEN: delete this whole comment block from the document.

USAGE: `bun scripts/pdocs/cli.ts new cycle <slug>` writes this as
docs/cycles/YYYY-MM-<slug>.md. That filename is the cycle's identity;
commands take it with or without `.md`.

A cycle is an index over work in play, not a container for it. It lists nothing
in its frontmatter: an item joins it by naming it, `cycle: YYYY-MM-<slug>`
(`init-branch` writes that when it opens a branch), and
`pdocs view cycle YYYY-MM-<slug>` lists its items and says whether it is
closable. Every document stays with the feature or item that owns it.

Set `lifecycle: active` when work starts (`pdocs set cycle/<slug> --lifecycle
active`). At most one cycle is active; `pdocs set` refuses a second.

For more guidance, see: ./README.md
-->

# [What is in play, in three or four words]

## Why now

[Two or three sentences. What makes this the work to do next, rather than any of
the other things that could be done? If the honest answer is "it was next in the
list", say so — that is also a reason.]

## Scope

What this cycle sets out to ship, one line each: the features and items it is
for, and what "done" looks like for each. The live list is
`pdocs view cycle <this file's name>`; this section is the intent.

- **[feature/name]** — [what shipping this means]
- **[item/name]** — [what shipping this means]

Out of scope, deliberately: [the neighbouring things someone would reasonably
expect to be included, and why they are not.]

## Outcome

_Written at close, not before — and for an `abandoned` cycle too._

[What shipped. What was cut, and why. What carried over to the next cycle: each
item still open, and the cycle it joined. What was learned that will change how
the next cycle is scoped. For an `abandoned` cycle, what was falsified: the
assumption that stopped it. Two paragraphs is usually enough; the point is that
a reader six months from now can tell what happened without reading every
session.]

## Sessions

<!--
One line per branch, appended by `init-branch` as it opens them:

  - feature/some-branch (open)

`finalize-branch` rewrites `(open)` as `(landed YYYY-MM-DD)` when the branch
lands. Leave this section empty until the first branch; do not carry a
placeholder line into a real cycle.
-->
