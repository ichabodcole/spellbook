# The documentation contract

You are (probably) an agent about to add or change a document under `docs/`.
This file is the whole contract — read it once, then work. It governs
**structure**; the content lives in the pages.

Three things are stated here: how strictly each folder is checked
([The two tiers](#the-two-tiers)), what every document's frontmatter says
([Frontmatter](#frontmatter--every-page)), and how work is tracked — features,
work items and cycles, whose states and relationships are fields
([Features, work items and cycles](#features-work-items-and-cycles)).
`STYLE.md`, beside this file, is the companion contract for prose.

## What this layer is

Every document under `docs/` carries [OKF](https://openknowledgeformat.org)
frontmatter, and `scripts/pdocs/` checks it. That gives two things nothing else
here gives:

- **A graph.** Links, `related:` keys and tags are edges.
  `bun scripts/pdocs/cli.ts graph --format json` emits the whole thing —
  backlinks, hubs, tags — so a reader arriving cold can find what relates to
  what without reading everything.
- **A contract that is enforced.** Each folder's README states how its documents
  work. A contract nothing checks is a comment that lies, and this tree has had
  several: `**Status:** Approved (in flight)` was invented by hand in three
  files because the vocabulary had no word for it.

Two audiences, one source of truth. **Agents** read these files raw, which is
why everything below insists on plain Markdown and a machine-checkable link
graph. **Humans** read them rendered on GitHub, which is why links are relative
and anchors are heading slugs. Neither audience needs a render app for the tree
to be usable, and it never will.

## The two tiers

The library/workbench split is a property of the **folder**, not of a document's
location — nothing is nested under a `wiki/` root to earn it.

| Tier      | Applies to                                                                                             | Checks                                                                                                                                                                                                                                                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Thin**  | the workbench: `features/` `items/` `cycles/`                                                          | frontmatter present · `type` matches the position · `status` and `lifecycle` in vocabulary · required fields present · `generated` well-formed · `tags` a list · no frontmatter string, date or H1 still its template's placeholder, no `tags` of only `area`/`feature` · links and anchors resolve · the work rules in [What the lint checks about work](#what-the-lint-checks-about-work) |
| **Graph** | the library: `architecture/` `specifications/` `interaction-design/` `playbooks/`, plus the root pages | everything Thin checks — `tags` required rather than optional — plus: every page reachable from `index.md` · its catalog line states the page's own `description` · `related:` keys resolve · `--json` emits the graph                                                                                                                                                                      |

The difference is **reachability**. A library page that nothing links to is
lost, so the catalog is a hard requirement. A workbench document is found
through the feature or item that owns it, and through `pdocs find` and
`pdocs view`, which read its fields — so cataloguing it would be a chore with no
reader.

**Outside the docs root there is a third corpus, and it has no tier.** Every
Markdown file git tracks outside `docs/` — `README.md`, `AGENTS.md`, a
`DEV_KICKOFF.md` left at the repository root — is read for its links and anchors
and nothing else: no frontmatter, no `type`, no catalog. A file joins it on
`git add`, not by being listed. Its problems print among the workbench's, with a
path relative to the repository root like every other row — so a bare
`DEV_KICKOFF.md` in the output is the file at the root, not one somewhere under
`docs/` — and `check` counts the corpus under the workbench summary: _N tracked
page(s) outside `docs/`, links only_. A file in it that is not yours to fix
comes out with `lint.exclude`, below; the globs are relative to the repository
root and reach this corpus too.

### Declaring your own folder

The folder lists above are defaults, not a ceiling. A project that wants
`docs/runbooks/` adds the folder to a tier and names the `type` its pages carry,
both in `.project-docs.json`:

```json
"lint": {
  "workbench": ["features", "items", "cycles", "runbooks"],
  "types": { "runbooks": "runbook" }
}
```

`types` maps folder to type. The **tier follows from the array you list the
folder in** — `workbench` for the thin checks, `durable` for the full graph
tier. A durable declaration carries the catalog obligation like any other
library folder: the page must be reachable from `index.md` or the lint reports
`ORPHAN`.

A declared type is **lintable but not creatable**. `pdocs new` will not make
one, because the scaffold ships no template for it, and says so rather than
failing obscurely. `pdocs find --type runbook` works, and `find` rejects a type
this project has not declared — naming the resolved set, which includes yours.

A declaration that collides with a folder or type the scaffold already ships is
ignored; the built-in row wins.

The same mechanism keeps a retired type. A project that still has
`docs/memories/` lists `memories` in `durable` and declares
`"types": { "memories": "memory" }`, and its pages stay lintable; see
[Retired types](#retired-types).

## Layout

```
docs/
  SCHEMA.md            ← this contract (exempt from its own rules)
  STYLE.md             ← how prose is written here (contract page, seeded)
  index.md             ← the catalog: ONE line per library page
  README.md            ← how to choose a document type (contract page)
  PROJECT_MANIFESTO.md ← type: manifesto   (graph tier)
  PROJECT-SUMMARY.md   ← type: summary     (graph tier; written by a command,
                         and absent until you run it)

  architecture/        ← type: architecture   ┐
  specifications/      ← type: specification  │ the library — graph tier
  interaction-design/  ← type: interaction    │
  playbooks/           ← type: playbook       ┘

  features/            ← one folder per feature: <slug>/feature.md  ┐
  items/               ← <slug>.md, or <slug>/item.md               │ the workbench —
  cycles/              ← type: cycle, YYYY-MM-<slug>.md             │ thin tier
  TEMPLATES/           ← the work templates (forms, not linted)     ┘

  <foreign>/           ← another tool's tree, if you have one; name it in
                         `lint.skip` and no tier walks it
  features/_archive/   ← done or dropped features; linted, moved by `pdocs archive`
  items/_archive/      ← done or dropped items; the same
```

Not every row is present in every project. `PROJECT-SUMMARY.md` and the
`<foreign>/` row in particular are optional — the first appears when someone
runs the summary command, and the second only if some other tool keeps a
directory under your docs root.

Inside `features/` and `items/`, a document's `type` comes from its position in
the owner folder, not from a folder of its own:

| Position in `features/<slug>/` or `items/<slug>/` | `type`              |
| ------------------------------------------------- | ------------------- |
| `feature.md` (features only)                      | `feature`           |
| `item.md` (items only), or `items/<slug>.md`      | `item`              |
| `plan.md`                                         | `plan`              |
| `design-resolution.md`                            | `design-resolution` |
| `test-plan.md`                                    | `test-plan`         |
| `DEV_KICKOFF.md`                                  | `kickoff`           |
| `handoff.md`                                      | `handoff`           |
| `write-up.md`                                     | `write-up`          |
| `sessions/YYYY-MM-DD-<slug>.md`                   | `session`           |
| `reports/YYYY-MM-DD-<slug>-report.md`             | `report`            |
| anything else, usually under `artifacts/`         | `artifact`          |

A `feature.md` under `items/`, or an `item.md` under `features/`, is
`MISPLACED ENTITY`. `_archive/` is recognised only directly under `features/` or
`items/`, and an archived entity is typed exactly like a live one.

`README.md`, `AGENTS.md`, `CLAUDE.md` and `STYLE.md` are **contract pages**:
meta-documents about the tree rather than entries in its type system. They carry
no frontmatter, and the lint checks only their links. So does this file.

A `TEMPLATE` is a form, not a document. Its links are placeholders by
construction, so the lint skips it entirely. In the repository that maintains
this scaffold, a test renders every template with its placeholders filled and
asserts the result passes — that is what keeps a template honest without gating
on a file that cannot itself pass. That test does not ship with the payload; if
you edit a template here, render a copy and lint it.

### Files that are not documentation

Some `.md` files in a project are not documents at all. A Slidev or Marp deck is
the clearest case: its frontmatter (`marp`, `theme`, `paginate`, `layout`)
belongs to the slide renderer, and the file is a program that happens to be
written in Markdown. Widening this schema's vocabulary until such a file fits
would be describing it wrongly to make a gate quiet. A draft of another tool's
file kept under `docs/` is the same case: a Claude Code `SKILL.md` draft carries
`name:`, the key set here is closed, and no field you add makes `name` known —
the lint's `UNKNOWN FIELD` row on a file with no `type` points here.

List them in `lint.exclude` in `.project-docs.json`, as globs relative to the
repository root. A matched file is invisible to every tier — no frontmatter, no
links, no graph:

```json
"exclude": ["docs/features/*/artifacts/*-prototype.md"]
```

A fresh project excludes nothing, and `exclude` starts empty. The example above
is the shape the entry takes when a project does have such a file — a runnable
deck kept inside a feature's `artifacts/` because it is part of that feature's
record.

Glob syntax is `Bun.Glob` — `*` within a path segment, `**` across segments, `?`
for one character, `{a,b}` for alternation. A literal brace in a path must be
escaped as `\{`.

`lint.exclude` is not `lint.skip`. `skip` names **directories**, matched at any
depth, and prunes whole subtrees during the walk. `exclude` filters **individual
files** by path. Reach for `skip` when a whole tree is not yours, and `exclude`
when a particular file is not a document. Do not put `_archive` in `skip`:
`features/_archive/` and `items/_archive/` are read whatever `skip` says,
because the lint checks that only finished work sits there.

## Frontmatter — every page

[OKF 0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
requires exactly one field, `type`. Everything else below is our convention;
§4.1 of the spec permits additional keys outright and requires consumers to
preserve the ones they do not recognise.

```yaml
---
type: playbook # REQUIRED (OKF §3). Also selects the page shape and the vocabulary below.
title: Writing a Migration Playbook # the display name; matches the H1
description: Writing a migration an agent can run — one specific step at a time. # ONE sentence
tags: [migrations, agent-execution, documentation] # 2–4 kebab-case keywords
related: [playbook/release-playbook, architecture/sync-engine-architecture] # optional: `type/slug` edges
status: stable # OKF §5.4: draft | stable | deprecated. Nothing else, ever.
generated: { by: claude-opus-5, at: 2026-09-03 } # OKF §5.2, replaces `timestamp`
---
```

- **`status` is OKF's field and OKF's vocabulary.** `draft` (not yet reviewed),
  `stable` (ready to be relied on, and the spec's default when absent),
  `deprecated` (kept for links and history; no longer current). It is required
  explicitly so a reader never has to know the default to know what a document
  claims about itself.
- **`lifecycle` is ours, and it is a different question.** `status` says whether
  a document can be trusted; `lifecycle` says where the work it describes has
  got to. Widening `status` to carry both — `status: approved` — would put a
  value in a field where the spec says it cannot occur.
- **`generated`** is `{ by, at }`. `by` is the actor that produced the content,
  usually a model; `git blame` cannot record it, because it names whoever
  committed the file. `unknown` is a legal actor and is the honest encoding for
  a document whose producer was never captured. `at` is `YYYY-MM-DD`.
- **`description` doubles as the catalog hook**, verbatim. If it does not earn a
  click, tighten it. The lint compares the two after collapsing whitespace and
  undoing Prettier's markdown escapes, so the two copies may be wrapped
  differently — "verbatim" is about the words, not the line breaks.
- **`related:` is `type/slug`, and `slug` is the filename without `.md`** — so a
  page can move between folders without every edge pointing at it having to be
  rewritten. Edges are resolved **against library pages only**, because those
  are the pages the graph tier walks; there is no key for a feature, an item or
  a session, and writing one produces `BAD related`. Two library pages with the
  same basename and type would make a key ambiguous, so the lint reports that as
  `DUPLICATE KEY` rather than silently picking one. Link to workbench documents
  in the body.

  The thin tier does not resolve `related:` at all — it isn't walking the graph
  — so a bad edge on a workbench document is silently accepted rather than
  reported. That is a reason not to write one there, not permission to. Write
  the link in the body, where it is checked.

- **Computed, never authored:** backlinks, orphan status, tag adjacency. The
  lint derives them from links and `related:`; hand-maintaining them guarantees
  they go stale.

## Lifecycle by type

This table is the source of truth for both vocabularies. The lint parses it and
fails if the registry it enforces disagrees, so the prose cannot drift from the
gate — which is the way round that drift always goes.

`—` means the type carries no `lifecycle` at all, and writing one is an error.
"A feature or item" in the Where column means the owner folder,
`features/<slug>/` or `items/<slug>/`.

| `type`              | `lifecycle` values                                                        | Tier  | Where                                        |
| ------------------- | ------------------------------------------------------------------------- | ----- | -------------------------------------------- |
| `architecture`      | —                                                                         | graph | `architecture/`                              |
| `specification`     | —                                                                         | graph | `specifications/`                            |
| `interaction`       | —                                                                         | graph | `interaction-design/`                        |
| `playbook`          | —                                                                         | graph | `playbooks/`                                 |
| `manifesto`         | —                                                                         | graph | `PROJECT_MANIFESTO.md`                       |
| `summary`           | —                                                                         | graph | `PROJECT-SUMMARY.md`                         |
| `index`             | —                                                                         | graph | `index.md`                                   |
| `feature`           | `backlog` · `ready` · `active` · `review` · `done` · `dropped`            | thin  | `features/<slug>/feature.md`                 |
| `item`              | `triage` · `backlog` · `ready` · `active` · `review` · `done` · `dropped` | thin  | `items/<slug>.md`, or `items/<slug>/item.md` |
| `cycle`             | `planned` · `active` · `closed` · `abandoned`                             | thin  | `cycles/`                                    |
| `plan`              | `draft` · `active` · `completed` · `abandoned`                            | thin  | `plan.md` in a feature or item               |
| `design-resolution` | `draft` · `resolved` · `superseded`                                       | thin  | `design-resolution.md` in a feature or item  |
| `test-plan`         | `draft` · `ready` · `active` · `completed`                                | thin  | `test-plan.md` in a feature or item          |
| `kickoff`           | —                                                                         | thin  | `DEV_KICKOFF.md` in a feature or item        |
| `handoff`           | —                                                                         | thin  | `handoff.md` in a feature or item            |
| `write-up`          | —                                                                         | thin  | `write-up.md` in a feature or item           |
| `session`           | —                                                                         | thin  | `sessions/` in a feature or item             |
| `report`            | —                                                                         | thin  | `reports/` in a feature or item              |
| `artifact`          | —                                                                         | thin  | anything else in a feature or item           |

**Why the library types carry none.** A living page is never "done"; it is
current or it is not, and `status` already says which. Adding a lifecycle to a
playbook would invite someone to mark it `completed`, which is not a thing a
playbook can be.

**Why sessions, reports, write-ups and artifacts carry none.** They are frozen
records of a moment. `generated.at` is their only date, and they are never
brought up to date — a `lifecycle` on a session invites an edit that destroys
what the document is for. A research item's state lives on the item, not on its
write-up. A `kickoff` is a briefing written once and read at the start of
implementation. A `handoff` is its bookend — what shipping the work requires
once it is built, written at finalization and read at deploy.

`plan`, `design-resolution` and `test-plan` do hold state, because a plan is
followed and then finished, a design question is open until it is answered, and
a list of scenarios is written before it is run. `ready` on a test plan means
the scenarios exist and nothing has been executed against them yet.

## Retired types

`proposal`, `backlog`, `fragment`, `brief`, `investigation`, `lesson` and
`memory` were retired in 9.0.0. The lint no longer knows them — a tree that
still has them runs the `v2.10-to-v3.0` migration, which converts every one (and
keeps `memories/` and `lessons-learned/` declared in `lint.types`, as above) —
and `pdocs new` refuses each, naming its replacement:

| Retired            | Write instead                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `proposal`         | a feature — `pdocs new feature <slug>`                                                                                    |
| `backlog`          | a work item — `pdocs new item <slug> --kind task`                                                                         |
| `fragment`         | a work item left in `triage`                                                                                              |
| `brief`            | a work item in `triage`, or a feature                                                                                     |
| `investigation`    | a research item and its write-up — `pdocs new item <slug> --kind research`, then `pdocs new write-up --owner item/<slug>` |
| `lesson`, `memory` | a step and its verification in the playbook for that kind of work (`playbooks/README.md`)                                 |

## Features, work items and cycles

Work is tracked with three entities. Everything else in `features/` and `items/`
is a document **owned** by one of them.

| Entity    | What it is                                                                   | Its file                                     |
| --------- | ---------------------------------------------------------------------------- | -------------------------------------------- |
| Feature   | An outcome worth shaping. Its `feature.md` argues for it and holds its state | `features/<slug>/feature.md`                 |
| Work item | One unit of work, small enough to hand an agent. `kind` says what sort       | `items/<slug>.md`, or `items/<slug>/item.md` |
| Cycle     | What is in play now: an appetite and an outcome                              | `cycles/YYYY-MM-<slug>.md`                   |

- **A folder means "these files belong to one entity".** Never "these share a
  state, a parent or a cycle": those are fields. A feature is always a folder.
  An item is a single file until it owns a document; then it becomes
  `items/<slug>/item.md` with the document beside it.
- **Promotion is done by the CLI.** `pdocs new <owned-type> --owner item/<slug>`
  promotes a single-file item first; `pdocs promote item/<slug>` does it alone.
  Either rewrites every link to and from the moved file.
- **A research item** is the asking: the question, its definition of done, and
  its state. Its answer is the `write-up.md` it owns, and the evidence behind it
  is its `reports/`. Three files, kept apart.
- **Create them with `pdocs`** — here and below, `pdocs` means
  `bun scripts/pdocs/cli.ts`. `pdocs new feature <slug>`,
  `pdocs new item <slug> --kind <kind>`, `pdocs new cycle <slug>`, and
  `pdocs new <type> --owner feature/<slug>|item/<slug>` for an owned document,
  which also links the owner from its Related section. Change fields with
  `pdocs set <ref> --<field> <value>`; it refuses a change the lint would
  reject.

### Fields

Every field has a named writer. A field nobody writes goes stale.

| Field         | On            | Required | Values                                                | Written by                                                                              |
| ------------- | ------------- | -------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `id`          | item          | yes      | a lowercase UUID                                      | `pdocs new item`, once; never edited                                                    |
| `kind`        | item          | yes      | `task` · `bug` · `chore` · `research`                 | whoever files the item                                                                  |
| `lifecycle`   | feature, item | yes      | the states in [State groups](#state-groups)           | see [Who moves an item](#who-moves-an-item)                                             |
| `parent`      | item          | no       | `feature/<slug>`                                      | whoever files it, or triage                                                             |
| `scope`       | feature, item | no       | one name declared in `lint.scopes`                    | whoever files it                                                                        |
| `from`        | item          | no       | a reference ([References](#references))               | whoever files it, when something spawned it; a review always writes it                  |
| `source`      | item          | no       | any string: an issue number, an external capture's id | intake from outside the tree, always                                                    |
| `priority`    | item          | no       | `urgent` · `high` · `medium` · `low`                  | triage                                                                                  |
| `assignee`    | item          | no       | any string: an agent, a seat or a name                | triage, when the item is routed to a particular agent or seat                           |
| `blocked_by`  | item          | no       | a list of item ids                                    | shaping — whoever writes the definition of done                                         |
| `cycle`       | item          | no       | a cycle's slug                                        | `init-branch`, when a cycle is active                                                   |
| `released_in` | feature, item | no       | the version that first shipped it                     | `sweep-project`, at release. Never checked: `pdocs view unreleased` lists what lacks it |

`title`, `description`, `status` and `generated` are required on every document,
as in [Frontmatter](#frontmatter--every-page). On an item, `status` is OKF's
document-trust marker: it keeps the value the template gives it, and no workflow
step moves it. Where the work has got to is `lifecycle`, never `status`. An
item's body carries its definition of done. There are no estimates and no due
dates.

`assignee` routes work to an agent or a seat. It does not track people, and it
is optional because in the common case — one person and the agent they work with
— it would name the same party every time.

### Who moves an item

| Move                                       | Who                                                                                                                                                                                                                      | How                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| created → `triage`                         | an agent that files an item: a reviewer's finding, a bug hit mid-task                                                                                                                                                    | `pdocs new item` (the default)                        |
| created → `backlog` / `ready`              | a person who already wants it, or an agent filing items the user has just approved (a plan's item list: `generate-dev-plan`)                                                                                             | `pdocs new item … --lifecycle ready`                  |
| created → `active`                         | `create-investigation` or the `investigator` agent, for research the user asked for                                                                                                                                      | `pdocs new item … --kind research --lifecycle active` |
| created → `review`                         | `finalize-branch`, for work that ran without an item; it moves to `done` when the branch lands, so it is born done                                                                                                       | `pdocs new item … --lifecycle review`                 |
| `triage` → `backlog`, `ready` or `dropped` | the user, at a triage step they have seen: the `triage-items` skill proposes each item's disposition, `priority`, `assignee` and `parent`, and applies them once the user agrees                                         | `pdocs set <ref> --lifecycle backlog …`               |
| `backlog` → `ready`                        | shaping: settling an accepted item's definition of done, once nothing blocks it. A shaped item that is still blocked stays `backlog`; `finalize-branch` moves it to `ready` when the last item in its `blocked_by` lands | `pdocs set <ref> --lifecycle ready`                   |
| `backlog` / `ready` → `active`             | `init-branch`, when a branch starts on it                                                                                                                                                                                | `pdocs set <ref> --lifecycle active`                  |
| → `review`                                 | `finalize-branch`, when the branch's review starts; or whoever else hands the work to a human or a reviewer to wait on                                                                                                   | `pdocs set <ref> --lifecycle review`                  |
| → `done`                                   | `finalize-branch`, when the branch lands; for research that concludes without a branch, `create-investigation` or the `investigator` agent                                                                               | `pdocs set <ref> --lifecycle done`                    |
| → `dropped`                                | whoever decides against it. Nothing is deleted                                                                                                                                                                           | `pdocs set <ref> --lifecycle dropped`                 |

`init-branch`, `finalize-branch`, `sweep-project` and `triage-items` are skills
in the project-docs Claude Code plugin. `init-branch` offers the items
`pdocs view ready` lists, and starts a `backlog` item only when the user names
it; an item in `triage` is triaged first.

`pdocs set` does not check who is calling: the triage step is a rule the skills
follow, not a gate in the CLI. An agent does not move an item out of `triage` on
its own judgement. Without the `triage-items` skill, show the user each item and
the change you propose, and run `pdocs set` only after they agree.

A feature arrives already accepted, so it has no `triage`: `backlog` while it is
being shaped, `ready` once it is approved to build. Its writers:

| Move                  | Who                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------- |
| created → `backlog`   | `pdocs new feature` (the default), through `create-project`                              |
| `backlog` → `ready`   | the owner's word that it is approved, applied by `create-project` or `generate-proposal` |
| `ready` → `active`    | `dev-kickoff`, when implementation starts                                                |
| → `done` or `dropped` | `sweep-project`, once the work is reconciled against what shipped                        |

`finalize-branch` moves the branch's item, not its parent feature.

### References

| Field        | Written as                                                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `parent`     | `feature/<slug>`                                                                                                              |
| `cycle`      | the cycle file's name without `.md`: `2026-09-auth`                                                                           |
| `blocked_by` | a list of full item ids: `[01a0d0da-7ab7-7791-8963-aea6b1e53566]`                                                             |
| `from`       | a full item id, `feature/<slug>`, `cycle/<slug>`, or a docs-root-relative path: `features/auth/sessions/2026-09-22-review.md` |

On the command line, `pdocs` also accepts `item/<slug>` and any unique id prefix
of 8 or more characters wherever it takes an item, and **writes** the full id.
It prints each id by its shortest prefix no other id in the tree shares, and
never fewer than 12 characters: an id begins with a 12-character timestamp, so
ids filed in the same instant share all of those. `--format json` output carries
the full id.

### What the lint checks about work

| Finding                                                 | Means                                                                 |
| ------------------------------------------------------- | --------------------------------------------------------------------- |
| `MISSING id` / `kind`                                   | an item lacks a required field                                        |
| `BAD ID`, `BAD KIND`, `BAD PRIORITY`                    | a value outside its vocabulary; an uppercase id is reported too       |
| `BAD LIFECYCLE`                                         | a state the type does not take — `triage` on a feature, say           |
| `BAD PARENT`, `BAD CYCLE`, `BAD BLOCKED_BY`, `BAD FROM` | a reference that resolves to nothing, or to the wrong kind of thing   |
| `BLOCKED CYCLE`                                         | `blocked_by` loops, or an item blocks itself                          |
| `BAD SCOPE`                                             | a `scope` not declared in `lint.scopes`, or more than one value       |
| `DUPLICATE ID`, `DUPLICATE SLUG`                        | two items share an id, or one slug exists both live and archived      |
| `MISSING ENTITY FILE`                                   | a folder in `features/` or `items/` with no `feature.md` or `item.md` |
| `MISPLACED ENTITY`                                      | a `feature.md` under `items/`, or an `item.md` under `features/`      |
| `ARCHIVED NOT TERMINAL`                                 | something in `_archive/` that is not `done` or `dropped`              |
| `ITEM DELETED`                                          | an item left the tree without reaching `dropped`                      |

`released_in` is never checked.

**Nothing is deleted; it is dropped.** `pdocs check` compares the items in the
working tree with those at `HEAD`: an item that is gone, and was not `dropped`
there, is `ITEM DELETED`. A move, a promotion or an archive keeps the `id` and
is not a deletion. In CI the working tree **is** `HEAD`, so name the base
branch: `pdocs check --against origin/main`. Outside a git repository the check
is skipped.

### Declaring scopes

`scope` names the part of the project a feature or item touches, one value per
document, from a list you declare:

```json
"lint": { "scopes": ["api", "cli", "docs"] }
```

A fresh project declares none, so any `scope` is `BAD SCOPE` until you add it.
`pdocs view scope <name>` lists what touches one.

### Views

Backlogs, boards and roadmaps are **derived**, never written. `pdocs view`
computes them from the fields:

| View                                         | Shows                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `pdocs view backlog`                         | unstarted items (`triage`, `backlog`, `ready`), by priority                                      |
| `pdocs view board [--features]`              | live items (and features) grouped by state group                                                 |
| `pdocs view ready`                           | `ready` items whose blockers are all `done` — what an agent can start                            |
| `pdocs view feature <slug>`                  | a feature and the items whose `parent` names it                                                  |
| `pdocs view cycle <slug>`                    | the items naming a cycle (`<slug>` is its file name, `2026-09-auth`), and whether it is closable |
| `pdocs view scope <name>`                    | features and items in one scope                                                                  |
| `pdocs view unreleased [--since YYYY-MM-DD]` | `done` features and items with no `released_in`                                                  |
| `pdocs view released <version>`              | what shipped in a version                                                                        |

`pdocs find --kind`, `--parent`, `--cycle`, `--scope` and `--id` filter the same
fields.

## State groups

Work items and features carry these states in `lifecycle`, and each state
belongs to exactly one group. The lint parses this table and fails if the
grouping it enforces disagrees. A feature never takes `triage`.

| Group       | State     | Means                                                                  |
| ----------- | --------- | ---------------------------------------------------------------------- |
| `unstarted` | `triage`  | Filed, and nobody has decided to take it on                            |
| `unstarted` | `backlog` | Accepted, and not yet shaped                                           |
| `unstarted` | `ready`   | Shaped and unblocked: an accepted definition of done, nothing blocking |
| `started`   | `active`  | Being worked                                                           |
| `started`   | `review`  | Waiting on a human or a reviewer                                       |
| `completed` | `done`    | Finished                                                               |
| `cancelled` | `dropped` | Will not be done; the record stays in the tree                         |

## Archiving

`lifecycle` is the source of truth; `_archive/` mirrors it so the live folders
stay short to scan.

- Only `items/_archive/` and `features/_archive/` exist, and only an entity in
  `done` or `dropped` may sit there. The lint checks it
  (`ARCHIVED NOT TERMINAL`).
- **`pdocs archive <ref>` is the only way in.** It refuses an entity that is not
  `done` or `dropped`, moves the file or folder, and rewrites every link to and
  from it. References by id are untouched. Do not move files into `_archive/` by
  hand.
- Archiving is optional. A finished item may stay where it is.
- Cycles and owned documents are not archived. A cycle's `lifecycle: closed` is
  its archive.

## The cycle

A **cycle** answers "what are we doing right now": a thin index over the work in
play.

- **Scope-bound, not time-boxed.** It closes when its work ships or is cut, not
  on a date. It has an `appetite` — a sentence saying when it would be right to
  stop — rather than an end date.
- **At most one is `active`.** The lint enforces it, and `pdocs set` and
  `pdocs new` refuse a second. Two active cycles mean the answer to "what are we
  doing" is a list, which is the state a cycle exists to prevent.
- **Membership lives on the items.** An item joins a cycle by naming it in
  `cycle:`. The cycle file lists nothing; `pdocs view cycle <slug>` derives its
  scope. The `scope:` key on a cycle is retired: `scope` now names the part of
  the project a feature or item touches. A cycle carrying `scope:` is reported
  `UNKNOWN FIELD`; the `v2.10-to-v3.0` migration moves it onto the items.
- **An index, never a container.** Plans, sessions and artifacts stay with the
  feature or item that owns them, which outlives every cycle that touched it.
- **Closable** when it has at least one item and every item is `done` or
  `dropped`. `pdocs view cycle <slug>` says so.

Frontmatter beyond the common fields: `appetite`, `started`, `closed` (at close)
and `after` (cycles or features it waits on). Body: **Why now** · **Scope**
(what it sets out to ship) · **Outcome** (written at close: what shipped, what
was cut, what was learned) · **Sessions** (the branches worked under it).

## Hard rules

0. **Read the neighbours first.** Before writing, read the folder's `README.md`
   and, when there is one, an existing sibling of the same `type`. That sibling
   is the live example for anything this contract does not spell out.
1. **Plain Markdown only.** No framework components, no HTML beyond what GitHub
   renders. A page that needs an interactive widget is tooling, not a page.
2. **Relative `.md` links** between documents
   (`../architecture/sync-engine.md#backpressure`). They must resolve on GitHub
   and in a bare editor — never absolute URLs into this repo. Anchors are
   GitHub-style slugs of the target heading, and you link only anchors you have
   verified exist. The lint checks both. **A link may leave `docs/`; it may not
   leave the repository.** `../../src/sync.ts` resolves in every checkout. A
   sibling checkout (`../../../other-repo/plan.md`) or an absolute path
   (`/Users/you/Projects/other-repo`, or one into this repository) exists on the
   machine that wrote it and nowhere else, so under `docs/` a target that is
   absolute, or resolves outside the repository — or climbs above it and comes
   back in through the checkout's own folder name — is `MISSING FILE` even when
   the file is on your disk: the failure you would otherwise meet first in CI.
   The repository is git's top level, so in a monorepo a link above
   `.project-docs.json` still resolves. Name another repository in prose, or
   link its URL.
3. **Frontmatter on every document.** `type` is mandatory; the rest is the table
   above.
4. **A library page gets one line in `index.md`** — link plus its `description`,
   verbatim, never content — under its type's heading, below the entries already
   there. If the heading still says `_No pages yet._`, that line is a
   placeholder: replace it with your entry rather than adding beneath it.
   Nothing checks this — an orphaned "No pages yet" above a list of pages is a
   lie the lint cannot see.
5. **No library page is an orphan.** Reachable from `index.md`, transitively.
6. **Truth comes from the code, not from prior prose.** Names, ranges and
   behaviour are verified against the source at writing time. A stale document
   is worse than none.

## Who owns which file

Three classes decide what a migration does to a **documentation file**, and the
rule that decides between them is: **does shipped tooling read it?** A fourth,
**structural**, covers files that carry no content at all — the `.gitkeep`
placeholders holding empty `_archive/` directories open.

| Class      | What a migration does                                                                                  | Which files                                                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Owned**  | Overwrites, every time                                                                                 | `docs/README.md`, `docs/AGENTS.md`, this file, every category `README.md`, `scripts/pdocs/**`                                                                                                                                               |
| **Seeded** | Updates only while you have not edited it                                                              | `docs/STYLE.md`; every template, by exact name: `TEMPLATE.md`, `TEMPLATE-<variant>.md`, `YYYY-MM-DD-TEMPLATE-<type>.md`, `<name>.template.md`, and anything under a `TEMPLATES/` directory; plus every path `docs/.pdocs-seed.json` records |
| **Theirs** | Never rewrites your prose; a major migration may move a document and rewrite its frontmatter and links | `.project-docs.json`, root `AGENTS.md`/`CLAUDE.md`, `docs/PROJECT_MANIFESTO.md`, `docs/index.md`, and every document you write                                                                                                              |

`.project-docs.json` is **theirs** with one exception a migration names when it
happens: it sets the top-level `version` there, patched in place in the file's
own text so your formatting is kept, and adds a key only when a first adoption
finds it missing. Nothing else in the file is written.

**A document you wrote is still yours when a migration moves it.** A major
migration that changes the layout — `projects/<slug>/proposal.md` becoming
`features/<slug>/feature.md`, say — moves your documents, rewrites their
frontmatter to the new vocabulary, and rewrites the links to and from them. It
never rewrites your prose, never deletes a document, and names every move it
makes. A minor migration does none of this.

`docs/index.md` is **theirs** even though the scaffold ships a skeleton: it is
your catalog of your own pages, and no migration copies over it. It is one of
only two files `scripts/check-mirror.sh` exempts by name, for exactly that
reason. A migration that overwrote it would leave every library page reporting
`ORPHAN`.

`docs/CLAUDE.md` is **owned** though the table does not name it: three lines
pointing an agent at `docs/README.md`, describing scaffold structure rather than
your project. Note that "overwrites, every time" describes the class, not every
migration — `v2.8-to-v2.9` refreshes only `scripts/pdocs/` and this file. A
migration refreshes the owned files it has reason to.

**Owned** files are read by code. The lint implements this file; editing your
copy makes your spec disagree with your linter, and the next migration will take
it back without asking. Change behaviour through `.project-docs.json` instead —
it is yours, and it is where the tiers, the exclusions and your own `types`
live.

**Seeded** files are installed once and then negotiated. The five name shapes
are exact, not a substring match: a page named `templates.md` is a document and
is linted as one. The `v2.8-to-v2.9` adoption recorded templates by an older
rule — any `.md` whose name contains `TEMPLATE`, plus every `*.template.md` —
which names the same files as the five shapes on every template the scaffold
ships; and a recorded path stays seeded whatever it is called, because the
manifest is consulted alongside the shapes. `docs/.pdocs-seed.json` records the
sha256 of each one as installed. A migration compares:

| On disk                     | What happens                                             |
| --------------------------- | -------------------------------------------------------- |
| matches what we recorded    | updated, and the new hash recorded                       |
| differs                     | **kept**, and reported by name so you can see ours moved |
| absent from the manifest    | **kept** — unknown is not permission                     |
| recorded but you deleted it | **stays deleted** — deleting is an edit                  |
| neither recorded nor there  | installed; it is new in this version                     |

Note the asymmetry between the last two rows. "Stays deleted" holds for a file
you deleted **after** it was recorded. A file you deleted **before** the
manifest existed is indistinguishable from one this version adds, so it comes
back. Nothing can tell those two apart, and the first migration is the only run
where it arises.

`docs/STYLE.md` is seeded by path rather than by shape: it is a page you read
and follow, not a form, so the lint still checks its links.

So a template is yours to restructure. The **frontmatter block is the contract**
— `pdocs new` fills `type` from the registry regardless, but a hand-copied
template gets no such repair, and the lint will reject the document rather than
the template. Everything below the frontmatter is yours.

The first migration on a project that has no manifest reads every file as
absent-from-the-manifest, so it adopts your tree as it stands rather than
rewriting it.

**No migration performs this comparison yet.** `v2.8-to-v2.9` only writes the
record; the table above is what the next migration to touch a seeded file will
do with it, through `scripts/pdocs/seed.ts`. The record has to exist before
there is anything to reconcile against, which is why it ships first.

## The maintenance contract

- **A branch that ships or changes something updates the affected page in the
  same branch**, before finalize — the same bar as tests. New durable knowledge
  ships with its page; changed behaviour ships with its paragraph.
- **A new library page earns its place** when a subject is real (system pages)
  or when an insight recurs and a second page needs it (practice pages).
  Otherwise it is a tag or a paragraph on a page that already exists.
- **Give the lint teeth, and check that you did.** Run
  `bun scripts/pdocs/cli.ts check` from a pre-commit hook and from CI. A
  scaffolded project arrives with the lint and **without** the wiring — there is
  no hook and no workflow until you add them, so this bullet is a thing to do,
  not a description of what you have. Until it is done, the lint is a command
  someone has to remember.

## Verification bar

- `bun scripts/pdocs/cli.ts check` exits 0.
- A blank-context reader can find the page from `index.md` and follow its links
  without hitting a 404. The lint enforces the links; reachability past that is
  a read.
- No claim contradicts current behaviour. The lint does not judge prose; that is
  yours.

## Running the lint

```bash
bun scripts/pdocs/cli.ts check                # the gate
bun scripts/pdocs/cli.ts check --against origin/main  # in CI: no item left without being dropped
bun scripts/pdocs/cli.ts report               # what is missing — the backfill worklist
bun scripts/pdocs/cli.ts graph --format json  # the whole graph as JSON
bun scripts/pdocs/cli.ts view board           # the work, by state group
```

The scaffold ships no `package.json` wrapping these. A project that wants
`npm run docs:lint` can add it, but the CLI is the interface and the form above
always works.

While `lint.adopting` is `true` in `.project-docs.json`, the gate **reports and
exits 0**: a project adopting this layer has a corpus that predates it, and a
gate that fails on day one fails on every commit of the work that fixes it. Set
it to `false` the moment `report` is empty. The lint says so on every run.

---

**Related:**
[OKF 0.2 specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)

<!--
This page ships in the scaffold payload verbatim, so it links nothing inside
this repository. The argument for the layer, and the record of how it was
built, live in the project folder that built it — where a reader of THIS
repository will find them, and a reader of a generated one won't be sent
looking for a file that was never copied.
-->
