---
type: feature
title: Spell CLI acc conformance
description:
  "Bring all nine spell CLIs through the full acc guidance: L0 conformant, a
  declared machine default, rejections that name their valid set, recorded
  subcommand surfaces, one registry driving each surface, and a gate that keeps
  it."
tags: [acc, cli, conformance]
status: draft
lifecycle: review
generated: { by: claude-opus-5-5, at: 2026-09-26 }
---

# Spell CLI acc conformance

## Overview

Every spell's CLI is driven by agents, and `acc` (agent-cli-conformance, pinned
at v0.1.15) is the house standard for what a CLI owes a caller that is a
program. Its guidance runs in seven steps (the `acc` skill,
`.claude/skills/acc/SKILL.md`). Six of the nine CLIs pass L0 today; none has
been taken through all seven steps. This feature takes every spell CLI through
all of them, and adds a gate so the result holds.

## Problem Statement

Conformance is uneven and nothing holds it in place:

- **Three CLIs fail L0**: bounty and imago (A6, C2, D1, D2, D3) and digestify
  (C1, D1).
- **Four have no `acc.config.json`** (bounty, digestify, grapevine, imago), so
  their machine-mode check (B5) is `unverified` rather than checked.
- **Five do not name their valid flag set** when they reject one (astrolabe,
  bounty, imago, magpie, mind-mapper), so a caller cannot self-correct, and the
  census has nothing to compare below the root.
- **No CLI's subcommands are checked.** `acc check` probes only the top level.
  The surfaces recorded for grapevine and bounty in August (in
  `features/spell-hardening/artifacts/`) are not wired into any config.
- **Three of nine derive their surface from one registry** (glamour, grapevine,
  scriptorium, each with a `schema` verb). The other six can drift from their
  own help and errors.
- **No gate runs `acc check`.** A regression is found only when someone runs it
  by hand.

## Proposed Solution

One item per spell, each taking that CLI through steps 3 to 6 of the guidance,
plus a gate that runs the kit over every CLI, and one research item on a shared
CLI registry so step 6 is not hand-copied six times.

The seven steps, and where they land:

| Step                                         | Where it is done                                            |
| -------------------------------------------- | ----------------------------------------------------------- |
| 1. Install, pinned, `version --check`        | Done: v0.1.15, 2026-09-26                                   |
| 2. Read the result, `NOT FULLY VERIFIED`     | Done: baseline below                                        |
| 3. Fix to L0: fix, waive or record debt      | each spell's item                                           |
| 4. Adopt: named rejections, declared default | each spell's item                                           |
| 5. Record the surfaces below the root        | each spell's item                                           |
| 6. One registry drives parser, help, schema  | each spell's item, informed by the shared-registry research |
| 7. Report kit friction upstream              | every item: file what bites in the acc repo                 |

## Scope

**In scope:** the nine spell CLIs (astrolabe, bounty, digestify, glamour,
grapevine, imago, magpie, mind-mapper, scriptorium) and the gate.

**Out of scope:** spell daemons and HTTP routes (acc checks CLIs); rewriting a
CLI beyond what the guidance requires; acc itself (friction goes upstream, step
7).

## Technical Approach

- **Baseline, acc v0.1.15, 2026-09-26** (`acc check` run from each skill's
  folder, per the house pattern):

  | Spell       | L0  | Failing rules      | Config | Root rejections name flags | `schema` |
  | ----------- | --- | ------------------ | ------ | -------------------------- | -------- |
  | astrolabe   | ✅  | A6 (diagnostic)    | yes    | no                         | no       |
  | bounty      | ❌  | A6, C2, D1, D2, D3 | no     | no                         | no       |
  | digestify   | ❌  | C1, D1             | no     | yes                        | no       |
  | glamour     | ✅  | —                  | yes    | yes                        | yes      |
  | grapevine   | ✅  | —                  | no     | yes                        | yes      |
  | imago       | ❌  | A6, C2, D1, D2, D3 | no     | no                         | no       |
  | magpie      | ✅  | —                  | yes    | no                         | no       |
  | mind-mapper | ✅  | —                  | yes    | no                         | no       |
  | scriptorium | ✅  | —                  | yes    | yes                        | yes      |

- **Each spell parses its own arguments** (`parseArgs` in
  `src/<spell>/backend/cli.ts`); there is no shared parser in `src/kit/`, so the
  bounty/imago overlap is two copies of one pattern, not one bug.
- **The reference implementations** are glamour and grapevine (registry-derived
  surface, `schema` verb, census) and scriptorium.
  `docs/features/glamour-acc-l0/` records how glamour got there.
- **Step 6 runs on a shared kit module** (decided 2026-09-26 from
  [the research](../../items/shared-cli-registry-in-the-kit/write-up.md) and
  [its cold read](../../items/shared-cli-registry-in-the-kit/artifacts/cold-read.md)):
  `src/kit/cli/registry.ts`, built first in
  [item/build-kit-cli-registry](../../items/build-kit-cli-registry.md) behind a
  golden snapshot of all nine CLIs, and proven on glamour, scriptorium and
  grapevine. The other six items are blocked on it.
- **Execution:** subagents do the work, one per item; the lead briefs, reviews
  and lands. Run the gate item early enough that later items land against it.

## Impact & Risks

- **C2/D2 change behaviour a user may rely on:** a bare invocation that now
  prints help and exits 0 will exit 2 with usage on stderr. That is the
  contract, and grapevine made the same break at V2.0; say so in the release
  note.
- **Overlap with spell-hardening:** bounty's A6 failure is
  [item/terminator-eats-session-key](../../items/terminator-eats-session-key.md)
  (`c1`), and C2/D1 sit close to that feature's unbuilt exit-code contract.
  Whatever spell-hardening keeps, do not do this work twice.
- **Census noise:** recording below the root on a verb-first CLI surfaces many
  paths at once; read the rollup, and treat `knownFailures` as debt, not waiver.

## Success Criteria

- All nine CLIs report `L0 conformant` on the pinned kit, with no waiver that is
  not written down with its reason.
- `B5` is checked, not `unverified`, on all nine.
- Every CLI's root rejection names its flag set, and every recorded verb path
  reads `enumerated` or `stated an empty set`.
- Every CLI has a `schema` verb generated from the registry its parser walks.
- A gate fails the build when any CLI regresses.

## Notes

- `acc` guidance: `node_modules/agent-cli-conformance/docs/wiki/guides/` (read
  from the pinned install, not a clone).
- House pattern: per-skill `acc.config.json`, run from the skill's folder;
  `knownFailures` is recorded debt.
