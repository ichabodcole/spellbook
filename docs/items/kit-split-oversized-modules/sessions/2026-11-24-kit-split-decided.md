---
type: session
title: Splitting the kit's oversized modules — 2026-11-24
description:
  Research on splitting the kit's oversized modules by porting Story Studio's
  split, Cole's rulings, Story Studio's answer, and the split's steps filed as a
  feature and planned cycle.
tags: [kit, refactor]
status: stable
generated: { by: claude-opus-5-5, at: 2026-11-24 }
---

# Splitting the kit's oversized modules — 2026-11-24

Part of
[Research first, and the bugs that bite](../../../cycles/2026-11-research-and-safety.md).

## Context

`session.ts` was over 9,000 lines and five other kit files over 1,500. Story
Studio split the same files in its refactoring cycle (closed 2026-11-08). The
question was how to split ours, and whether to follow their shape.

## What Happened

A research agent wrote the write-up on 2026-11-17: port Story Studio's split,
adapted (option C), as a chain of behaviour-preserving steps named after theirs
(G, S, D, R, V, W, P), with a 1,200-line Biome limit guarding it. The lead
offered it to Story Studio on kit-parity (message 71).

Cole approved all eight decisions as recommended on 2026-11-24, and dedicated
the next cycle to the build. A second agent filed the
[kit-split feature](../../../features/kit-split/feature.md) with 36 step items
and [cli-yaml-off-start-path](../../cli-yaml-off-start-path.md), each blocked by
the step before it, and re-pointed the nine items that waited on this research
to the step that moves their code. The lead drafted the
[kit-split cycle](../../../cycles/2026-12-kit-split.md); Cole approved it with
the five spell fixes alongside. It stays `planned` until this cycle closes.

Story Studio answered the same day (message 73): six parts added since their
cycle and none renamed; copy their tier test and architecture page from their
develop; they keep their tier table to their own parts; no lesson beyond their
playbook's rule 20.

## Review

Census from the Agent tool's roster: `feature-dev:code-reviewer` rejected (no
Bash); `doc-reviewer` (All tools) chosen, as the branch is docs only.

It re-measured the start path (99 modules on the CLI, 72 of them `yaml`; written
as 98), resolved every `blocked_by` chain by script, checked Story Studio's
commits and tree, and ran the docs lint and Prettier. Verdict: with fixes. The
write-up's line counts were taken at `9e3808af`, before the cycle's bug fixes
grew `session.ts`, `protocol.ts`, `verbs.ts` and `DocumentPane.tsx`, so G1 now
re-measures with Biome rather than freezing the write-up's counts; two
re-pointed items still said the build items were unfiled; the G1 row said
"ported" where Story Studio's answer says copy from their develop. All fixed and
re-checked.

## Follow-up

- Whoever activates the kit-split cycle sets `cycle: 2026-12-kit-split` on the
  items it takes.

---

**Related Documents:**

- [Split the kit's oversized modules, starting with session.ts](../item.md)
- [Splitting the kit's oversized modules](../write-up.md)
