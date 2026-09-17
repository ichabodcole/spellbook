---
type: handoff # REQUIRED (OKF §3). Do not change it — the folder decides it.
title: "[Feature Name] Development Kickoff"
description: "[One sentence: what the next developer is picking up.]"
tags: [area, feature] # 2-4 kebab-case keywords
status: draft # OKF §5.4: draft | stable | deprecated. Nothing else.
generated: { by: your-name-or-model, at: YYYY-MM-DD }
---

<!--
OWNERSHIP (of this template file — not of documents created from it): it is
yours to edit. The scaffold records its hash, so a migration updates it only
while you have not touched it. Frontmatter is the contract the lint enforces;
below it is yours. See docs/SCHEMA.md → "Who owns which file".

USAGE: Copy this file to your project folder as `handoff.md` when the work
requires specific deployment or integration steps to ship successfully.

Most projects won't need this — only create it when deployment involves more
than merging code (e.g., database migrations, service redeployments, environment
config changes, manual coordination steps).

Create this during branch finalization, when all steps are known.
-->

# Deployment Handoff — [Feature/Change Name]

## Prerequisites

[Systems, services, or states that must exist before deployment. Examples:
environment variables set, feature flags configured, dependent services
updated.]

## Deployment Steps

1. [Step with any dependencies or timing notes]
2. [Step with verification criteria if applicable]
3. [Continue as needed]

## Verification

[How to confirm deployment succeeded. What to check, what endpoints to hit, what
logs to review.]

## Rollback

[How to undo if something goes wrong. Which steps are reversible and which
aren't.]

## Notes

[Timing requirements, coordination with other teams, edge cases, or anything the
deployer should know.]
