---
type: item
title:
  Rewrite terminator-invariant over the kit registry, then calibrate D6's four
  wards
description:
  terminator-invariant still says 'nothing warns' and pins 6 of 7 unverified
  entry points; since phase 1 there is one caller-facing parser that warns.
  Rewrite it over the registry's adopters, then second-seat calibrate
  roster-drift, gate-honesty, terminator-invariant and strict-parse-invariant.
status: draft # OKF §5.4: draft | stable | deprecated. Nothing else.
lifecycle: review
id: 01a0e213-3b28-7512-8ca2-9f119e11aad1
kind: task
generated: { by: claude-opus-5-5, at: 2026-09-27 }
parent: feature/spell-hardening
cycle: 2026-09-filed-is-not-fixed
---

# Rewrite terminator-invariant over the kit registry, then calibrate D6's four wards

Part of [spell-hardening](../features/spell-hardening/feature.md), sprint 06
phase 2.

Merges `c1`'s unwritten entry-point ward with D6's second-seat calibration
([phase-2 scope](../features/spell-hardening/sprints/06-filed-is-not-fixed/phase-2-scope.md)).
Phase 1 (`dccd2cb7`) made the kit registry warn when a flag the row accepts
appears after `--`. `grimoire/terminator-invariant.test.ts` still says "NOT
SOLVED… nothing warns" and pins "6 of 7 UNVERIFIED"; it stays green because it
exercises `node:util`, not the registry. The population is now 1 caller-facing
parser (the registry) with 9 adopters.

## Definition of done

- [x] terminator-invariant asserts, over every registry adopter taken from the
      files (not a hand list), that a row-accepted flag after `--` warns and
      leaves stdout and exit unchanged; zero-denominator guard on rows with
      positionals > 0. Its header and pins say what is true now.
- [x] D6: each of roster-drift (17 cells), gate-honesty (6),
      terminator-invariant (rewritten) and strict-parse-invariant (3) is
      calibrated by a second seat in a **detached git worktree**
      (`git worktree add --detach`, never a copy): a planted defect per cell
      family turns it red; the calibrator prints `pass / fail / CELLS` and
      reconciles the cell count against the real tree.
- [x] Anything a calibration finds uncalibrated or vacuous is fixed or filed.

Done on `test/terminator-ward-over-the-registry`: the ward rewrite is
`0adb8fe5`; the calibration record is
[d6-calibration.md](../features/spell-hardening/sprints/06-filed-is-not-fixed/d6-calibration.md).
