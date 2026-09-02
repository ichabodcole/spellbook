# `ward` routes an un-rebuilt surface edit to `chore(`, and the guard that should catch it passes

**Added:** 2026-08-31 · **Found by:** `cassandra`, during the release-staleness
spike · **Verified by:** `prospero` against
`.claude/skills/ward/SKILL.md:150-161` · **Scope:** the `ward` skill, one
section · **Severity:** medium — **it misroutes real work, silently, and the
misroute is invisible until a release**

## The defect

`ward`'s **"Changing repo tooling (nothing ships)"** checklist discriminates on:

> **The distinguishing fact: a consumer who installs the plugin gets nothing
> different.**

and guards it with:

> - [ ] **Confirm nothing under `plugins/spellbook/` changed.** If something
>       did, this is the wrong checklist — it is a spell revision as well.

**For an un-rebuilt surface edit, both are LITERALLY TRUE.**
`src/<spell>/surface/` lives outside `plugins/spellbook/` by Contract 4's
design, so editing a surface changes nothing under the shipped subtree **until
you build**. The guard passes, the checklist applies, and the change is
committed as `chore(` — no version bump, no `dist/`, and **it never reaches a
consumer.**

**The discriminator is evaluated against the stale tree, so staleness makes the
wrong answer correct.** This is the same shape as sprint 01's byte-count check
preferring the broken artifact: a check that is honest about what it measures
and measures the wrong moment.

## Why this is not fixed by "add a build step to the checklist"

That was the first instinct and it is insufficient. **The routing question has
to move before the build step is added** — otherwise the checklist still asks
"did anything ship?" at a point where the honest answer is _"not yet, and that
is the bug."_

The correct discriminator is not _did anything under `plugins/spellbook/`
change_ but **would anything change if you built?** — which cannot be answered
by looking at the tree. It can only be answered by building.

**That makes this defect and the mechanical check the same problem seen from two
sides**, and it is why they should be fixed together rather than in sequence.

## The shape of the fix

A new section, checked **before** the "nothing ships" one, so the false-yes
cannot be reached. Draft in
[the spike](../investigations/2026-08-31-releasing-a-non-stale-build.md#the-ward-skill-has-a-routing-bug-that-staleness-makes-invisible),
covering: build first, stage the `dist/` with the source edit in the same
commit, the `.gitignore` un-ignore trap for a newly relocated spell, and the
ruling that this is a `feat(`/`fix(` rather than a `chore(`.

## Acceptance

- [ ] A surface edit cannot reach the "nothing ships" checklist without the
      build question being answered first.
- [ ] The `.gitignore` un-ignore pair is named — a newly relocated spell's
      `dist/` is **silently skipped by `git add` at exit 0**, and the spell then
      ships with no surface.
- [ ] Ideally landed **with** `scripts/dist-check.ts`, since the checklist step
      and the mechanical check answer the same question and one can cite the
      other.

> **Owner:** the grimoire seat (`thoth`) — `ward` is a repo-local authoring
> ritual and the change is to what it asserts, not to how it is run.
