---
docs_version: "9.1.0" # x-release-please-version
docs_template: https://github.com/ichabodcole/project-docs-scaffold-template
---

# Documentation

This directory holds the project's documentation in two parts. The **library**
describes the system as it is and how to work on it, and is kept current. The
**workbench** tracks work — features, work items and cycles — and every document
that work produces, kept with the feature or item it belongs to.

## Foundational Document

**[PROJECT_MANIFESTO.md](./PROJECT_MANIFESTO.md)** - The constitution of this
project. Defines what the project is, who it's for, core principles, what it
does and doesn't do. Read this first to understand the foundational vision and
boundaries.

## Quick Onboarding

To see what is happening, run:

```bash
bun scripts/pdocs/cli.ts view board    # every live item, by state group
bun scripts/pdocs/cli.ts view ready    # what can be started now
```

The active cycle, if there is one, is in [cycles/](./cycles/README.md).

## Structure

### The library

Living documents that describe the system as it is. They are not tied to one
piece of work, and they are kept current as the system changes.

#### `/architecture`

Maps of the landscape - what systems exist, where their boundaries are, and how
major pieces fit together. Focus on building mental models at high to mid-level;
avoid exhaustive detail that's better found by reading code.

#### `/specifications`

Technology-agnostic specification documents that describe what the application
is, what it does, and how it behaves — organized by domain. Specifications are
portable: they contain no framework or library references and could be used to
rebuild the application in any technology stack. They serve as the living,
authoritative description of application behavior.

#### `/interaction-design`

User experience flow documentation that captures how users interact with
features and subsystems. Documents user journeys, decision points, and design
rationale behind interaction patterns. Complements architecture docs by
explaining how features work from the user's perspective rather than the
technical perspective.

#### `/playbooks`

One guide per kind of recurring work — adding a database entity, cutting a
release — as Goal · Steps · Verification. Agents read the matching playbook when
that kind of work starts, and a branch that learned something appends a step and
its check. A playbook named for a lifecycle event (`release-playbook.md`)
overrides the skill that owns the event. See
[playbooks/README.md](./playbooks/README.md).

### The workbench

#### `/features`

One folder per feature: an outcome big enough that its approach is argued before
it is built. `feature.md` holds the argument and the feature's state; its plan,
design resolution, test plan, sessions, reports and artifacts sit beside it. See
[features/README.md](./features/README.md).

#### `/items`

Work items: one unit of work each — a task, a bug, a chore, or a research
question. An item is a single file until it owns a document, then a folder.
Items filed by agents start in `triage`. See
[items/README.md](./items/README.md).

#### `/cycles`

What is being worked on **right now**. An item joins a cycle by naming it in its
`cycle:` field; the cycle file holds the appetite, the intent and, at the end,
the outcome. At most one cycle is `active` at a time, and the lint enforces it.
See [cycles/README.md](./cycles/README.md).

Backlogs and boards are not documents here: `pdocs view` derives them from the
items' fields.

## Specifications: A Living Application Description

Specifications live outside the per-feature lifecycle below. They describe the
**whole application's behavior** in technology-agnostic terms — a living
document that answers "what does this application do?" independent of how it's
built.

Specifications can be **created before development begins** (defining what to
build from an idea) or **generated from an existing codebase**
(reverse-engineering a portable description). Either way, they should be
**updated as features are completed** to stay current.

While the flowchart below tracks individual pieces of work from idea to
completion, specifications track the cumulative state of the application itself.
When you finish building a feature, update the relevant specifications to
reflect the new behavior.

## Choosing the Right Document Type

Not sure what to create? Use this decision flowchart:

```
                 START: You have work to track or document
                                   ↓
                 ┌───────────────────────────────────┐
                 │ Is it describing something that   │
                 │ already exists, or a recurring    │──YES──→ The library:
                 │ way of working?                   │         ARCHITECTURE, SPECIFICATION,
                 └───────────────────────────────────┘         INTERACTION DESIGN, PLAYBOOK
                                   ↓ NO
                 ┌───────────────────────────────────┐
                 │ Do you know whether to act?       │──NO───→ Research ITEM (--kind research)
                 └───────────────────────────────────┘         → write-up.md + reports/
                                   ↓ YES                          → its recommendation feeds
                 ┌───────────────────────────────────┐            back in at START
                 │ Does the approach need arguing —  │
                 │ options, design, scope — or will  │──NO───→ Work ITEM (task, bug, chore)
                 │ it split into several items?      │         → plan.md, sessions/ if it grows
                 └───────────────────────────────────┘
                                   ↓ YES
                                FEATURE
                          (features/<slug>/feature.md)
                                   ↓
                 ┌───────────────────────────────────┐
                 │ Unresolved behaviour, data or     │──YES──→ Add design-resolution.md
                 │ architecture?                     │
                 └───────────────────────────────────┘
                                   ↓
                     Ready to implement? Add plan.md
                                   ↓
                 ┌───────────────────────────────────┐
                 │ Need structured verification?     │──YES──→ Add test-plan.md
                 └───────────────────────────────────┘
                                   ↓
                  File the ITEMS that do the work (--parent feature/<slug>)
                                   ↓
                   Working on it? Sessions go in the owner's sessions/
                                   ↓
                              Work complete?
                                   ↓
          ┌────────────────────────┼─────────────────────────┐
          ↓                        ↓                         ↓
   Deployment steps?      A step a future agent      System changed?
   → handoff.md           must follow?               → update ARCHITECTURE,
     (in the owner)       → append to a PLAYBOOK       SPECIFICATION,
                                                       INTERACTION DESIGN
```

**The work pipeline:**

```
Item (triage → backlog → ready → active → review → done)
Feature (feature.md → [design-resolution] → plan → [test-plan] → items → sessions → [sweep → archive])
```

A research item is the connective tissue: it asks whether to act, its write-up
answers, and the answer becomes items or a feature. Findings that are not wanted
yet are items left in `triage`, not a separate kind of note.

**Cycles sit across this, not inside it.** The flowchart picks the right
document for one piece of work; a cycle names which pieces are in play at all.
Open one when a body of work will span more than one branch — a single branch
needs no cycle — and close it when its work has shipped or been cut.

The bracketed final stage is a **check-in, not an automatic step**. Sweeping a
feature reconciles its plan against what was actually built; archival only
follows if the work is genuinely done and a human confirms it. Plenty of sweeps
end with "not yet" — that's a normal outcome, not a failed one.

**Quick Reference:**

- **Work item:** "Here's one piece of work that needs doing." (a task, a bug, a
  chore; filed with `pdocs new item`)
- **Research item:** "Should we even do this? Let me find out." (the question;
  its `write-up.md` is the answer, its `reports/` the evidence)
- **Feature:** "Here's an outcome worth shaping, and how we'll get there." (the
  argument, its state, and every document the work produces)
- **Cycle:** "Here's what we're working on right now." (the items that name it;
  one active at a time)
- **Playbook:** "Here's how to do this kind of work, step by step, and how to
  check it." (Goal · Steps · Verification)
- **Specification:** "Here's what the application does, described so anyone
  could rebuild it." (technology-agnostic behavior)
- **Architecture:** "Here's how X works in our system." (technical as-built
  documentation)
- **Interaction Design:** "Here's how users interact with X and why." (UX flow
  as-built documentation)

**Special cases:**

- **Small bug or refactor?** → Work item (`--kind bug` or `--kind task`)
- **An idea nobody has accepted yet?** → Work item, left in `triage`
- **Big enough to argue its approach?** → Feature
- **Still figuring out whether to act?** → Research item first, then a feature
  or items
- **A review turned up findings?** → One work item per finding, `--from` the
  session or report that holds the review
- **Specific problem solved, and it will come up again?** → A step and its check
  in the playbook for that kind of work
- **Need a portable, technology-agnostic description of the application?** →
  Specification
- **Need to document an existing technical system?** → Architecture
- **Need to document how users interact with a feature?** → Interaction Design
- **Feature has unresolved system-level questions?** → Design resolution before
  planning
- **Need structured verification for agent-implemented features?** → Test plan
  after planning
- **Want to assess current state?** → A report, owned by the research item or
  feature that needs it

## Frontmatter

Every document here carries OKF frontmatter, and `pdocs check` checks it. The
whole contract — the fields, the two tiers of strictness, the per-type
`lifecycle` vocabularies and the work fields — is [SCHEMA.md](./SCHEMA.md). Read
it once before adding a document; the templates already carry the right block.
[STYLE.md](./STYLE.md) is the companion for how the prose is written.

Two things worth knowing before you look:

- **`status` and `lifecycle` are different questions.** `status` is OKF's field
  and OKF's vocabulary — `draft`, `stable`, `deprecated` — and says whether a
  document can be relied on. `lifecycle` is ours and says where the work has got
  to: an item in `review` is built and waiting on a reviewer, which no `status`
  value could say.
- **The library is catalogued; the workbench is not.** Pages in `architecture/`,
  `specifications/`, `interaction-design/` and `playbooks/` each get one line in
  [index.md](./index.md), and the lint fails if one is missing or if its line
  has drifted from the page's own `description`. Work is found through
  `pdocs view` and `pdocs find` instead.

```bash
bun scripts/pdocs/cli.ts check    # the gate
bun scripts/pdocs/cli.ts report   # what is still missing, grouped by field
bun scripts/pdocs/cli.ts graph    # the whole graph
```

The same CLI is what **creates** a document — folder, filename, frontmatter and,
for a library page, its [index.md](./index.md) line:

```bash
bun scripts/pdocs/cli.ts new <type> <name> --title "…" --description "…"
bun scripts/pdocs/cli.ts new item <slug> --kind task      # a work item
bun scripts/pdocs/cli.ts new plan --owner feature/<slug>  # a document a feature owns
bun scripts/pdocs/cli.ts help          # every command, flag and exit code
```

It has no dependencies and needs no install step. It renders text at a terminal
and JSON everywhere else, so a pipeline gets a parseable answer without asking
for one. Nothing wraps it here — add `package.json` shortcuts if you want them,
but the CLI is the interface, and `help` is how you find the rest of it.
[AGENTS.md](./AGENTS.md) has the short version for an agent entering this tree.

## Usage

Each subdirectory contains its own README with detailed guidance on:

- When to create documents
- When NOT to create documents
- File naming conventions
- Recommended structure

The templates for features, items and everything they own live in `TEMPLATES/`;
the library folders keep their own `TEMPLATE.md`. `pdocs new` copies the right
one for you.
