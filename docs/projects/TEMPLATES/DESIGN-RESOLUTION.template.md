<!--
USAGE: Copy this file to your project folder as `design-resolution.md`.

This template helps you crystallize system-level decisions before development
planning begins. Think of it as collapsing ambiguity — locking in behavior,
data shape, boundaries, and architectural positioning so the development plan
can be concrete rather than speculative.

This stage is optional. Use it when the proposal contains unresolved behavioral,
structural, or architectural questions that would otherwise leak into planning
or get resolved informally during implementation. Skip it when the proposal is
already precise enough to plan against directly.

Not every section needs filling. Adapt based on the project's complexity — a
small feature might only need Boundaries and Irreversible Decisions. A complex
system change might need all sections. The goal is clarity, not ceremony.

This document is ephemeral — it lives in the project folder and does its job
during the development lifecycle. But it can serve as raw material for formal
specifications or architecture docs after implementation is complete.

For more guidance on design resolutions, see the projects README: ../README.md
-->

# [Design Resolution Title]

**Status:** Draft | Under Review | Resolved | Superseded\
**Created:** YYYY-MM-DD\
**Related Proposal:** [Link to proposal](./proposal.md)\
**Author:** [Name]

---

## Overview

[1-2 paragraph summary connecting back to the proposal. State what this
resolution clarifies — what ambiguities existed in the proposal that this
document resolves before planning begins.]

## System Behavior

[What are the core entities and how do they behave? Focus on states,
transitions, invariants, and failure modes. Skip this section if the proposal
already defines behavior precisely.]

- What are the core entities?
- What states can each entity be in?
- What transitions are allowed between states?
- What invariants must always hold?
- What are the known edge cases?
- What failure modes are anticipated?

## Data Model

[Conceptual structure only — not migration scripts, schema diffs, or ORM
definitions. Those belong in implementation plans. Define entities,
relationships, and ownership at a level that removes ambiguity without
prescribing implementation.]

- Primary entities and their properties
- Relationships between entities
- Identity rules (what uniquely identifies each entity)
- Required vs. optional fields
- Ownership boundaries (who creates, modifies, deletes)

## Boundaries

[Sharpen what's in and what's out. Distinguish between permanent scope
exclusions and decisions that are deliberately postponed.]

**Explicitly in scope:**

- [What this work includes]

**Explicitly out of scope:**

- [What this work does not include]

**Postponed decisions:**

- [Decisions acknowledged but deferred, with rationale]

**Deferred complexity:**

- [Complexity that is recognized but not tackled in this iteration]

## Architectural Positioning

[Where does this fit in the system? Define layer ownership, dependencies, and
constraints. Skip if the proposal already makes architectural placement clear.]

- Where does this live in the system?
- What layer owns it?
- What does it depend on?
- What depends on it?
- What constraints does this impose on future work?

### External Dependencies (Optional)

[Does this work require anything outside the codebase that must be set up before
implementation or testing can succeed? Skip if there are no external
dependencies. This is an awareness check — many features have none, but when
they exist, identifying them early prevents blocked implementation and
misleading test results.]

- **Third-party services** — Accounts, platforms, or infrastructure that must
  exist (e.g., cloud storage bucket, payment processor sandbox, OAuth provider)
- **Credentials & API keys** — Specific keys or tokens that must be obtained and
  where they come from
- **Environment variables** — `.env` values that must be populated for the
  feature to function
- **Human actions required** — Setup steps that cannot be automated (e.g.,
  "create account on X", "request API access from Y", "configure DNS record")
- **When needed** — Must these be in place before implementation starts, or only
  before testing/deployment?

## Irreversible Decisions

[What would be expensive to change later? What assumptions must be locked before
planning begins? Include rationale for each locked decision.]

- [Decision]: [Rationale for locking this now]
- [Decision]: [Rationale for locking this now]

## Open Questions (Optional)

[Anything still unresolved that the plan will need to address. These should be
implementation-level questions, not design-level — design-level questions should
be resolved above.]

---

**Related Documents:**

- [Proposal](./proposal.md)
- [Architecture docs](../../architecture/doc-name.md) (if applicable)
- [Plan](./plan.md) (created after resolution)

---

## Notes (Optional)

[Additional context, decisions made during the resolution process, references to
discussions or prior art]
