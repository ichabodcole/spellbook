---
type: cycle
title: Project-docs next release
description:
  Adopt Cole's next project-docs scaffold release, if it is larger than the
  9.1.0 refresh.
tags: [project-docs, docs]
status: draft
lifecycle: closed
started: 2026-09-28
appetite:
  Convene only if the release's notes show structural or behavioural change; a
  version-string-only release is done as an item outside a cycle.
after: []
generated: { by: claude-opus-5-5, at: 2026-09-28 }
---

# Project-docs next release

## Why now

Cole is cutting a project-docs release on 2026-09-28 and expects it to carry
more than version strings. 9.1.0 took an item, not a cycle; this one may too.

## Scope

- **[item/project-docs-next-release-upgrade](../items/project-docs-next-release-upgrade.md)**
  — adopt the release, verify, and report what still bites upstream (scaffold
  #182).

Out of scope, deliberately: anything in `docs/` beyond what the release asks
for.

## Decision log

Decisions as they are made, with the options not taken.

| #   | Date       | Decision                                                                                                                                                                                                                                                                                                                                                | Options not taken                                                                                                                          |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 2026-10-02 | Cole asked for the upgrade to 9.4.0. Its notes show behavioural change (the review rule, cycle archiving, the Outcome lint, `view portfolio`), which the appetite says would convene a cycle, but the refresh itself had no structural work (0 moves, case 3) and nothing of ours to change, so it was done as the one item and the cycle closes on it. | Convene with implementers and a verifier (nothing to implement: the changes are in the delivered CLI, held by `pdocs check` and the gate). |

## Outcome

Closed 2026-10-02. The tree is on scaffold 9.4.0 (plugin 4.4.0), done as
[item/project-docs-next-release-upgrade](../items/project-docs-next-release-upgrade.md)
in `074560b5`: an owned-file refresh, no documents moved, `pdocs check` clean
and the gate green. Scaffold #182 is answered; the one gap still open, a
duplicate frontmatter key passing the lint, is reported as scaffold #190.

**Learned.** The new review rule flagged this cycle's own item before it could
close: started work now needs an item whose content the owner approved
(`status: stable`), which is the gate this team's items have mostly skipped.

## Sessions
