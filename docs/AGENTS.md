# Documentation Overview

For a complete overview of the documentation structure and how to use it, see
[README.md](./README.md).

**Create documents with the `pdocs` CLI, not by hand:**
`bun scripts/pdocs/cli.ts new <type> <name>` puts one in the right folder with
its frontmatter. `bun scripts/pdocs/cli.ts --help` says what else it does.

## Foundational Document

- **PROJECT_MANIFESTO.md** - The constitution of this project. Defines what the
  project is, who it's for, core principles, what it does and doesn't do. Read
  this first to understand the foundational vision and boundaries.

## Quick Onboarding

- `bun scripts/pdocs/cli.ts view board` - every live work item, by state group.
  Run it at the start of a session to see what is in flight and what is waiting.
- `bun scripts/pdocs/cli.ts view ready` - the items an agent can start now.

## Documentation Structure

### The library (kept current)

- **architecture/** - System design and how things work
- **specifications/** - Technology-agnostic description of application behavior,
  organized by domain
- **interaction-design/** - User experience flow documentation
- **playbooks/** - One guide per kind of recurring work: Goal · Steps ·
  Verification. Read the matching one before starting that kind of work

### The workbench (work, and what it produces)

- **features/** - One folder per feature: `feature.md` (the argument and its
  state) plus its plan, design resolution, test plan, sessions, reports and
  artifacts
- **items/** - Work items: tasks, bugs, chores and research questions. A single
  file, or a folder once it owns documents
- **cycles/** - What is in play right now; items join a cycle through their
  `cycle:` field
- **features/\_archive/**, **items/\_archive/**, **cycles/\_archive/** - done or
  dropped work, and closed or abandoned cycles, moved there by `pdocs archive`

### How work moves

```
Item:    triage → backlog → ready → active → review → done   (or dropped)
Feature: feature.md → [design-resolution] → plan → [test-plan] → items → sessions → [sweep → archive]
```

- Items you file start in `triage`. Leave them there: the user moves them out at
  a triage step they have seen.
- A research item asks a question; its `write-up.md` answers it, and the answer
  becomes items or a feature.
- A step a future agent must follow goes into a playbook, with its check.

## Creating and Querying Documents

Documents are created with the `pdocs` CLI rather than written by hand:

```bash
bun scripts/pdocs/cli.ts new <type> <name> --title "…" --description "…"
bun scripts/pdocs/cli.ts new item <slug> --kind bug          # a work item
bun scripts/pdocs/cli.ts new session <topic> --owner item/<slug>
```

The type decides the folder, the filename shape and the template, and the CLI
fills the frontmatter. For a library page (architecture, specification,
interaction, playbook) it also writes the line in [index.md](./index.md) that
keeps the page out of the orphan list.

The same CLI reads the tree and changes work in place;
`bun scripts/pdocs/cli.ts help` lists every command, flag and exit code.
[SCHEMA.md](./SCHEMA.md) is the frontmatter contract the gate enforces, and
[STYLE.md](./STYLE.md) says how the prose is written.
