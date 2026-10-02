---
type: playbook # REQUIRED (OKF §3). Do not change it — the folder decides it.
title: "[Kind of Work] Playbook"
description: "[The kind of work this covers, and what it gets done.]"
tags: [process, area] # 2-4 kebab-case keywords
status: draft # OKF §5.4: draft | stable | deprecated. Nothing else.
generated: { by: your-name-or-model, at: YYYY-MM-DD }
---

<!--
OWNERSHIP (of this template file — not of documents created from it): it is
yours to edit. The scaffold records its hash, so a migration updates it only
while you have not touched it. Frontmatter is the contract the lint enforces;
below it is yours. See docs/SCHEMA.md → "Who owns which file".

ONCE WRITTEN: delete this whole comment block from the document.

USAGE: `bun scripts/pdocs/cli.ts new playbook <kind-of-work>` copies this to
docs/playbooks/<kind-of-work>-playbook.md and writes its line in index.md.

`description` is how an agent finds this playbook: write the kind of work it
covers. Every line below is an instruction, not a story — see
docs/playbooks/README.md and docs/STYLE.md.
-->

# [Kind of Work] Playbook

## Goal

[What doing this kind of work correctly produces, in one or two sentences. When
this playbook applies, and when it does not.]

## Steps

1. [An imperative step. If it applies only in some cases, name the case first:
   "If the entity is synced, add it to the sync rules."]
2. [The next step, in the order the work happens.]

## Verification

- [ ] [A check that fails when a step was skipped or done wrong: a command and
      what it should print, or something a reviewer can see.]
