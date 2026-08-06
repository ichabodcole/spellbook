<!--
USAGE: Copy this file to your project folder as `plan.md`.

This template helps you create a development roadmap - showing the route from current codebase to completed feature.
Focus on pivotal points: complex areas, significant changes, migration concerns, key validation gates.

Think "gas stations on a road trip" - highlight important stops and transitions, but don't give turn-by-turn directions.
The developer drives; you're providing the map and calling out where things get tricky.

Adapt sections freely. Not every plan needs all sections (e.g., many won't need Rollback Plans or Observability).
Ground your plan in the actual codebase - reference files, analyze current patterns, show the path forward.

SCOPE: a plan covers ONE SPRINT's worth of work. If it's growing past ~500 lines,
or you're on your third round of amendments, that's the signal to close this sprint
and open a new one — not to keep extending this file. See "Multi-Sprint Projects"
in the projects README.

FREEZING: when a sprint closes, its plan is FROZEN. Never edited again — not a typo,
not a status tweak. Changes go in outcome.md or the next sprint's plan, which restates
what it inherits rather than amending this one. That's what preserves the record of what
was actually planned, and known, at the time.

At freeze time, PIN every file:line reference to a sha (see the Code References block
below). Line numbers in a frozen doc drift within days; a reader landing on a plausible
wrong line has no way to know they're being misled.

For more guidance on plans, see the projects README: ../README.md
(If this plan lives in sprints/NN-name/, that's ../../README.md.)
-->

# [Feature Name] Implementation Plan

**Created:** YYYY-MM-DD **Related Proposal:** [Link to proposal](./proposal.md)
**Status:** Draft | Active | Completed | **Frozen** | Superseded

<!--
Once this plan's sprint has closed, replace the line below with the frozen banner
and stop editing this file:

  > **FROZEN YYYY-MM-DD** at the close of sprint NN. Do not edit. All code
  > references below are pinned to `<sha>` — read them with
  > `git show <sha>:path/to/file.ts`. What happened is in
  > [outcome.md](./outcome.md); what carried forward is in the next sprint's plan.
-->

**Code references in this plan are current as of `<sha>`.**

---

## Overview

[1-2 paragraph summary connecting back to the proposal and outlining what this
plan covers. Reference current codebase state and the path to implementation.]

## Carried Forward (sprint plans only)

[Restate — in your own words, against the current code — whatever this sprint
inherits from the previous sprint's `outcome.md`. Restatement, not a link: the
previous plan is frozen and its line references point at an old sha, so a reader
who follows a pointer back lands in a document that is deliberately out of date.

Delete this section in a project's first (or only) plan.]

- [Inherited item, restated with current file references]
- [Inherited item, restated]

Source: [sprint NN outcome](../NN-previous-name/outcome.md)

## Code References

[Optional but strongly recommended for any plan that cites `file:line`.

While the plan is Active, references track the working tree and are expected to
move. At freeze time, pin them:

All references below are pinned to `5dfbb0d`. Read them with
`git show 5dfbb0d:path/to/file.ts`.

Pin the table, don't renumber it. Renumbering is a race you lose — in
spell-hardening, 6 of 9 references went stale inside a single session — and it
means editing a document that's supposed to be settled.]

| Reference           | What it shows      |
| ------------------- | ------------------ |
| `src/foo/bar.ts:42` | [why this matters] |

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
- [Outcome](./outcome.md) (sprint plans only — written when the sprint closes)
- [Previous sprint's outcome](../NN-previous-name/outcome.md) (sprint plans only
  — the source of what this plan restates as carried forward)

---

## Implementation Notes

[Optional section for implementation-specific context, decisions made during
development, or lessons learned]
