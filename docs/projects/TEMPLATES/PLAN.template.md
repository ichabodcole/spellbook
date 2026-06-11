<!--
USAGE: Copy this file to your project folder as `plan.md`.

This template helps you create a development roadmap - showing the route from current codebase to completed feature.
Focus on pivotal points: complex areas, significant changes, migration concerns, key validation gates.

Think "gas stations on a road trip" - highlight important stops and transitions, but don't give turn-by-turn directions.
The developer drives; you're providing the map and calling out where things get tricky.

Adapt sections freely. Not every plan needs all sections (e.g., many won't need Rollback Plans or Observability).
Ground your plan in the actual codebase - reference files, analyze current patterns, show the path forward.

For more guidance on plans, see the projects README: ../README.md
-->

# [Feature Name] Implementation Plan

**Created:** YYYY-MM-DD **Related Proposal:** [Link to proposal](./proposal.md)
**Status:** Draft | Active | Completed | Superseded

---

## Overview

[1-2 paragraph summary connecting back to the proposal and outlining what this
plan covers. Reference current codebase state and the path to implementation.]

## Outcome & Success Criteria

**Definition of Done:** What must be true to call this complete?

- [ ] [Acceptance criterion 1]
- [ ] [Acceptance criterion 2]
- [ ] [Acceptance criterion 3]

**Non-Goals:** What are we explicitly NOT doing in this plan?

- [Non-goal 1]
- [Non-goal 2]

## Approach Summary

High-level implementation strategy. What's the overall approach? What major
architectural or design decisions guide this plan?

[Describe the path from current state to proposed state. Reference key files or
patterns in current codebase that will change.]

## Phases

Break work into major, verifiable chunks focused on pivotal points (complex
areas, migrations, significant transitions).

### Phase 1: [Phase Name]

**Goal:** [What this phase achieves]

**Key Changes:**

- [What files/components are being modified or created?]
- [What patterns or architecture are changing?]
- [What's complex or risky in this phase?]

**Validation:** How do we know this phase is complete?

- [ ] [Test or check that must pass]
- [ ] [Expected behavior or state]

**Dependencies:** [What must exist before starting this phase, if any]

---

### Phase 2: [Phase Name]

**Goal:** [What this phase achieves]

**Key Changes:**

- [What files/components are being modified or created?]
- [What's being integrated or connected?]
- [What's complex or risky in this phase?]

**Validation:** How do we know this phase is complete?

- [ ] [Test or check that must pass]
- [ ] [Expected behavior or state]

**Dependencies:** [Phase 1 complete, plus any other dependencies]

## Key Risks & Mitigations (Optional)

What could get complex or go wrong? How will we handle it?

- **[Risk 1]:** [What could go wrong] → [How we'll mitigate or work around it]
- **[Risk 2]:** [What could go wrong] → [How we'll mitigate or work around it]

## Testing & Validation Strategy

How will we validate this works?

[Describe overall testing approach - what needs unit tests, what workflows need
integration testing, what should be manually verified, what edge cases to cover]

## Assumptions & Constraints (Optional)

**Assumptions:** What are we assuming?

**Constraints:** What are our limitations?

## Rollback Plan (Optional)

[Only needed for risky changes, data migrations, or production deployments. Most
feature work won't need this.]

## Observability (Optional)

[Only needed if this requires monitoring, metrics, or alerts in production. Most
feature work won't need this.]

## Open Questions (Optional)

[What needs to be resolved during implementation?]

---

**Related Documents:**

- [Proposal](./proposal.md)
- [Architecture docs](../../architecture/doc-name.md)
- [Sessions](./sessions/) (created during implementation)

---

## Implementation Notes

[Optional section for implementation-specific context, decisions made during
development, or lessons learned]
