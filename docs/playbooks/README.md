# Implementation Playbooks

This directory contains implementation playbooks: reusable guides for recurring
types of work. A playbook captures a proven approach, including phases,
pitfalls, and validation steps, so that future efforts can follow an established
path instead of starting from scratch.

## Purpose

The main purpose of a playbook is to **codify a repeatable pattern** for
implementation. Where proposals focus on one-off ideas, plans map a specific
path for a proposal, and sessions document what actually happened, playbooks
distill _how we typically execute_ a class of work.

Think of playbooks as **reusable dev plans** for augmenting existing systems.
When you have a system in place (like AI workflows, database entities, or UI
components) and need to add to it consistently, a playbook captures the proven
approach.

### Why Document Playbooks?

- **Consistency** - Ensure new additions to existing systems follow established
  patterns
- **Efficiency** - Don't reinvent the wheel; follow the proven path for
  recurring tasks
- **Onboarding** - Help new developers (human and AI) understand how to work
  with established systems
- **Quality** - Capture best practices, common pitfalls, and validation steps
- **Evolution** - Update playbooks as better patterns emerge, keeping the team
  aligned

### Common Use Cases

- **Adding to existing systems** - New AI workflow, new database entity, new
  component variant
- **Recurring technical tasks** - Database migrations, API integrations, feature
  flag rollouts
- **Established patterns** - Testing strategies, refactoring approaches,
  deployment procedures

Playbooks make it easier for developers and AI agents to pick up and apply
established practices without starting from scratch.

## When to Create a Playbook

Create a playbook when:

- **Pattern has emerged** - You've successfully done something 2-3 times and see
  a repeatable pattern
- **System needs augmentation** - There's an established system that will need
  new additions over time
- **Consistency matters** - New additions should follow the same approach for
  quality/maintainability
- **Complexity justifies documentation** - The task is non-trivial enough that
  guidance adds value

## When NOT to Create a Playbook

- **One-off tasks** - If this is a unique implementation, create a plan instead
- **Before the pattern emerges** - Wait until you've validated something works
  2-3 times
- **Trivial tasks** - If the task is simple enough to not need guidance, skip
  the playbook
- **Project-specific details** - Keep playbooks generic and reusable, not tied
  to specific features
- **Documenting "what happened"** - Use sessions for historical records, not
  playbooks

**Rule of thumb:** If you can't imagine using this guide for at least 2-3 future
tasks, it's probably not a playbook yet—it's a plan or session.

**Scope note:** Playbooks tend to be larger in scope than lessons learned - they
cover multi-step processes and touch multiple files/systems, while lessons
learned capture specific problems or patterns.

## Content and Format

Playbooks should be clear, structured, and designed for reuse. They are not
rigid templates but should provide enough detail for consistent execution. A
good playbook usually includes:

- **Context:** When to apply this playbook (use cases, triggers, prerequisites).
- **Approach:** The general strategy and guiding principles.
- **Steps / Phases:** A coarse sequence of actions that can be adapted as
  needed.
- **Risks & Gotchas:** Common pitfalls to avoid, with mitigation advice.
- **Validation & Acceptance:** How to confirm the playbook has been successfully
  applied.
- **References:** Links to prior plans or sessions where this playbook was used.

## File Naming

- `short-topic-playbook.md`
- Examples:
  - `feature-flag-rollout-playbook.md`
  - `db-migration-playbook.md`
  - `api-integration-playbook.md`
  - `adding-and-consuming-a-new-db-entity.md`

## Template

A ready-to-use template is available: **[TEMPLATE.md](./TEMPLATE.md)**

Copy this template when creating a new playbook after you've validated a pattern
through 2-3 implementations.

### Key Sections

The template includes:

- **Metadata** (Created, Last Updated, Status) - Track evolution
- **Context** - What problem this playbook solves
- **Applicability** - When to use (and when NOT to use)
- **Prerequisites** - What needs to exist first
- **Approach Summary** - Strategy and guiding principles
- **Steps/Phases** - Coarse sequence with validation gates
- **Risks & Gotchas** - Common pitfalls and mitigations
- **Validation & Acceptance** - How to confirm success
- **Examples** - Concrete uses with references
- **Version History** - Track updates over time

Keep playbooks generic and adaptable - they should guide, not prescribe exact
steps.

## Tips

### Creating Playbooks

- **Wait for the pattern** - Don't create a playbook until you've done something
  successfully 2-3 times
- **Keep generic but actionable** - Adaptable to different contexts, not tied to
  one specific feature
- **Capture the why, not just the what** - Explain principles and gotchas, not
  just steps
- **Include examples** - Reference real project plans/sessions where this
  playbook was used

### Extracting Playbooks

- **From project sessions** - When you hit the same multi-step pattern
  repeatedly, extract to playbook
- **From project plans** - When a plan reveals an approach worth reusing,
  generalize it into a playbook
- **From lessons learned** - When a lesson grows into a multi-step process, it
  might become a playbook

### Maintaining Playbooks

- **Update as practices evolve** - Playbooks should reflect current best
  practices
- **Link from plans** - Reference applicable playbooks in implementation plans
- **Deprecate when obsolete** - Mark playbooks as deprecated when systems or
  patterns change
- **Version history** - Track meaningful updates so people know what changed

## Finding Playbooks

When in doubt, scan the directory - playbooks are designed to be self-describing
through their titles and content.
