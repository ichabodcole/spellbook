<!--
USAGE: Copy this file to `sprints/NN-short-name/outcome.md` when a sprint ends.

An outcome closes a sprint. It is written ONCE, at the close, and it is the only
honest record of the gap between what the plan intended and what actually
shipped. Its most valuable sections are the uncomfortable ones — what did NOT
get done, and what the work falsified.

Write it before you write the next sprint's plan. The Carry-Forward section IS
the input to that plan: the next plan restates what it inherits from here, in
its own words. It never reaches back and amends this sprint's plan.

Two things happen at close, in this order:
  1. Write this document.
  2. FREEZE the sprint's plan.md — pin its file:line references to a sha, add
     the frozen banner, and never edit it again.

For more guidance, see the projects README: ../../README.md
-->

# Sprint NN: [Short Name] — Outcome

**Sprint:** `sprints/NN-short-name/` **Plan:** [plan.md](./plan.md) (frozen)
**Opened:** YYYY-MM-DD **Closed:** YYYY-MM-DD **Result:** Shipped | Partially
shipped | Abandoned

---

## Summary

[2-4 sentences. What this sprint set out to do, and what the reader should
believe about the codebase now that it's done. Someone reading only this
paragraph should know whether the sprint's goal was met.]

## Planned vs. Shipped

| Planned (from plan.md) | Status                       | Notes                   |
| ---------------------- | ---------------------------- | ----------------------- |
| [Phase 1: name]        | Shipped                      | [anything notable]      |
| [Phase 2: name]        | Shipped, scope reduced       | [what was cut, and why] |
| [Phase 3: name]        | **Not done** → carry-forward | [why it didn't happen]  |

**Be honest about the "not done" rows.** An outcome that reports only successes
is worthless — the next sprint gets planned off this table, and a table that
overstates completion produces a plan built on work that doesn't exist.

## Commits

[So the diff is reachable without archaeology. Sha + subject; a range is fine if
the sprint was a clean run of commits.]

- `abc1234` — [subject]
- `def5678` — [subject]

**Branch:** `[branch-name]` **Merged to:** `[develop | main]` on YYYY-MM-DD

## What Was Falsified

[A plan is a set of claims. Which ones did the work disprove?

This section exists so the next plan doesn't inherit a dead assumption. Be
specific about what was believed, what turned out to be true, and what that
invalidates.

Examples:

- "The plan assumed X could be reused; it couldn't, because Y. Anything in the
  proposal that depends on reusing X needs rethinking."
- "The plan claimed the daemon owned exit; it doesn't — the CLI does. Phase 4's
  approach is now wrong as written."

If nothing was falsified, say so explicitly — that's a real (and rare) result,
not an empty section.]

## Changed During the Sprint (Optional)

[Decisions made mid-flight that departed from the plan but weren't
falsifications — a different library, a reordering, an approach swap. Include
the reasoning; the next planner needs to know whether the change was forced or
chosen.]

## Carry-Forward

**This list is the handoff.** The next sprint's plan restates these in its own
words. Anything not written down here effectively did not happen.

- [ ] [Work that was planned and not done — with enough context to re-plan it
      without re-reading this sprint's plan]
- [ ] [Work this sprint created: follow-ups, TODOs left in code, deferred
      cleanup]
- [ ] [Open questions the sprint raised and didn't answer]

**Explicitly dropped (not carried forward):**

- [Thing that was planned, didn't happen, and should NOT be picked up again —
  with the reason. Saying this out loud stops the next planner from silently
  re-adding it.]

## Notes (Optional)

[Anything else the next sprint's author should know. Environment quirks, review
feedback that arrived late, external dependencies that shifted.]

---

**Related Documents:**

- [This sprint's plan](./plan.md) (frozen — do not edit)
- [Project ledger](../../README.md)
- [Proposal](../../proposal.md)
- [Previous sprint's outcome](../NN-previous-name/outcome.md) (if any)
