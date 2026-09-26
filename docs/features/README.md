# Features

A feature is an outcome worth shaping: work big enough that its approach has to
be argued before it is built. Its folder holds `feature.md` — the argument, and
the feature's state — and every document the work produces.

## Feature or item?

- **Write a feature** when the work needs options weighed, design decisions made
  or scope drawn, or when it will be split into several items.
- **File a work item** when the work can be described and done without that: a
  known fix, a small refactor, a clear task. See
  [items/README.md](../items/README.md).
- **Still deciding whether to act?** File a research item
  (`pdocs new item <slug> --kind research`). Write the feature if its write-up
  recommends one.
- **Describing a system that exists** belongs in `architecture/` or
  `interaction-design/`; a procedure that recurs belongs in `playbooks/`.

## Creating one

```bash
bun scripts/pdocs/cli.ts new feature oauth-upgrade \
  --title "OAuth Upgrade" --description "One sentence: what this proposes and why."
```

This writes `features/oauth-upgrade/feature.md` from
[FEATURE.template.md](../TEMPLATES/FEATURE.template.md), at
`lifecycle: backlog`. Name the folder in kebab-case, with no date. Then write
the body: the problem, the proposed solution, scope, the technical approach, and
risks.

## Layout

```
features/
├── <slug>/
│   ├── feature.md            # the feature: what it proposes, and its state
│   ├── design-resolution.md  # optional
│   ├── plan.md               # when implementation begins
│   ├── test-plan.md          # optional
│   ├── DEV_KICKOFF.md        # optional, written by dev-kickoff
│   ├── handoff.md            # only when shipping needs more than a merge
│   ├── sessions/             # YYYY-MM-DD-<topic>.md, one per session
│   ├── reports/              # dated evidence
│   └── artifacts/            # anything else the work produces
└── _archive/<slug>/          # done or dropped features only
```

A small feature may be `feature.md` alone. The folder holds whatever the work
needs; a file with a name not listed above is an `artifact`.

## State

`feature.md`'s `lifecycle` is the feature's state. A feature never takes
`triage`: it arrives already accepted.

| State     | Means                                          |
| --------- | ---------------------------------------------- |
| `backlog` | Accepted, and still being shaped (a draft)     |
| `ready`   | Approved to build                              |
| `active`  | Being built                                    |
| `review`  | Built, and waiting on a human or a reviewer    |
| `done`    | Delivered                                      |
| `dropped` | Decided against. The folder stays in the tree. |

The owner's word moves a feature to `ready`, and `create-project` or
`generate-proposal` applies it; `dev-kickoff` moves it to `active` when
implementation starts; `sweep-project` moves it to `done` or `dropped` once the
work is reconciled against what shipped. `finalize-branch` moves the branch's
item, not the feature. Otherwise, change it with
`bun scripts/pdocs/cli.ts set feature/<slug> --lifecycle ready`. Do not write a
`**Status:**` line in the body; `lifecycle` is the one place state lives, and
the lint checks it.

A feature's work is done through items whose `parent` names it
(`pdocs new item <slug> --kind task --parent feature/<slug>`).
`pdocs view feature <slug>` lists them. A feature has no `cycle` field: its
items join cycles.

## What a feature owns

Create each owned document with `--owner`, which puts it in the right place and
links the feature from its Related section:

```bash
bun scripts/pdocs/cli.ts new plan --owner feature/<slug>
bun scripts/pdocs/cli.ts new session <topic> --owner feature/<slug>
```

A work item can own the same documents, created the same way with
`--owner item/<slug>`.

- **`design-resolution.md`** — resolves behaviour, data shape, boundaries and
  architectural placement before planning. Write one when the feature leaves
  questions that would otherwise make the plan speculative: new entities or
  state models, cross-cutting changes, or parallel agents that need clear
  contracts. Skip it when the feature is small and precise.
- **`plan.md`** — the route from the current code to the finished work: coarse
  phases, the pivotal points, and a validation gate for each. Write it when
  implementation is about to start. Ground it in real files and patterns.
- **`test-plan.md`** — tiered verification scenarios for agent-built work. Tier
  1 is smoke (it builds, it renders), Tier 2 the critical paths from the
  feature's goals, Tier 3 the edge cases, deferred with a reason. Write one when
  "did the agent build what was asked?" is a real question. Skip it for
  refactors with no behaviour change, documentation-only work, and changes the
  diff already verifies.
- **`sessions/`** — records of what happened during a working session:
  deviations from the plan, discoveries, what is left. Write one when something
  notable happened; skip it when nothing did. A step a future agent must follow
  goes in a playbook, not only in a session.
- **`write-up.md`** — a finding written up. Usually a research item's job, but a
  feature may record one of its own:
  `pdocs new write-up --owner feature/<slug>`.
- **`reports/`** — dated evidence gathered for the work: an audit, a benchmark,
  a survey of options.
- **`artifacts/`** — freeform working material: codebase exploration, dependency
  analysis, sketches. No template.
- **`handoff.md`** — the steps shipping requires beyond merging: migrations,
  redeploys, configuration, manual coordination. Written at finalization, and
  only when those steps exist.

## Links

- Inside the folder, link relatively: `./plan.md`,
  `./sessions/2026-02-09-initial-implementation.md`.
- To the rest of the tree: `../../architecture/<name>.md`,
  `../../items/<slug>.md`, `../../playbooks/<name>.md`.
- A relationship between entities is a **field**, not a link: an item's
  `parent: feature/<slug>`, `from:` or `blocked_by:`. Links are for reading;
  fields are what `pdocs view` and the lint read.

## Archiving

A `done` or `dropped` feature may move to `features/_archive/<slug>/`:

```bash
bun scripts/pdocs/cli.ts archive feature/<slug>
```

It refuses a feature in any other state, moves the whole folder, and rewrites
every link to and from it. Do not move the folder by hand. Archiving is
optional: `lifecycle` already says the work is over. The `sweep-project` skill
drives it: it reconciles the plan against what was built, confirms with you that
the feature is finished, then archives. A sweep that ends "not yet" is a normal
outcome.

## Templates

The templates for a feature and everything it owns are in `docs/TEMPLATES/`:
`FEATURE`, `DESIGN-RESOLUTION`, `PLAN`, `TEST-PLAN`, `YYYY-MM-DD-SESSION`,
`REPORT`, `HANDOFF` and `WRITE-UP`, each `<NAME>.template.md`. `pdocs new`
copies them for you; each opens with the frontmatter its type requires.
