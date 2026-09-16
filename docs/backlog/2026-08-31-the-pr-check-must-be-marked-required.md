---
type: backlog
title:
  "The `develop`→`main` PR check must be marked REQUIRED — and only a human can
  do it"
status: stable
lifecycle: open
generated: { by: unknown, at: 2026-08-31 }
---

# The `develop`→`main` PR check must be marked REQUIRED — and only a human can do it

## ✅ CLOSED — ALREADY DONE ON 2026-09-01, AND NOBODY NOTICED FOR TWO WEEKS

Repository ruleset **"Main Gate"** (id `22059514`) was created
**2026-09-01T18:39:36-07:00** — the day after this item was filed — is
`enforcement: active`, targets `~DEFAULT_BRANCH`, and carries
`required_status_checks` with exactly `{"context": "gate"}` alongside
`deletion`, `non_fast_forward` and `pull_request` rules.

Verified 2026-09-15, and not by reading:

```
gh api repos/ichabodcole/spellbook/rulesets/22059514
gh pr checks 104   # gate  pass  4m38s   — the release PR into main
gh pr checks 105   # gate  pass  4m25s
```

⛔ **THE COST OF NOT CLOSING IT WAS A FALSE CLAIM IN A PUBLISHED RELEASE NOTE.**
The 3.0.0 note lists as a standing limit that _"`gate` has to be marked required
in GitHub's settings, and no agent can do that. Until a human does, a red `gate`
does not block a merge"_, and adds that a check which caught two real defects on
its first outings _"is not yet allowed to block a merge."_ **Both sentences are
wrong**, and they are frozen in the `develop`→`main` merge commit body. This
file is the pointer that note gives for the detail, so a reader who follows it
lands here — which is the only correction available once a merge commit is
published.

⚠ **AND THE REASONING ERROR IS THE PART WORTH KEEPING.** The note said, of the
workflow header's assertion that a ruleset requires `gate`: _"nothing in this
tree can confirm it — treat that sentence as an instruction to a human, not a
statement of fact."_ The first half was true. The conclusion was not: the tree
was never the only available source. `gh api` was one call away for the entire
session, and the same agent used `gh` freely for PRs, runs and logs. **"Not
verifiable from the tree" was silently upgraded to "not verifiable",** and a
stale backlog item was taken as current state because nothing contradicted it.
Repo configuration is observable; ask GitHub rather than inferring from a file
that was written before the configuration existed.

The workflow header's claim in `.github/workflows/ci.yml` was **correct** and
needs no change.

## The claim this exists to stop

Once `.github/workflows/ci.yml` lands, it is very easy — and completely wrong —
to say _"the PR check protects the release."_ **It does not, until it is marked
required in branch protection.** An unrequired check runs, reports, and can be
merged straight past.

**Branch protection is a GitHub repository setting, not a file in this repo.**
So:

- no agent can land it,
- no agent can verify it,
- and **nothing in the tree will ever go red if it is missing.**

That combination — a protection everyone believes is in place, with no artifact
that can contradict them — is precisely the _false reassurance about an
instrument_ this team ranks above a false claim about code.

## Why it matters more here than it looks

Feature branches merge to `develop` **locally, with no PR**. So a PR check first
fires at `develop`→`main` — the merge Cole performs, and the last moment before
a release. **It is the only layer that survives a `--no-verify` commit or a push
straight to `main`.**

The `bun test` cell covers the window before that, and only for seats who run
the gate. The two layers cover different halves and neither covers it alone.

## Acceptance

- [ ] `ci.yml` exists and runs on `pull_request`.
- [ ] **Cole** marks it a required status check on `main` in branch-protection
      settings.
- [ ] The fact that it is required — and that this is a setting rather than a
      file — is written into `AGENTS.md`'s landing policy, **which is the only
      place a future agent will look and the only artifact that can carry it.**

> **Do not close this by writing the workflow.** The workflow is the
> prerequisite; the setting is the item. Closing it on the file landing is
> exactly the substitution it was filed to prevent.
