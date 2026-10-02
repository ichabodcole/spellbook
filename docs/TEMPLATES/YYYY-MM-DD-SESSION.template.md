---
type: session # REQUIRED (OKF §3). Do not change it — the folder decides it.
title: "[Topic] — YYYY-MM-DD"
description: "[One sentence: what this session did.]"
tags: [area, feature] # 2-4 kebab-case keywords
status: stable # A session is frozen the moment it is written; it is never a draft.
generated: { by: your-name-or-model, at: YYYY-MM-DD }
---

<!--
OWNERSHIP (of this template file — not of documents created from it): it is
yours to edit. The scaffold records its hash, so a migration updates it only
while you have not touched it. Frontmatter is the contract the lint enforces;
below it is yours. See docs/SCHEMA.md → "Who owns which file".

ONCE WRITTEN: delete this whole comment block from the document.

USAGE: `bun scripts/pdocs/cli.ts new session <topic> --owner feature/<slug>` (or
`item/<slug>`) writes this as sessions/YYYY-MM-DD-<topic>.md in the owner's
folder, dated today, and links the owner.

This is your dev journal - write what's relevant, skip what's not. Sessions are informal and flexible.
Focus on what stands out: deviations from plan, unexpected discoveries, what you would do differently.

Sessions serve two audiences:
1. YOU (or future you) - reflecting on what happened, capturing context for later
2. THE NEXT DEVELOPER - if someone takes over your work, this provides breadcrumbs to understand where
   you left off, what issues you hit, and what went off-plan

If everything went smoothly and there's nothing notable, you might only need a few lines.
If you wrestled with a complex bug for hours, write as much as helps capture what happened.

A step a future agent must follow does not stay here: add it, with its check, to
the playbook for that kind of work (docs/playbooks/README.md).

For more guidance, see the owner folder's README: ../../README.md
-->

# [Topic] — YYYY-MM-DD

## Context

[What were you working on? Why? Link the plan if there is one.]

## What Happened

[The journey - write naturally about what you did, what went smoothly, what
didn't.

This is the heart of the session. Describe deviations from plan, unexpected
complexity, bugs encountered, architectural discoveries, anything notable. Use
prose, bullets, whatever flows naturally.

Examples of what to capture:

- "Spent 3 hours debugging X, turned out the issue was Y in file Z"
- "Plan assumed we could reuse component A, but discovered B was incompatible"
- "Refactored X because the original approach had issue Y"
- "Tests revealed edge case Z that wasn't in the plan"]

## Notable Discoveries (Optional)

[Key insights, bugs found, patterns noticed, things that weren't expected.

This can overlap with "What Happened" - use your judgment about whether to
separate or combine.]

## Changes Made (Optional)

[Key files or components modified. Include rationale if it's interesting or
non-obvious.

You don't need to list every file touched - focus on significant changes or
anything that deviated from plan. Example: "Refactored src/foo/bar.ts to use
pattern X instead of Y because of issue Z"]

## Next Time (Optional)

[What would you do differently? If the answer is a step someone must follow,
append it to the playbook for that kind of work and link the playbook here.]

## Follow-up (Optional)

[Open questions, next steps, things to revisit, areas that might need
refactoring, etc.]

---

**Related Documents:**

- `[Plan](../plan.md)` (if implementing from a plan)
- `[Architecture](../../../architecture/doc-name.md)` (if relevant)
- `[Commit hash or PR](link)` (if merged)
