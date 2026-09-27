---
type: session
title: "The acc conformance cycle: nine CLIs through the full guidance"
description:
  Nine spell CLIs taken through all seven acc steps on a new shared kit
  registry, behind a golden snapshot and an acc gate; lead-orchestrated
  subagents while Cole was away.
tags: [area, feature]
status: stable # A session is frozen the moment it is written; it is never a draft.
generated: { by: claude-opus-5-5, at: 2026-09-26 }
---

# The acc conformance cycle — 2026-09-26

## Context

Cole ruled that all nine spell CLIs go through the full acc guidance (seven
steps), then left the lead to run the cycle
([2026-09-acc-conformance](../../../cycles/2026-09-acc-conformance.md)) with
subagents doing the work. Every call made in his absence is in the
[decision log](../decision-log.md) with the options not taken; ⭐ marks the ones
for his review.

## What Happened

1. **Baseline** on acc v0.1.15: six of nine L0 conformant (bounty, imago,
   digestify failing), four without a config, five whose rejections named no
   flag set, three with a `schema` verb.
2. **Phase A, in parallel:** the gate (`grimoire/acc-conformance.test.ts`,
   today's failures as `knownFailures` debt) and research into a shared CLI
   registry. A no-stake cold read of the research ran the claims and found real
   gaps (defaulted flags, mind-mapper's `doc` sub-verb, digestify's empty argv)
   that became requirements (#9–#11).
3. **The registry, behind a net:** a golden snapshot of all nine CLIs (846
   invocations, every documented one included) and `src/kit/cli/registry.ts` in
   parallel, then glamour, scriptorium and grapevine moved onto it. The lead
   audited the re-recorded fixtures: every change was an expected kind.
4. **Wave 1** (bounty, imago, digestify, plus step 5 and doc fixes for the first
   three) and **wave 2** (astrolabe, magpie, mind-mapper), each in its own
   worktree, merged by the lead with the shared ward pins reconciled by hand and
   the full gate after each wave.
5. **Wrap-up:** the lead re-ran `acc check` on all nine independently, fixed the
   golden harness's `--` gap (#18), drafted the upstream report, returned `c1`
   to spell-hardening, and filed two follow-ups.

## Notable Discoveries

- **The cold read paid for itself.** Every gap it found would have surfaced as a
  failing adopter mid-wave.
- **Bun strips a leading `--`** after the script path, so root-level terminator
  records silently tested something else (#18).
- **Tailwind scans prose in `src/kit/`:** the word "table" in the registry added
  a CSS utility to three spells (#15).
- **A downstream parser nobody listed:** anthill regex-parses `bounty sessions`,
  so bounty kept prose (#20).
- **`c1` is only half a CLI-contract defect** (#21).

## Changes Made

- `src/kit/cli/registry.ts` (new): one table drives parse, dispatch, help,
  rejections, `--version` and `schema`; all nine spell CLIs run on it.
- `grimoire/acc-conformance.test.ts` and `grimoire/cli-golden.test.ts` (new
  wards); flag-invariant, strict-parse, terminator and the error-choices census
  read registry-based spells.
- Per spell: `acc.config.json`, `acc.recorded-surfaces.json`, SKILL.md fixes,
  rebuilt `dist/`.

## Follow-up

- ⭐ File the [upstream acc report](../acc-upstream-feedback.md) (#23).
- [bounty JSON in lockstep with anthill](../../../items/bounty-json-output-in-lockstep-with-anthill.md)
  and
  [required flags in the registry](../../../items/registry-required-flags.md)
  are in `triage`.
- Spell-hardening next (Cole's ruling, #5): its fix queue is unchanged by this
  cycle except `c1`'s root-level half.
