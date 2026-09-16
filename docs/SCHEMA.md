# The documentation contract

You are (probably) an agent about to add or change a document under `docs/`.
This file is the whole contract — read it once, then work. It governs
**structure**; the content lives in the pages.

Nothing here moves a file. The split this describes is a split in **how strictly
a document is checked**, not in where it lives.

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

| Tier      | Applies to                                                                                                                            | Checks                                                                                                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Thin**  | the workbench: `backlog/` `briefs/` `investigations/` `projects/` `reports/` `fragments/` `cycles/`                                   | frontmatter present · `type` matches the folder · `status` and `lifecycle` in vocabulary · `generated` well-formed · links and anchors resolve                                                                         |
| **Graph** | the library: `architecture/` `specifications/` `interaction-design/` `playbooks/` `lessons-learned/` `memories/`, plus the root pages | everything Thin checks — `tags` required rather than optional — plus: every page reachable from `index.md` · its catalog line states the page's own `description` · `related:` keys resolve · `--json` emits the graph |

The difference is **reachability**. A library page that nothing links to is
lost, so the catalog is a hard requirement. A workbench document is found by its
date and its folder README; it is written once, it closes, and it is never
brought up to date — so cataloguing it would be a chore with no reader.

### Declaring your own folder

The folder lists above are defaults, not a ceiling. A project that wants
`docs/runbooks/` adds the folder to a tier and names the `type` its pages carry,
both in `.project-docs.json`:

```json
"lint": {
  "workbench": ["backlog", "briefs", "...", "runbooks"],
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

## Layout

```
docs/
  SCHEMA.md            ← this contract (exempt from its own rules)
  index.md             ← the catalog: ONE line per library page
  README.md            ← how to choose a document type (contract page)
  PROJECT_MANIFESTO.md ← type: manifesto   (graph tier)
  PROJECT-SUMMARY.md   ← type: summary     (graph tier; written by a command,
                         and absent until you run it)

  architecture/        ← type: architecture   ┐
  specifications/      ← type: specification  │
  interaction-design/  ← type: interaction    │ the library — graph tier
  playbooks/           ← type: playbook       │
  lessons-learned/     ← type: lesson         │
  memories/            ← type: memory         ┘

  backlog/             ← type: backlog        ┐
  briefs/              ← type: brief          │
  investigations/      ← type: investigation  │
  reports/             ← type: report         │ the workbench — thin tier
  fragments/           ← type: fragment       │
  cycles/              ← type: cycle          │
  projects/            ← type by filename     ┘

  <foreign>/           ← another tool's tree, if you have one; name it in
                         `lint.skip` and no tier walks it
  */_archive/          ← closed work; frozen, not checked
```

Not every row is present in every project. `PROJECT-SUMMARY.md` and the
`<foreign>/` row in particular are optional — the first appears when someone
runs the summary command, and the second only if some other tool keeps a
directory under your docs root.

`README.md`, `AGENTS.md` and `CLAUDE.md` are **contract pages**: meta-documents
about the tree rather than entries in its type system. They carry no
frontmatter, and the lint checks only their links. So does this file.

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
would be describing it wrongly to make a gate quiet.

List them in `lint.exclude` in `.project-docs.json`, as globs relative to the
repository root. A matched file is invisible to every tier — no frontmatter, no
links, no graph:

```json
"exclude": ["docs/projects/*/artifacts/*-prototype.md"]
```

A fresh project excludes nothing, and `exclude` starts empty. The example above
is the shape the entry takes when a project does have such a file — a runnable
deck kept inside a project's `artifacts/` because it is part of that project's
record.

Glob syntax is `Bun.Glob` — `*` within a path segment, `**` across segments, `?`
for one character, `{a,b}` for alternation. A literal brace in a path must be
escaped as `\{`.

`lint.exclude` is not `lint.skip`. `skip` names **directories**, matched at any
depth, and prunes whole subtrees during the walk — that is how `_archive/`
disappears wherever it appears. `exclude` filters **individual files** by path.
Reach for `skip` when a whole tree is not yours, and `exclude` when a particular
file is not a document.

## Frontmatter — every page

[OKF 0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
requires exactly one field, `type`. Everything else below is our convention;
§4.1 of the spec permits additional keys outright and requires consumers to
preserve the ones they do not recognise.

```yaml
---
type: lesson # REQUIRED (OKF §3). Also selects the page shape and the vocabulary below.
title: Migration steps must be uniformly specific # the display name; matches the H1
description: In an agent-run guide, one underspecified step becomes the failure
  point. # ONE sentence
tags: [migrations, agent-execution, documentation] # 2–4 kebab-case keywords
related: [playbook/writing-migrations, lesson/scaffold-checklist] # optional: `type/slug` edges
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
  are the pages the graph tier walks; there is no key for a proposal, a session
  or an investigation, and writing one produces `BAD related`. Two library pages
  with the same basename and type would make a key ambiguous, so the lint
  reports that as `DUPLICATE KEY` rather than silently picking one. Link to
  workbench documents in the body.

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

| `type`              | `lifecycle` values                                                             | Tier  | Where                             |
| ------------------- | ------------------------------------------------------------------------------ | ----- | --------------------------------- |
| `architecture`      | —                                                                              | graph | `architecture/`                   |
| `specification`     | —                                                                              | graph | `specifications/`                 |
| `interaction`       | —                                                                              | graph | `interaction-design/`             |
| `playbook`          | —                                                                              | graph | `playbooks/`                      |
| `lesson`            | —                                                                              | graph | `lessons-learned/`                |
| `memory`            | —                                                                              | graph | `memories/`                       |
| `manifesto`         | —                                                                              | graph | `PROJECT_MANIFESTO.md`            |
| `summary`           | —                                                                              | graph | `PROJECT-SUMMARY.md`              |
| `index`             | —                                                                              | graph | `index.md`                        |
| `backlog`           | `open` · `done` · `promoted` · `dropped`                                       | thin  | `backlog/`                        |
| `fragment`          | `open` · `promoted` · `dropped`                                                | thin  | `fragments/`                      |
| `brief`             | `active` · `spent`                                                             | thin  | `briefs/`                         |
| `investigation`     | `active` · `concluded`                                                         | thin  | `investigations/`                 |
| `cycle`             | `planned` · `active` · `closed` · `abandoned`                                  | thin  | `cycles/`                         |
| `proposal`          | `draft` · `approved` · `deferred` · `implemented` · `withdrawn` · `superseded` | thin  | `projects/*/proposal.md`          |
| `plan`              | `draft` · `active` · `completed` · `abandoned`                                 | thin  | `projects/*/plan.md`              |
| `design-resolution` | `draft` · `resolved` · `superseded`                                            | thin  | `projects/*/design-resolution.md` |
| `test-plan`         | `draft` · `ready` · `active` · `completed`                                     | thin  | `projects/*/test-plan.md`         |
| `kickoff`           | —                                                                              | thin  | `projects/*/DEV_KICKOFF.md`       |
| `handoff`           | —                                                                              | thin  | `projects/*/handoff.md`           |
| `report`            | —                                                                              | thin  | `reports/`                        |
| `session`           | —                                                                              | thin  | `projects/*/sessions/`            |
| `artifact`          | —                                                                              | thin  | anything else in a project folder |

**Why the library types carry none.** A living page is never "done"; it is
current or it is not, and `status` already says which. Adding a lifecycle to a
playbook would invite someone to mark it `completed`, which is not a thing a
playbook can be.

**Why sessions, reports and artifacts carry none.** They are frozen records of a
moment. `generated.at` is their only date, and they are never brought up to date
— a `lifecycle` on a session invites an edit that destroys what the document is
for. A `kickoff` is the same: a briefing written once and read at the start of
implementation. A `handoff` is its bookend — what shipping the work requires
once it is built, written at finalization and read at deploy.

`design-resolution` and `test-plan` do hold state, because a design question is
open until it is answered and a list of scenarios is written before it is run.
`ready` on a test plan means the scenarios exist and nothing has been executed
against them yet.

**A backlog item can just be `done`.** `promoted` is for the rarer case where an
item turns out to need a project and the work moves there; a `fragment`, which
is an observation rather than a task, has no `done` for that reason.

**`approved` is not `implemented`.** Every mature file-based process — KEPs,
PEPs, RFDs — has that intermediate state, and its absence here is why three
proposals grew `Approved (in flight)` by hand.

## Archiving

Archival is a **lifecycle value first, a folder move second.** Every terminal
value (`dropped`, `spent`, `concluded`, `implemented`, `withdrawn`,
`superseded`, `deferred`, `completed`, `abandoned`, `closed`) permits the move
to `_archive/`; none requires it. `sweep-project` decides on state, not on
folder position, and a project inside an active cycle's `scope` is never moved.

## The cycle

A **cycle** is the one document type that is not a record of thinking or of
work: it is a thin index over the work that is _in play_ right now.

- **Scope-bound, not time-boxed.** It closes when its scope ships or is cut, not
  on a date. It has an `appetite` — a sentence saying when it would be right to
  stop — rather than an end date.
- **At most one is `active`.** The lint enforces this. Two active cycles mean
  the answer to "what are we doing" is a list, which is the state a cycle exists
  to prevent.
- **An index, never a container.** `scope:` links the projects and backlog items
  in play. Their proposals, plans, sessions and artifacts stay in the project
  folder, which is the topical home of a feature and outlives every cycle that
  touched it.

Body: **Why now** · **Scope** (one line per item) · **Outcome** (written at
close: what shipped, what was cut, what was learned) · the sessions that landed.

## Hard rules

0. **Read the neighbours first.** Before writing, read the folder's `README.md`
   and one existing sibling of the same `type`. That sibling is the live example
   for anything this contract does not spell out.
1. **Plain Markdown only.** No framework components, no HTML beyond what GitHub
   renders. A page that needs an interactive widget is tooling, not a page.
2. **Relative `.md` links** between documents
   (`../architecture/sync-engine.md#backpressure`). They must resolve on GitHub
   and in a bare editor — never absolute URLs into this repo. Anchors are
   GitHub-style slugs of the target heading, and you link only anchors you have
   verified exist. The lint checks both.
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

| Class      | What a migration does                     | Which files                                                                                                                                                                                                                |
| ---------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Owned**  | Overwrites, every time                    | `docs/README.md`, `docs/AGENTS.md`, this file, every category `README.md`, `scripts/pdocs/**`                                                                                                                              |
| **Seeded** | Updates only while you have not edited it | every template, by exact name: `TEMPLATE.md`, `TEMPLATE-<variant>.md`, `YYYY-MM-DD-TEMPLATE-<type>.md`, `<name>.template.md`, and anything under a `TEMPLATES/` directory; plus every path `docs/.pdocs-seed.json` records |
| **Theirs** | Never touches                             | `.project-docs.json`, root `AGENTS.md`/`CLAUDE.md`, `docs/PROJECT_MANIFESTO.md`, `docs/index.md`, and every document you write                                                                                             |

`.project-docs.json` is **theirs** with one exception a migration names when it
happens: it sets the top-level `version` there, patched in place in the file's
own text so your formatting is kept, and adds a key only when a first adoption
finds it missing. Nothing else in the file is written.

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
bun scripts/pdocs/cli.ts report               # what is missing — the backfill worklist
bun scripts/pdocs/cli.ts graph --format json  # the whole graph as JSON
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
