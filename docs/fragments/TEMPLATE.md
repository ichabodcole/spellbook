---
type: fragment # REQUIRED (OKF §3). Do not change it — the folder decides it.
title: "Fragment: [Brief Description]"
description: "[One sentence: what did not feel right.]"
tags: [area] # 2-4 kebab-case keywords
status: draft # OKF §5.4: draft | stable | deprecated. Nothing else.
lifecycle: open # where the work has got to; see docs/SCHEMA.md
generated: { by: your-name-or-model, at: YYYY-MM-DD }
---

<!--
OWNERSHIP (of this template file — not of documents created from it): it is
yours to edit. The scaffold records its hash, so a migration updates it only
while you have not touched it. Frontmatter is the contract the lint enforces;
below it is yours. See docs/SCHEMA.md → "Who owns which file".
-->

# Fragment: [Brief Description]

**Context:** [Where/when this observation came up - session, feature work, etc.]

## Observation

[What doesn't feel right? What did you work around? What's incomplete? What's an
alternative solution that could be interesting to explore?]

## Why It Might Matter

[What could this affect if it becomes a problem? Why capture this now?]

## Trigger for Revisit

**What would make this worth investigating?**

[Define the conditions that would prompt action. This is the key to making
fragments actionable later. Examples:

- "If tests become flaky"
- "If performance becomes an issue"
- "If we see errors in production"
- "When we have time for tech debt"
- "If this pattern appears elsewhere"
- "When we need to scale beyond X users"
- "If another team reports similar issues"]

## Related Documentation

- Session: [Link to session doc if applicable]
- Code: [Link to relevant files/locations]
- Related: [Other docs that provide context]

## Notes

[Any additional thoughts, details, or context]
