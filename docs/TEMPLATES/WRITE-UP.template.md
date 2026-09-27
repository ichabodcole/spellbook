---
type: write-up # REQUIRED (OKF §3). Do not change it — the file name decides it.
title: "Write-up: [Topic or Question]"
description: "[One sentence: the question this answers, and the answer.]"
tags: [area, question] # 2-4 kebab-case keywords
status: draft # OKF §5.4: draft | stable | deprecated. Nothing else.
generated: { by: your-name-or-model, at: YYYY-MM-DD }
---

<!--
OWNERSHIP (of this template file — not of documents created from it): it is
yours to edit. The scaffold records its hash, so a migration updates it only
while you have not touched it. Frontmatter is the contract the lint enforces;
below it is yours. See docs/SCHEMA.md → "Who owns which file".

USAGE: a write-up is the answer a research item owns. File the question first
(`pdocs new item <slug> --kind research`), then
`bun scripts/pdocs/cli.ts new write-up --owner item/<slug>` writes this as
docs/items/<slug>/write-up.md and links the item. The item holds the state;
this file holds the findings and carries no `lifecycle`. Evidence gathered on
the way goes in the item's `reports/`. See docs/items/README.md.

Use the sections that help you answer the question with evidence. Adapt, merge
or skip them.
-->

# Write-up: [Topic or Question]

**Outcome:** [Feature Recommended | Work Items Filed | No Action Needed | More
Research Needed | Monitoring]

---

## Question

What is being answered, and what decision does the answer feed?

## Current State

What does the code or system look like today? Include code references,
measurements, patterns or pain points.

## Findings

### Evidence

[Code patterns, measurements, technology evaluations, concrete examples. Link
the reports in `./reports/` that hold the detail.]

### Key Observations

[What works? What hurts? What patterns emerged?]

### Options Considered

[If action might be needed: the possible approaches, their tradeoffs and their
complexity. Include "do nothing".]

## Recommendation

Check one and explain:

- [ ] **Propose a feature** — the work is big enough to plan
- [ ] **File work items** — the work is a handful of tasks
- [ ] **No action needed** — the current state is acceptable
- [ ] **Monitor** — watch for named signals or thresholds
- [ ] **More research needed** — questions remain

**Rationale:** [The deciding factor.]

## Next Steps

[What follows from the recommendation: the feature or items to file, the
decision to record, the follow-up to schedule. When the research item is done,
`pdocs set item/<slug> --lifecycle done`.]

## Open Questions (Optional)

[What remains unclear.]

---

**Related Documents:**

- `[Evidence](./reports/YYYY-MM-DD-topic-report.md)`
- `[Code analyzed](../../../src/path/to/code.ts)`
- `[Feature it led to](../../features/feature-name/feature.md)` (if created)
- `[Related architecture](../../architecture/architecture-name.md)`
