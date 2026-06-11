# Documentation Overview

For a complete overview of the documentation structure and how to use it, see
[README.md](./README.md).

## Foundational Document

- **PROJECT_MANIFESTO.md** - The constitution of this project. Defines what the
  project is, who it's for, core principles, what it does and doesn't do. Read
  this first to understand the foundational vision and boundaries.

## Quick Onboarding

- **memories/** - Summaries of recent work. Read this folder at the start of a
  new session to understand what's been happening lately.

## Documentation Structure

This project organizes documentation by purpose and lifecycle:

### Permanent Reference (type-based)

- **architecture/** - System design and how things work
- **specifications/** - Technology-agnostic description of application behavior,
  organized by domain
- **interaction-design/** - User experience flow documentation
- **playbooks/** - Reusable patterns for recurring tasks
- **lessons-learned/** - Specific problems and their solutions
- **fragments/** - Incomplete observations for later synthesis

### Discovery & Assessment (type-based)

- **reports/** - Structured assessments of current state (code reviews, security
  audits, doc status)
- **investigations/** - Research exploring whether action is needed

### Work Tracking (domain-based)

- **projects/** - Co-located pipeline documents (proposal, plan, sessions,
  artifacts) for defined bodies of work
- **backlog/** - Small, self-contained tasks that don't need a project folder
- **projects/\_archive/** - Completed project folders

### The Documentation Cycle

```
Brief → Investigation → Project (proposal → [design-resolution] → plan → [test-plan] → sessions) → Report → ...
```

Reports and investigations are the connective tissue between projects:

- Reports assess current state and identify findings
- Findings can spawn investigations or new projects
- Investigations determine whether a project is warranted
- Projects contain the full pipeline (proposal → [design-resolution] → plan →
  [test-plan] → sessions → artifacts)
- Completed projects may trigger new reports to assess outcomes
- Small tasks that don't need the full pipeline go in the backlog
