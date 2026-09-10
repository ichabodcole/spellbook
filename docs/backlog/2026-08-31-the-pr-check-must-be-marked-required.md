# The `develop`→`main` PR check must be marked REQUIRED — and only a human can do it

**Added:** 2026-08-31 · **Raised by:** `cassandra` (release-staleness spike) ·
**Owner: COLE. Not the team's, and not because of scope — because an agent
cannot do it.** · **Blocked on:** the CI workflow existing at all ·
**Severity:** medium, and **latent**

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
