# Backlog — `gate` runs twice on every push, and one of the two is wasted

**Status:** backlog (not scheduled). Captured 2026-09-15 while landing
`spellbook-v3.0.0`. **Severity:** none functionally — **cost only**, and it is
paid on every push. The required check is satisfied by either run.

## Measured

`.github/workflows/ci.yml` triggers on both:

```yaml
on:
  pull_request:
  push:
    branches: [develop, main]
```

So a push to `develop` while the `develop`→`main` PR is open fires **both**
events and GitHub starts **two identical `gate` runs**. Observed on every push
of this release:

| sha        | runs                      | duration each       |
| ---------- | ------------------------- | ------------------- |
| `3fe6eaaf` | 34915218157 · 34915222053 | both failed         |
| `f477f92c` | 34918215288 · 34918218889 | both failed         |
| `c3ede8ae` | 34919778927 · 34919782583 | ~4m30s, both passed |

`gate` is build + lint + the full 2,544-test suite + `dist-check`, so this is
roughly **4½ wasted CI-minutes per push**, doubled on a day with several pushes.
There is no `concurrency` block, so nothing cancels the redundant run and
nothing cancels a superseded run when you push twice in a minute.

## ⛔ The constraint any fix must respect

The workflow header is emphatic, and it is right:

> **THE JOB'S NAME IS `gate` AND IT MUST STAY `gate`.** A ruleset on `main`
> requires a status check named `gate`. … A required check that never reports
> does not fail — it hangs every PR forever on "Expected — waiting for status to
> be reported", which looks like GitHub is broken.

Verified 2026-09-15: ruleset **"Main Gate"** (`22059514`) is active on
`~DEFAULT_BRANCH` with `required_status_checks: [{context: "gate"}]`.

**Therefore: `pull_request` cannot be dropped.** It is the trigger that makes
the required check report on a PR. Dropping it hangs every PR into `main`
indefinitely — the worst available outcome, and worse than paying the minutes.
The redundant trigger is the `push` one.

## Candidate fixes, none chosen

1. **A `concurrency` group** — the conventional fix, and it also solves the
   push-twice-in-a-minute case the trigger change does not:
   ```yaml
   concurrency:
     group: gate-${{ github.workflow }}-${{ github.ref }}
     cancel-in-progress: true
   ```
   ⚠ But `push` and `pull_request` for the same commit have **different**
   `github.ref` (`refs/heads/develop` vs `refs/pull/N/merge`), so keyed on `ref`
   this does **not** deduplicate the pair — it only cancels superseded runs of
   the same kind. Keying on `github.sha` would collapse the pair, at the cost of
   cancelling a run whose result the PR may be waiting on. **Needs thought, not
   a paste.**
2. **Narrow `push` to `main` only.** `develop` pushes would then be gated solely
   through the open PR. Cheapest, and loses the check on a `develop` push made
   while no PR is open — which is most of the time between releases, so this
   trades minutes for coverage.
3. **Skip the `push` run when a PR is open for that ref**, via an `if:` on the
   job. Keeps both coverage and the name; adds a conditional whose failure mode
   is the check not reporting, which is the hang above. **Highest risk for the
   smallest saving.**

## What to check before acting

- Whether this repo is actually near any CI-minutes limit. If it is not, option
  2 trades real coverage for a cost nobody is paying, and **doing nothing is
  defensible** — this item exists to make that a decision rather than an
  oversight.
- That whatever lands still reports `gate` on a `develop`→`main` PR. The only
  honest test is opening a throwaway PR and watching the check appear; reasoning
  about trigger semantics is how the hang gets shipped.
- Rulesets are not in the tree. Confirm the required context with
  `gh api repos/ichabodcole/spellbook/rulesets/22059514` rather than trusting
  this file — see
  [the closed backlog item](./2026-08-31-the-pr-check-must-be-marked-required.md)
  for what happened the last time a doc asserted GitHub configuration from
  memory.
