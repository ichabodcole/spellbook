---
type: item # REQUIRED (OKF §3). Do not change it — the folder decides it.
title: "[What needs doing, as a short imperative]"
description: "[One sentence: the problem, and what done looks like.]"
status: draft # OKF §5.4: draft | stable | deprecated. `stable` once the user approves this item's content.
lifecycle: triage # triage | backlog | ready | active | review | done | dropped
id: "[uuid]" # a lowercase UUID; `pdocs new item` writes it. Never edit it.
kind: task # task | bug | chore | research
generated: { by: your-name-or-model, at: YYYY-MM-DD }
---

<!--
OWNERSHIP (of this template file — not of documents created from it): it is
yours to edit. The scaffold records its hash, so a migration updates it only
while you have not touched it. Frontmatter is the contract the lint enforces;
below it is yours. See docs/SCHEMA.md → "Who owns which file".

ONCE WRITTEN: delete this whole comment block from the document.

USAGE: `bun scripts/pdocs/cli.ts new item <slug> --kind <kind>` writes
docs/items/<slug>.md from this file, with a fresh `id` and `lifecycle: triage`.
Pass `--title`, `--description` and `--by`, and what you know as flags:
`--parent feature/<slug>`, `--blocked-by <ref,ref>`, `--from <path or ref>`.
Do not copy this file by hand: the `id` must be a fresh UUID, and the CLI
checks every reference before it writes.

WHO WRITES EACH FIELD. Add an optional field only when it applies. After
creation, change a field with `pdocs set <ref> --<field> <value>`; it refuses a
value the lint would reject.

  title, description, kind   whoever files the item
  id                         `pdocs new item`, once
  status                     OKF's document-trust marker: `draft` until
                             the user reviews this item's description and
                             definition of done, `stable` once they approve
                             it (`pdocs set <ref> --status stable`). Wanted
                             before it starts or joins the active cycle:
                             under `checks.workItemReview.mode: warn`, the
                             default, a move without it is reported; under
                             `strict` it is refused. Nothing moves it on its
                             own. An item whose content the user declines to
                             approve does not move, under either mode
  lifecycle                  `triage` when an agent files it. The user decides
                             at triage (the triage-items skill proposes):
                             `backlog`, `ready`, or `dropped`. Shaping sets
                             `ready`; init-branch sets `active`, and so do
                             create-investigation and the investigator
                             agent, for research the user asked for, once
                             they approve its content; finalize-branch sets
                             `review` when its review starts and `done` when
                             it lands. An agent never moves an item out of
                             `triage` itself.

  Optional:
  parent: feature/<slug>     whoever files it, or triage
  scope: <name>              whoever files it; one name from `lint.scopes`
  from: <what spawned it>    whoever files it: an item id, `feature/<slug>`,
                             `cycle/<slug>`, or a docs-root-relative path.
                             A review always writes it.
  source: <external id>      intake from outside the tree: an issue number
  priority: urgent | high | medium | low       triage
  assignee: <agent, seat or name>              triage, when it is routed
  blocked_by: [<item id>, ...]                 shaping
  cycle: <cycle file slug, e.g. 2026-09-auth>  init-branch, when one is active;
                             finalize-branch, for an item it files or closes
  released_in: <version>     sweep-project, at release. Never checked.

docs/items/README.md has the states, the kinds and the rules.
-->

# [Title]

[What is wrong or missing, and where. A bug: what happens, what should happen,
and how to see it. Research: the question, and the decision its answer feeds.]

## Definition of done

- [ ] [An observable result a reviewer can check without asking you]
