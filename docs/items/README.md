# Work Items

A work item is one unit of work, small enough to hand an agent: a task, a bug, a
chore, or a research question. Its file says what the work is and what done
looks like, and its frontmatter holds its state and every relationship it has.

## Item or feature?

- **File an item** for anything that can be described and done without arguing
  its approach first: a bug, a refactor, a clear task, a question to answer.
- **Write a feature** when the approach needs options weighed or the work will
  split into several items. See [features/README.md](../features/README.md).
- **An idea nobody has accepted** is still an item: file it and leave it in
  `triage`.

## Filing an item

`pdocs` here, and in every README, means `bun scripts/pdocs/cli.ts`, run from
the repository root. There is no separate `pdocs` binary.

```bash
bun scripts/pdocs/cli.ts new item fix-login-redirect --kind bug \
  --title "Fix the login redirect loop" \
  --description "Signing in from /settings loops back to /login; it should land on /settings." \
  --by <your-model-or-name>
```

This writes `docs/items/fix-login-redirect.md` from
[ITEM.template.md](../TEMPLATES/ITEM.template.md) with a fresh `id`,
`lifecycle: triage` and `generated` filled in, and prints the id: as text, its
shortest prefix unique in the tree (12 characters or more); the full id with
`--format json` (the default when the output is not a terminal). Name the file
in kebab-case, with no date.

- `--kind` is required.
- Always pass `--title` and `--description`. Without them the title is the slug,
  title-cased, and the description is the template's placeholder.
- Pass `--by` with your model or your name. Without it `generated.by` records
  `pdocs`, not the author.

Then write the body: what is wrong or missing, and a **Definition of done** —
observable results a reviewer can check without asking you.

Pass what you know at creation as flags; each is checked before anything is
written:

| Flag                       | Sets                                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--parent feature/<slug>`  | the feature this item serves                                                                                                                                 |
| `--from <path or ref>`     | what spawned it: a session, a report, another item. Also links it under a `## Related Documents` heading. Leave it out when nothing written spawned the item |
| `--source <id>`            | an id outside this tree: an issue number                                                                                                                     |
| `--scope <name>`           | the part of the project it touches, declared in `lint.scopes`                                                                                                |
| `--blocked-by <ref,ref>`   | items that must be `done` first                                                                                                                              |
| `--priority`, `--assignee` | left to triage                                                                                                                                               |
| `--lifecycle backlog`      | only when the user wants the work — see below                                                                                                                |

Leave `--cycle` and `--released-in` alone when filing: `init-branch` and
`sweep-project` write them. The one exception is the item `finalize-branch`
files for work that ran on a branch with no item. It files the item plain,
writes its body from the work, and shows the user its description and definition
of done. Once they approve, one `pdocs set --status stable --lifecycle review`
moves it, adding `--cycle` when the branch belongs to the active cycle. If they
decline, it stays `draft` and in `triage`, under either policy, and
`finalize-branch` closes it straight to `done` (with `--cycle`) when the branch
lands.

Do not copy the template by hand: the `id` must be a fresh UUID, and the CLI
checks every reference. Change any field later with
`bun scripts/pdocs/cli.ts set <ref> --<field> <value>`. The template lists who
writes each field; [SCHEMA.md](../SCHEMA.md#fields) has the full table.

## Kinds

| `kind`     | Use it for                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------ |
| `task`     | a change that adds or alters behaviour                                                     |
| `bug`      | behaviour that is wrong: say what happens, what should happen, and how to see it           |
| `chore`    | upkeep with no behaviour change: dependencies, tooling, clean-up                           |
| `research` | a question to answer before deciding what to build — see [Research items](#research-items) |

## States, and who moves an item

| State     | Means                                                                  | Set by                                                                                                                                                  |
| --------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `triage`  | Filed, and nobody has decided to take it on                            | `pdocs new item`, by default                                                                                                                            |
| `backlog` | Accepted, and not yet shaped                                           | triage                                                                                                                                                  |
| `ready`   | Shaped and unblocked: an accepted definition of done, nothing blocking | triage or shaping; `finalize-branch` when the last item blocking it lands                                                                               |
| `active`  | Being worked                                                           | `init-branch`, when a branch starts on it — see below; for research the user asked for and approved, `create-investigation` or the `investigator` agent |
| `review`  | Waiting on a human or a reviewer                                       | `finalize-branch`, when its review starts                                                                                                               |
| `done`    | Landed                                                                 | `finalize-branch`; see also Research items                                                                                                              |
| `dropped` | Decided against. It stays in the tree                                  | whoever decides                                                                                                                                         |

`init-branch`, `finalize-branch`, `sweep-project` and `triage-items` are skills
in the project-docs Claude Code plugin. `init-branch` offers the items
`pdocs view ready` lists, and starts a `backlog` item only when the user names
it; it never starts an item in `triage`.

**Items created by agents start in `triage`, and leave it through a triage step
the user has seen.** If you are an agent that has just filed an item — a review
finding, a bug you hit mid-task — leave it in `triage`: do not accept it, drop
it, prioritise it, or start work on it on your own judgement. Writing its body
and definition of done at filing is expected; that does not make it `ready`. The
exception is an item the user has just approved in the same exchange — a plan's
list of items, research they asked for: file it in the state they approved.

At triage, the `triage-items` skill proposes for each item a state (`backlog`,
`ready` or `dropped`), and optionally a `priority`, a `parent` feature to join
and an `assignee` when it goes to a particular agent or seat. It applies them
with `pdocs set` once the user has reviewed them. Without that skill, do the
same by hand: show the user each item and the change you propose, and run
`pdocs set` only after they agree. `pdocs set` does not check who is calling;
this rule is the only guard.

When the user asks you to file work they want done ("file that, I want it
fixed"), the user is the one filing it: start it at `backlog`, or at `ready` if
its definition of done is settled (`--lifecycle ready`).

Shaping is writing or settling an accepted item's definition of done and its
`blocked_by`. It moves a `backlog` item to `ready`.

An item's `status` is OKF's document-trust marker, not its state: `draft` until
the user has reviewed the item's description and definition of done, `stable`
once they approve it. Show the user that content and get their approval before
work starts — approval already given in the conversation counts — then run
`pdocs set item/<slug> --status stable`, alone or in the same command as the
start. Starting work, joining a cycle or changing `lifecycle` never moves it on
its own; `lifecycle` carries where the work has got to. Starting an item that is
not `stable`, or adding one to the active cycle, is reported — and refused under
`checks.workItemReview.mode: strict` (SCHEMA.md → "The review advisory"). An
item whose content the user declines to approve does not move, under either
policy: not started, not moved to `review`, not joined to the active cycle
(SCHEMA.md → "Who moves an item"). `pdocs view unreviewed` lists finished items
that were never marked reviewed.

`pdocs view backlog` lists everything unstarted, `pdocs view ready` what can be
started now, and `pdocs view board` everything by state group.
`pdocs view portfolio` counts items by state group per current cycle and
feature, and counts the live items in neither.

## A file, then a folder

An item is a single file, `items/<slug>.md`, until it owns a document. Then it
becomes a folder, `items/<slug>/item.md`, with the document beside it:

```
items/
├── bump-deps.md              # a single-file item
├── fix-login-redirect/
│   ├── item.md               # the item, once it owns something
│   ├── plan.md
│   └── sessions/2026-09-22-fix.md
└── _archive/                 # done or dropped items only
```

Creating an owned document promotes the item for you and rewrites every link to
it:

```bash
bun scripts/pdocs/cli.ts new plan --owner item/fix-login-redirect
```

`pdocs promote item/<slug>` does the promotion alone. Never rename or move an
item by hand; its `id` and the links to it are what the CLI keeps straight. An
item owns the same documents a feature does — see
[What a feature owns](../features/README.md#what-a-feature-owns).

## Research items

A research item has three parts, kept in three files:

- **The item** is the asking: the question, the definition of done (the decision
  the answer must support), and the state.
- **`write-up.md`** is the answer: findings, options, recommendation. It carries
  no `lifecycle`; the item does.
- **`reports/`** holds the evidence gathered on the way.

Write-ups and reports are not reserved for research items: any item, or a
feature, may own them. A report is **evidence** for the work that owns it — a
survey, an audit, a benchmark — and never a record of a process: no skill writes
one about its own run. A documentation review files each finding as a `triage`
item with its evidence in the body; a project summary updates
`PROJECT-SUMMARY.md` and nothing else; what an agent did on a branch is its
session.

```bash
bun scripts/pdocs/cli.ts new item auth-providers --kind research
bun scripts/pdocs/cli.ts new write-up --owner item/auth-providers
bun scripts/pdocs/cli.ts new report provider-survey --owner item/auth-providers
```

When the write-up is finished, set the item `done` (the `create-investigation`
skill and the `investigator` agent do this when research concludes outside a
branch). If it recommends building something, file the items with
`--from item/<slug>`, or write the feature with
`--from docs/items/<slug>/write-up.md` (a feature takes a path, not a reference,
and links it from its Related section).

## Relationships are fields

A folder never means "these share a parent, a cycle or a state". Those are
fields on the item:

- `parent: feature/<slug>` — the feature it serves.
- `cycle: <cycle file slug>` — the cycle it is in play in.
- `blocked_by: [<id>, …]` — items that must land first.
- `from:` — what spawned it. A review always writes it.

The forms each takes are in [SCHEMA.md](../SCHEMA.md#references). Pass
`item/<slug>` or an 8-character id prefix on the command line; `pdocs` writes
the full id.

## Nothing is deleted

An item leaves the tree only after it reaches `dropped`. Deleting one that is
not `dropped` is `ITEM DELETED` in `pdocs check`. To stop work on an item, set
it `dropped`.

## Archiving

A `done` or `dropped` item may move to `items/_archive/`:

```bash
bun scripts/pdocs/cli.ts archive item/<slug>
```

It refuses an item in any other state, moves the file or folder, and rewrites
every link to and from it. References by `id` keep working. Archiving is
optional, and only `pdocs archive` does it; the lint reports anything in
`_archive/` that is not `done` or `dropped`.

`pdocs view board` leaves archived items out (`--all` puts them back). Once more
than `checks.archive.threshold` finished items (default 25) are unarchived, it
ends with an advisory that says how many and suggests archiving some; its JSON
form (`--format json`) lists the candidates. Nothing moves until someone agrees
to a selection. `docs/SCHEMA.md` describes the setting.
