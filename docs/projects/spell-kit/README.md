# Spell Kit — project ledger

**Status:** Planned · **Created:** 2026-08-30 · **Sprints:** 3 planned, 0 closed

A dev platform for sharing code between spells — surface, backend, and styling —
proven by the smallest thing that proves each. **The deliverable is the
capability, not the extraction.**

| #                                                   | Sprint                   | Delivers                                                           | Status  |
| --------------------------------------------------- | ------------------------ | ------------------------------------------------------------------ | ------- |
| [01](./sprints/01-the-seam-before-the-move/plan.md) | The seam before the move | astrolabe + imago build; the instruments that stay honest about it | Planned |
| [02](./sprints/02-the-boring-module/plan.md)        | The boring module        | code shared on both sides — **and the emission ruling**            | Planned |
| [03](./sprints/03-what-fails-silently/plan.md)      | What fails silently      | shared styling with per-app override; Seam C canon                 | Planned |

## Documents

| Document                                       | What it is                                                                                                                                                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [proposal.md](./proposal.md)                   | The arc — four capability slices, why, and what is deliberately not in scope                                                                                                                                                                                                          |
| [design-resolution.md](./design-resolution.md) | **The rulings.** R1 · R3 · R5 · R6 · R7 · RB · RC. Build against these — **the sprint plans apply them and do not restate them.** Corrections are folded into the section they correct, marked ⚠; nothing is amended further down.                                                    |
| [gap-analysis.md](./gap-analysis.md)           | The adversarial read that reshaped the proposal. **Not archival — an active dependency:** the rulings cite its findings by bare id (`B1`, `D4`, `I5`…) and argue against it. Its [finding index](./gap-analysis.md#finding-index) is the legend — read it whenever a bare id appears. |

## Why three sprints

Each delivers **one capability class** and ends at a point where something can
be wrapped up and learned from before the next begins. The order is not
arbitrary — **each sprint's ruling is better made knowing what the previous one
found:**

- **01 → 02.** The emission ruling should be made knowing what the artifact
  actually needed once two spells really shipped from `dist/`.
- **02 → 03.** Canon lands last **because Seam C's wording depends on the
  emission ruling.** Writing it earlier means amending `house-style.md` twice,
  and each amendment drags `rule-id.test.ts`, the `decay-ledger.md:80` pairing,
  and a `ward` run with it. _(The gap analysis flagged this as an undeclared
  dependency between phases; the sprint boundary is what resolves it.)_

## Vocabulary — read this before the sprint plans

Every term below is ordinary English and means something narrower here. The
third column is the misreading to avoid.

| Term           | Here                                                                                                                                                                                      | Not                                                                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`shared/`**  | two-sided within **ONE spell** — its daemon and its surface. **Never across spells.**                                                                                                     | the place cross-spell code goes. That is `src/kit/`. ⚠ **The likeliest misread in this project**, since its one-line description is "sharing code between spells." |
| **emission**   | how a shared **backend** module physically reaches a shipped skill folder that never ran `install`                                                                                        | compiler or bundler output                                                                                                                                         |
| **the gate**   | the CI check — `bun run check && bun test`                                                                                                                                                | also **the emission decision** ("does not open the gate"), and a filename prefix (`gate-blind-set.ts`). Three senses.                                              |
| **seam**       | a spell's backend↔surface coupling — Sprint 01's subject                                                                                                                                  | also `.anthill/dev/seams.md`'s numbered **Contracts**, and **"Seam C"**, which just means _amend `house-style.md`_                                                 |
| **ward**       | a check that fails when an invariant breaks                                                                                                                                               | also a repo **skill** named `ward`. Distinct from an **instrument**, which reports but does not gate.                                                              |
| **pinned**     | a declared inventory that fails until a human re-declares it                                                                                                                              | an allowlist, or a version pin. Explicitly **not** an allowlist.                                                                                                   |
| **board**      | a spell's rendered surface in a browser                                                                                                                                                   | the bounty board                                                                                                                                                   |
| **spell**      | one directory under `plugins/spellbook/skills/`                                                                                                                                           | —                                                                                                                                                                  |
| **the drive**  | a cold agent exercising a CLI through its interface alone                                                                                                                                 | a disk                                                                                                                                                             |
| **the census** | the duplication measurement in [the 2026-08-29 investigation](../../investigations/2026-08-29-shared-code-and-the-build-boundary.md); its **Tier 3** is the per-spell `tsconfig.json` fix | —                                                                                                                                                                  |
| **local-sim**  | copy a skill folder somewhere with no `node_modules` up-tree and run it — the only check that simulates a real install                                                                    | —                                                                                                                                                                  |
| **acc**        | `agent-cli-conformance`, the external CLI-contract checker                                                                                                                                | —                                                                                                                                                                  |
| **K2**         | the composed app patterns — chat sidebar, context sidebar. **The point of the project, and out of scope.** K0 = primitives, K1 = hooks/utilities.                                         | —                                                                                                                                                                  |
| **RB**, **RC** | rulings, lettered not numbered because they were not among the seven blocking questions                                                                                                   | —                                                                                                                                                                  |

## The numbering, in one table

Nine schemes coexist and several reuse small integers. This is the crosswalk.

| Slice | Capability                | Phase        | Sprint | Ruling |
| ----- | ------------------------- | ------------ | ------ | ------ |
| —     | instruments and wards     | 0            | 01     | R5, R6 |
| 1     | both spells build         | 1a · 1b · 1c | 01     | R1, R7 |
| 2     | shared backend code       | 2            | 02     | RB     |
| 3     | shared surface code       | 3            | 02     | —      |
| 4     | shared styling + override | 4            | 03     | R3     |
| —     | canon (Seam C)            | 5            | 03     | —      |

⚠ **Do not confuse:** Phase 1b · Ward 1b · Contract 1 · L1 · Slice 1. Same
digits, five different schemes.

## Standing rules for every sprint

- **Prefer the most boring shared module available, never the most valuable
  one.** "Amount of code shared" is an explicit non-criterion.
- **If a task turns into abstraction design, bank the ruling and narrow the
  proof.** That work is a later project.
- **mind-mapper stays at zero typecheck errors and zero new test failures.** It
  is the largest spell, it is currently clean, and every sprint touches it.
- **Read the ⛔ blocks before you trust a green run.** Every phase, and every
  sprint, ends with **⛔ What this phase's / sprint's gate cannot see** — a
  per-phase list of what a passing `bun test` does **not** prove. They are the
  densest content in these plans, not footers: the local-sim, the built-CSS
  assertion and the by-hand `canon-ledger-ward.ts` run are all named there and
  nowhere else.

## Known live defects this project must not inherit

| Item                                                                                                      | Bearing                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [imago's daemon cannot start offline](../../backlog/2026-08-30-imago-daemon-cannot-start-offline.md)      | **Fixed 2026-08-31 (daedalus); the swap is landed, proof 3 is not.** `Bun.Image` is a behaviourally equivalent drop-in — **NOT byte-identical**, that claim was falsified on a 10-input sha256 corpus. Booting offline still leaves three non-fatal bundler errors; serving from `dist/` closes those. |
| [magpie hand-rolls scale math](../../backlog/2026-08-30-magpie-hand-rolls-scale-math-it-does-not-need.md) | Not in scope; same root cause, filed so the false comment does not spread.                                                                                                                                                                                                                             |
| [stale-dist fires unconditionally](../../backlog/2026-08-10-stale-dist-fires-unconditionally.md)          | The `STALE DIST` warning is an **mtime false positive**. Do not act on it.                                                                                                                                                                                                                             |
| [biome already reads CSS and HTML](../../backlog/2026-08-30-biome-already-reads-css-and-html.md)          | Would shrink the blind set to ~153 lines (Python + TOML). **Sprint 01 does not wait on it** — note the denominator moves: 4,166 today, **4,442** once Phase 0 adds the second root.                                                                                                                    |

## Carried over, and Cole's to rule

| Question                                                                                                                                                                           | Why it sits here                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **What does a consumer receive, per spell, once built surfaces are the norm?** `spellbook-v2.2.0` already ships `mind-mapper/dist/` (~54k lines of JS + CSS) that nobody consumes. | Open since **2026-08-10**, deliberately left unruled by [that backlog item](../../backlog/2026-08-10-mind-mapper-is-undeclared-and-shipped.md) as "a packaging question, not a documentation one." **Spell-kit generalizes it** — Slice 1 commits imago's `dist/` too. It is product and cost (download size; a daemon nobody asked for), so it is Cole's. **Sprints 01–03 do not wait on it:** committing `dist/` matches what the tree already does. See [RC](./design-resolution.md). |

---

**Related:** [`spell-surface-pipeline`](../spell-surface-pipeline/proposal.md) —
the standard this ratchets; its [plan](../spell-surface-pipeline/plan.md) has no
remaining work as of R7.

---

_Reconciled 2026-08-31 @ `9b6d8e5` — **SPRINT 01 COMPLETE**, 10 commits on
`feat/spell-kit-sprint-01`. Live-defects table: "imago's daemon cannot start
offline" — **FIXED** (`e7b2ed2`), and its `Bun.Image is byte-identical` note
**FALSIFIED** and corrected. "magpie hand-rolls scale math" — **OPEN**,
untouched as scoped. "stale-dist fires unconditionally" — **OPEN**, and its
mtime false positive fired on schedule all sprint as predicted. "biome already
reads CSS and HTML" — **OPEN**; the blind set is 19 / 4,442 with the second root
live. Vocabulary and numbering tables: **HELD**, no term changed meaning.
**Three new backlog items** filed from the verification drives: relocated spells
diverging on surface hygiene, imago lowercasing context-library names, and a
second accessibility instance. **Carried to Cole, still unruled:** what a
consumer receives per spell once built surfaces are the norm — now materially
larger, since two spells ship committed `dist/` rather than one._
