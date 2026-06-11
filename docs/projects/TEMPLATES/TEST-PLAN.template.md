<!--
USAGE: Copy this file to your project folder as `test-plan.md`.

This template helps you define structured verification scenarios for agent-
implemented work. It's designed around the 80/20 rule: test what matters most,
explicitly defer the rest.

The test plan is created AFTER the development plan. It translates the
proposal's goals and the plan's phases into concrete, prioritized verification
scenarios that an implementing agent can execute autonomously.

When to use:
- Features with UI that needs visual verification
- Work where "did the agent actually build what was asked?" is a real question
- Parallel development where manual testing becomes a bottleneck

When to skip:
- Pure refactoring with no behavioral changes
- Documentation-only work
- Trivial changes where the commit diff is the verification
- Projects with comprehensive existing automated test coverage

The tiered system prevents the common failure mode of test plans — trying to
test everything and testing nothing well.

For more guidance on test plans, see the projects README: ../README.md
-->

# Test Plan: [Feature Name]

**Status:** Draft | Scenarios Complete | In Execution | Results Recorded\
**Created:** YYYY-MM-DD\
**Related Plan:** [Development Plan](./plan.md)\
**Related Proposal:** [Proposal](./proposal.md)

---

## Overview

[1-2 paragraphs describing what is being verified and why. Connect back to the
proposal's goals and the plan's phases. State the scope of verification — what
this test plan covers and what it intentionally leaves out.]

## Test Environment

**Prerequisites:**

- [How to start the app (e.g., `pnpm dev`, `npm start`)]
- [URLs to access (e.g., `http://localhost:3000`)]
- [Any seed data or setup scripts needed]

**External Dependencies:**

[Skip this section if there are no external dependencies. Many features have
none.]

- **Third-party services** — [Accounts, platforms, or infrastructure that must
  exist before testing]
- **Credentials & API keys** — [Specific keys or tokens and where they come
  from]
- **Environment variables** — [`.env` values that must be populated]
- **Human actions required** — [Setup steps that cannot be automated by the
  agent]
- **Verification command** — [A quick check to confirm prerequisites are met
  before attempting test execution, e.g., `curl $ENDPOINT` and confirm 200]

---

## Verification Scenarios

### Tier 1 — Smoke Tests

_Always required. Cheap checks that the feature doesn't break anything._

#### T1-01: [App builds and starts]

**Type:** Smoke\
**Source:** Baseline

**Steps:**

1. [Run build command]
2. [Start app]
3. [Verify no startup errors]

**Expected:** App builds cleanly and starts without errors.

---

#### T1-02: [New pages/routes render]

**Type:** Smoke\
**Source:** Plan Phase [N]

**Steps:**

1. [Navigate to new route]
2. [Check for console errors]

**Expected:** Page renders without console errors.

---

### Tier 2 — Critical Path

_Core user flows mapped from proposal goals. This is the real value of the test
plan._

#### T2-01: [Core user flow description]

**Type:** UI/E2E | Unit | Integration\
**Source:** Proposal goal: "[specific goal from proposal]"

**Steps:**

1. [Concrete step]
2. [Concrete step]
3. [Concrete step]

**Expected:** [Specific expected outcome. No console errors.]

---

### Tier 3 — Edge Cases & Robustness

_Backlog unless covering critical infrastructure. Explicitly deferred with
rationale._

#### T3-01: [Edge case description]

**Type:** Unit | Integration | Manual\
**Source:** [Risk area or plan phase]\
**Deferred rationale:** [Why this is Tier 3 — complex mocking, low probability,
requires infrastructure not yet available, etc.]

---

## Out of Scope

[Tests explicitly not included in this plan, with brief rationale.]

- [Test area 1] — [Why it's excluded]
- [Test area 2] — [Why it's excluded]

---

## Results Addendum

_Filled in during and after test execution by the implementing agent._

| Scenario | Status            | Notes                           |
| -------- | ----------------- | ------------------------------- |
| T1-01    | Pass/Fail/Blocked | [Details on failures or blocks] |
| T1-02    | Pass/Fail/Blocked | [Details on failures or blocks] |
| T2-01    | Pass/Fail/Blocked | [Details on failures or blocks] |
| T3-01    | Skipped           | [Tier 3 — deferred]             |

**Blocked scenarios:** [If any scenarios are blocked due to unmet prerequisites,
describe what's needed for them to become executable.]

## Visual Artifacts

_Screenshots captured during UI/E2E verification, stored in the project's
artifacts directory._

**Screenshot directory:** `docs/projects/<project-name>/artifacts/screenshots/`

**Naming convention:** `<scenario-id>-<description>.png` (e.g.,
`T2-01-create-document.png`)

| Scenario | Screenshot                          | Description                  |
| -------- | ----------------------------------- | ---------------------------- |
| T2-01    | `T2-01-create-document.png`         | [What the screenshot shows]  |
| T2-01    | `T2-01-create-document-success.png` | [Success state after action] |
