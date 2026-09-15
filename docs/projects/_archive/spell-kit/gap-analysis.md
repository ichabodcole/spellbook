# Gap Analysis: spell-kit proposal

**Date:** 2026-08-30 **Method:** independent no-stake subagent, briefed to
**execute** the proposal's claims rather than re-read them (per
[[cold-read-subagent-flushes-rats]] — the intervention is not having a stake).
**Target:** [`proposal.md`](./proposal.md) at draft revision.

> **Verification of the verifier.** The seven blocking findings were
> independently re-run before this was filed. **All confirmed.** Spot-checks
> recorded inline as ✅ **re-verified**. The remaining findings are reported as
> the agent returned them and are marked as such.

> **This document reviews the SUPERSEDED first draft, and is still live.** The
> proposal was rewritten around it rather than annotated onto it, so the
> findings are not archival: the rulings and the sprint plans cite them **by
> bare id** and sometimes argue against them. The index below is the legend.

---

## Finding index

**The letters are not section labels.** `D1` and `D3` sit under _Blocking_;
`D2`, `D4`, `D5` and `D6` under _Does-not-fit_. The **Minor** list carries no
ids at all — cite it by phrase.

| id     | In one line                                                                                    | Section      | Where it went                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------- |
| **B1** | imago's shipped `server.ts` imports its surface at runtime — 5 imports, 3 of them values       | Blocking     | ✅ blocking Q1 → **R1**; cut in Sprint 01 Phase 1b                                            |
| **B2** | three of the old Phase 2's six kit modules are client halves of daemon wire protocols          | Blocking     | ⏸ blocking Q2 → **moot, kit breadth descoped**                                                |
| **B3** | `kit/ui/` cannot render in imago; the Phase-2 order is backwards                               | Blocking     | ✅ blocking Q3 → **R3** (measurement stood, diagnosis refined — see the note under B3 itself) |
| **B4** | the K2 vocabulary evidence is inverted — `LibraryItem` is glamour's, not imago's               | Blocking     | ⏸ blocking Q4 → **moot, K2 descoped**; corrected in the proposal                              |
| **B5** | Phase 1 turns `gate-honesty.test.ts` red, and relocation makes 166 blind lines **uncounted**   | Blocking     | ✅ blocking Q5 → **R5**; built in Sprint 01 Phase 0                                           |
| **D3** | the shared-import invariant is unenforceable as stated, and over the wrong denominator         | Blocking     | ✅ blocking Q6 → **R6**, which became **two** wards                                           |
| **D1** | astrolabe is never mentioned; the pipeline plan's own outstanding ruling is skipped            | Blocking     | ✅ blocking Q7 → **R7**; astrolabe ports first, in Sprint 01 Phase 1a                         |
| **I1** | imago's test tree is unplanned — 17 `../surface/` sites across 10 of 11 files                  | Important    | R6's test split; executed in Sprint 01 Phase 1c                                               |
| **I2** | Seam C is canon with three mechanical dependents, and the `ward` skill was not invoked         | Important    | Sprint 03 Phase 5 — all three dependents and the `ward` run                                   |
| **I3** | the CPR retirement contradicts the proposal's own cross-harness scope                          | Important    | descoped — the 2 sites go back to the 21-site backlog item                                    |
| **I4** | the `useSession` row promises imago something it already has                                   | Important    | descoped with the kit's breadth                                                               |
| **I5** | nothing keeps a committed `dist/` honest; a `src/kit/` change marks no spell stale             | Important    | Sprint 02 Phase 3 extends the staleness walk to `src/kit/`                                    |
| **I6** | the proposal states no invocations, in a repo whose canon requires them                        | Important    | design-resolution's [Appendix — invocation](./design-resolution.md)                           |
| **D2** | mind-mapper is a WIP, undeclared spell — and it is the kit's entire source                     | Does-not-fit | → **RC** — facts hold; the closing inference was ruled the other way in `47238d7`             |
| **D4** | the paper probe is theatre as specified; a probe that can fail is a real component             | Does-not-fit | ✅ adopted — R3 replaces the probe with a real kit component                                  |
| **D5** | sections contradict each other                                                                 | Does-not-fit | aimed at the first draft; the rewrite removed the sections it names                           |
| **D6** | unbudgeted certain work no section owns — test rewrites, `DECLARED_BLIND`, cwd pin, `seams.md` | Does-not-fit | picked up across Sprint 01 (Phases 0 · 1a · 1c) and Sprint 03 Phase 5                         |

**`OQ<n>` below means the SUPERSEDED first draft's Open Questions** (OQ1, OQ2,
OQ4, OQ7) — the rewritten proposal has none. R3's own Open Questions are a
separate series, and `Q3` in the Minor list is the **census investigation's**
Q3, a third one again.

---

## Summary

The strategic frame — promotion rather than deduplication, imago paired with
mind-mapper for generalization pressure, the gate in front of the emission
decision — **survives and is well argued.** The execution plan does not.

Two structural breaks and one inverted fact:

1. **imago's shipped backend imports its surface source at runtime.**
   mind-mapper's does not. Phase 1 as written either breaks the published
   artifact or violates the proposal's own invariant on day one.
2. **Three of Phase 2's six kit modules are the surface halves of daemon wire
   protocols** and cannot reach imago without editing its shipped `server.ts` —
   the work the proposal puts behind the gate.
3. **`LibraryItem` is glamour's type, not imago's** — the K2 vocabulary argument
   was inverted.

---

## Claims executed

| Claim                                                                                                                             | Verdict                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Chat sidebar 1,281 LOC across 4 spells                                                                                            | ✅ exact                                                                                                                                                                                                     |
| Context sidebar 1,559 LOC across 4 spells                                                                                         | ⚠️ right number, **misleading population** — the 10 named files total 1,233; the rest is `fileIntake` (304), which the proposal assigns to **K1**. magpie's "context sidebar" is a 51-line drag/drop helper. |
| Combined 2,840 > census's 2,370 pool                                                                                              | ⚠️ arithmetic holds, **pools overlap** (Conversation 754, fileIntake 304, useSession 189 are in both)                                                                                                        |
| imago has no `tsconfig.json`                                                                                                      | ✅ — and **mind-mapper has none either**; the census's "four per-spell tsconfigs" is three                                                                                                                   |
| imago = 137 typecheck errors of 434                                                                                               | ✅ exact                                                                                                                                                                                                     |
| mind-mapper contributes zero                                                                                                      | ✅ and honestly measured — `--listFiles` confirms 111 files in the program                                                                                                                                   |
| imago is the only `sharp` user                                                                                                    | ✅                                                                                                                                                                                                           |
| "glamour/magpie/**mind-mapper** use `Bun.Image`"                                                                                  | ❌ **false** — mind-mapper has **0** `Bun.Image` refs and no image path ✅ **re-verified**                                                                                                                   |
| imago↔mind-mapper 38 lines / 2%                                                                                                   | ⚠️ **transposed** — imago↔mm is 29/1.4%; **38 is the glamour pair**                                                                                                                                          |
| imago↔magpie `useSession` 76%, `styles.css` 55%                                                                                   | ⚠️ right values, **published invocation does not reproduce them** — the census script's `length > 24` filter yields 64.5%/45.1%; the stated figures need MIN=0                                               |
| mind-mapper `ui/` = 7 primitives on `@base-ui/react`                                                                              | ⚠️ 7 files, **4** use base-ui                                                                                                                                                                                |
| imago "13 hand-rolled components"                                                                                                 | ⚠️ 13 in `components/`, **25 `.tsx` total** — `components/annotations/` adds 10 the kit has nothing for                                                                                                      |
| `house-style.md` still says "there isn't one"                                                                                     | ✅ `:361`, rule-id `:365`                                                                                                                                                                                    |
| imago has exactly 2 `${CLAUDE_PLUGIN_ROOT}` sites; 19 elsewhere                                                                   | ✅ exact                                                                                                                                                                                                     |
| mm `server.ts:92` mode resolution, `:552` dynamic import                                                                          | ✅                                                                                                                                                                                                           |
| `GroundRef` 15 / `LibraryItem` 3 in imago                                                                                         | ❌ **both wrong, one inverted** ✅ **re-verified**: `LibraryItem` imago **0**, glamour **29**; imago's type is `ContextEntry` (19); `GroundRef` has **3** source uses and is an opaque prefixed string       |
| gate blind set 4,166 / 84% HTML · ~1,600 ward lines · zero cross-spell imports · `openBrowser` 8/6 · imago 6,591 vs glamour 2,207 | ✅ all exact                                                                                                                                                                                                 |

---

## Blocking

**B1 — imago's shipped `server.ts` imports the surface at runtime.** ✅
**re-verified.** Five imports from `../surface/`: `index.html` (:35),
`optimizeImageBuffer` (:36), `types` (:50), and re-exports at :1647–1648
including the **value** export `defaultState`. `types.ts` is 494 lines and
`server.ts:25` calls it _"the single contract."_ After relocation these resolve
into `src/`, which **does not exist in the published artifact**. mind-mapper's
`server.ts`: **zero** such imports — the seam never existed in the precedent.
**glamour 5, magpie 8, astrolabe 1.** Three ways out, all restructures: move the
modules into `scripts/` (backend restructure, inverts Contract 4's direction);
duplicate them (a new lockstep mirror, in a project whose thesis is that mirrors
are the disease); or ship them via the kit's backend emission (**crosses the
gate**).

**B2 — three of six Phase-2 modules cannot reach imago without a backend
change.** `presence` (agents-count from mind-mapper's SSE tails), `activity`
(Contract 9 R4 daemon vocabulary, `stalled` daemon-synthesized), `buildInfo`
(spread at the handler in release mode). All are client halves of daemon
protocols. "imago gets co-presence signals it lacks" requires imago's shipped
`server.ts` to grow wire fields — out of scope and behind the gate.

**B3 — `kit/ui/` cannot render in imago; the Phase-2 order is backwards.** ✅
**re-verified.** mind-mapper's primitives are styled entirely in shadcn alias
tokens (`bg-accent`, `bg-popover`, `text-muted-foreground`, `border-ring`…);
imago's `styles.css` defines **none** of them. And the one shared name inverts:
`--color-accent` is `#7c3aed` (brand purple) in imago, `var(--color-edge)` (a
border grey) in mind-mapper. mind-mapper also has a full light palette and
domain tokens (`--color-canon`, `--color-thread-tier`) used directly in
`ConversationPanel.tsx:31-34`; imago has no light mode. **`kit/ui/` is unusable
until the theme reconciliation the proposal's own OQ1 calls undecided.**

> **↪ RESOLVED 2026-08-30 — the measurement stood; the diagnosis was refined.**
> The `--color-accent` values do differ exactly as reported, but they are not
> two palettes disagreeing: imago's is a **brand** token and mind-mapper's is a
> **shadcn alias** (shadcn's `accent` = subtle hover surface). It is a namespace
> collision, fixed by renaming imago's brand slot (95 sites), not by choosing a
> palette. The finding's _ordering_ conclusion — **theme must precede
> `kit/ui/`** — is adopted unchanged and is the more valuable half. See
> [R3](./design-resolution.md#r3--theming-a-base-layer-with-per-app-override).

**B4 — the vocabulary evidence is inverted.** ✅ **re-verified.** Corrected in
the proposal. Three different concepts, not one with three names; the genuine
collision is **glamour ↔ imago**, and glamour is out of scope.

**B5 — Phase 1 turns `gate-honesty.test.ts` red.** ✅ **re-verified.**
`DECLARED_BLIND` pins three imago files by exact path and line count
(`:72,:77,:82`); Phase 1 moves all three. The cell is `toEqual`. Suite is green
today (46 pass / 0 fail). **And OQ4 has the risk backwards:** `src/kit/` cannot
become a blind set — biome gates `**/*.ts(x)` repo-wide. The real effect is
worse: relocating `styles.css` (151) + `index.html` (13) does not make them
gateable (biome reads neither CSS nor HTML) — it makes them **uncounted**. 166
blind lines vanish with nothing fixed, which is the census's own phase-6 warning
turned on itself.

**D3 — the invariant is unenforceable as stated.** It is true today and false
after Phase 1, so a ward introducing it would pass at HEAD and fail on its own
branch. And `scripts/*.ts` is the wrong denominator: **10 of imago's 11 test
files** import `../surface/`, plus 10 more across glamour and magpie. A ward
scoped that way reports green over a set it never looked at —
`enumerate-roster-behaviour-never`'s exact failure mode.

**D1 — astrolabe is never mentioned.** The pipeline plan's remaining work is
_"write Seam C… and **either migrate astrolabe or formally drop it as the
reference spell**."_ This proposal delivers Seam C and a second-spell migration
but silently substitutes imago and never makes the ruling. astrolabe is the
**only** React spell for which "mechanically identical to mind-mapper" is true.

---

## Important

- **I1 — imago's test tree is unplanned.** 17 `../surface/…` import sites across
  **10 of 11** test files. mind-mapper split its tests (38 surface / 32
  backend); imago mixes surface units, a CLI test and a server integration test
  in one `tests/`. Splitting makes `house-style.md`'s
  `enumerate-roster-behaviour-never` example wrong about imago; not splitting
  ships tests with 5-deep imports into a tree the artifact lacks. Either way the
  "137 → 0" criterion shifts — 98 of the 137 are in `tests/`.
- **I2 — Seam C is scoped as "amend a heading"; it is canon with three
  mechanical dependents:** the rule-id ward, a `decay-ledger.md:80` row under an
  **injective** pairing check, and an already-drafted replacement in
  `.anthill/dev/seams.md` **Contract 3** that says explicitly _"Merge into
  one."_ The `ward` skill (trigger: "changing a house-style convention") is not
  invoked.
- **I3 — the CPR retirement contradicts the proposal's own scope**
  ("cross-harness … not a goal") and adopts the one assumption the cross-harness
  investigation said to test **before** committing. It also splits a coherent
  21-site backlog item into 2 + 19 and drops its ward.
- **I4 — the `useSession` row promises imago something it already has.** imago
  is the **top rung** of the ratchet (`wss:`, reconnect, clean-close suppression
  — all present). And the two hooks are different lifecycles: imago's owns the
  send channel and has a terminal `ended`; mind-mapper's `useProjectState` has
  **no `send` at all**, is project-scoped, and carries 404/needs-project
  branches. Shared core ≈ 15 lines.
- **I5 — nothing keeps a committed `dist/` honest.** No `build` script, no CI
  beyond release-please, and the team gate is `check && test` — no typecheck, no
  build, no freshness check. mind-mapper's staleness detector walks
  `src/<spell>/surface` only, so **a `src/kit/` change marks no spell's dist
  stale**. imago is a _declared, released_ spell; mind-mapper is not.
- **I6 — the proposal states no invocations**, in a repo whose canon requires
  them. Three of its new numbers are wrong and one is mispopulated — precisely
  what the convention exists to catch.

---

## Minor

`@source` scan roots (four spellings; moving `ui/` to `src/kit/` puts it outside
mind-mapper's scan root and Tailwind silently drops its utilities) · the
`index.html` pre-paint theme mirror, a lockstep copy of `theme.ts` the kit
cannot own · adding imago a 4th divergent `tsconfig.json` runs against the
census's Tier 3 fix, and does not itself change the 137 · `sharp` is a **root**
dep and the `withoutEnlargement` dispute is glamour-vs-magpie, both out of scope
· OQ7 is already answered by pipeline §4 · imago has no `acc.config.json` and
would be the first kit-consuming spell to face the census's Q3 #4 · pipeline §3
(T3 spells carry isolated deps) conflicts with a root-dep kit · house-style's
`✅ 63` test count now returns 64.

---

## Does-not-fit

- **D2 — mind-mapper is a WIP, undeclared spell, and it is the kit's entire
  source.** Pinned by `roster-drift.test.ts`, no `SKILL.md`, in none of the four
  listings. What shipped in v2.2.0 was an undeclared WIP spell's dist riding
  along in the subtree — **nobody consumed it**, so "validated through a real
  distribution channel" is weaker than stated, and **imago would be the first
  declared, in-use spell whose surface leaves the shipped tree.** The proposal
  files mind-mapper's missing `SKILL.md` under "Future Considerations," as if
  cosmetic; it is the thing that makes the donor not a spell.
  - **→ Ruled: [RC](./design-resolution.md). Does not block.** The facts are
    verified, but **Cole ruled the undeclared state intentional and correct on
    2026-08-10** (`47238d7`) — undeclared _because_ unfinished, "nothing to
    repair." And both quoted strings were **deleted from `proposal.md` in the
    rewrite**, so two of the three complaints have no target. What survived was
    the word _"proved."_ RC also carries forward the packaging question that
    ruling left open, which this project generalizes.
- **D4 — the paper probe is theatre as specified.** You can always write an
  interface. The four chat implementations are four _architectures_: glamour is
  presentational (6 props); imago and magpie take `(state, send)` — the whole
  app state and the raw wire; mind-mapper takes 14 domain-typed props. On paper
  you resolve that by picking one. It cannot test the three things that will
  actually break: whether `bg-accent` means the same colour (it does not),
  whether the Tailwind scan reaches the kit (it does not), or whether a
  `(state, send)` surface and a 14-domain-prop surface can share a component
  without one changing its state architecture. **A probe that can fail:** make
  `MessageBubble` — real in both glamour (35 lines) and mind-mapper (194) — one
  implementation serving one real consumer, built and run.
- **D5 — sections contradict each other.** The Phase-2 table commits
  `kit/theme/` and `useSession` as "reconciled" while OQ1/OQ2 ask whether
  reconciliation is possible. "Deliberately surface-only" vs B1 and B2. In-scope
  vs out-of-scope on cross-harness. "K2 is out of scope" vs a Problem Statement
  led by a K2 LOC table, 19% of which is K1 scope.
- **D6 — unbudgeted certain work no section owns:** 17 test import rewrites ·
  re-declaring `DECLARED_BLIND` · `.gitignore` + a second committed bundle in
  the tsc program · Contract 5's cwd-pin (`SURFACE_CWD`/`daemonCwd()` — the
  proposal names only `server.ts`) · `.anthill/dev/seams.md` amendments, whose
  own write-trigger is _"whoever moves a boundary updates this file and its
  proof — in the same change"_ · the `ward` and `land` skill runs.

---

## Recommendations

**Answer before proceeding:** the seven blocking questions, reproduced in the
proposal's status banner.

**Strongly recommended changes:**

1. **Reorder Phase 1 to lead with the seam, not the move.** Resolve imago's
   backend↔surface coupling first; relocation is mechanical afterwards.
2. **Consider astrolabe first** as the genuine "mechanically identical" repeat,
   then imago as the hard case with its eyes open. This also discharges the
   pipeline plan's outstanding ruling.
3. **Replace the paper probe with one real shared component**, built and run.
4. **Unbundle Phase 1 step 5** — imago's tsconfig belongs with the census's Tier
   3 fix; the 137 errors are independent of the port.
5. **Move the CPR retirement out** — take the whole 21-site backlog item with
   its ward, or none of it.
6. **Add an appendix of invocations**, and fix the census appendix's `> 24`
   filter, which does not reproduce its own published percentages.
7. **Add the emission matrix** the cross-harness investigation asked for.

**Correctly excluded, no action:** the CLI/daemon kit behind the gate ·
magpie/glamour adoption · digestify/bounty/grapevine · the repo-wide typecheck
gate · K2 itself · cross-harness distribution as a goal.

---

**Related:** [`proposal.md`](./proposal.md) ·
[shared code and the build boundary](../../investigations/2026-08-29-shared-code-and-the-build-boundary.md)
·
[cross-harness spell distribution](../../investigations/2026-08-30-cross-harness-spell-distribution.md)
· [`spell-surface-pipeline` plan](../spell-surface-pipeline/plan.md)
