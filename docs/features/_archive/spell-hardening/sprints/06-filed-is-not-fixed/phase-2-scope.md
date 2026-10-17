---
type: artifact
title: "Sprint 06 phase 2: scope, from two no-stake reads"
description:
  What phase 2 of sprint 06 is after phase 1 landed, measured on develop
  6128a9b6 by two read-only subagents: whether clause (ii)'s rule set can be
  enumerated, and the state of every other phase-2 candidate.
status: draft
generated: { by: claude-opus-5-5, at: 2026-09-27 }
---

# Sprint 06 phase 2: scope

Measured on `develop` at `6128a9b6` by two read-only subagents with no stake in
the plan, on 2026-09-27, after phase 1 landed (`b12c07bc`). References below are
pinned to `6128a9b6`; read them with `git show 6128a9b6:<path>`.

## Falsifier 3 does not fire for house-style

The plan warned that `house-style.md`'s rules "were enumerated four different
ways in one day, with three of them wrong", so clause (ii) might be a discovery
round. That count predates sprint 04's `2a56e46`, which gave every rule a
`<!-- rule-id: … -->` marker gated by `grimoire/rule-id.test.ts`. Three
independent predicates now agree with the ids: **25** rule ids, 25 `###`/`####`
headings, 25 `Repeal when` lines, and the 21 `###` rules pair exactly with the
21 decay-ledger rows.

It **does** fire for every other canon source: `grimoire/outcome-contract.md`
has 0 rule ids and counts 2, 3 or 8 depending on the predicate;
`.anthill/dev/seams.md` has 21 enumerable contracts but 17 unnumbered
amendments; `AGENTS.md` and `.anthill/principles.md` are prose.

**Rule ↔ check today:** no rule names a check and no ward cites a rule id. About
5–7 real links exist by reading. Of the 25 rules, about 13 cannot have a
mechanical check (reader's context, naming, start-minimal, …); of the 26
`grimoire/*.test.ts` wards, about 18 enforce an authority outside house-style
(seams Contract 21, sprint-05 rows, D15, D43, R6, T37, Cole rulings by date).

**The build is small** (25 rule annotations, 26 ward headers, one ward of about
120 lines, `enforced-by: none — <reason>` as a first-class value). **The cost is
the canon ruling**: which documents count, and whether "none (intent)" is an
acceptable end state.

## The other candidates

| #             | state on `6128a9b6`                                                                                                                                                                                                                            | proposal                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **D6**        | All four wards exist and pass; cells roster-drift 17, gate-honesty 6 (plan: 5), terminator-invariant 5 (plan: 4), strict-parse-invariant 3. terminator and strict-parse were rewritten by the acc cycle                                        | IN; calibrate terminator-invariant only after its rewrite (below)                   |
| **`c1` ward** | The population is now **1 caller-facing parser** (the kit registry), not 7/16. terminator-invariant's header still says "nothing warns" and pins "6 of 7 UNVERIFIED", false since `dccd2cb7`; it stays green because it exercises `node:util`  | IN, merged with D6: rewrite the ward to assert the registry warns over its adopters |
| **D4**        | **Measured zero.** 571 `?.` links in 380 files; 12 value-position reads touch a nullable name; by hand, 0 erase a present-and-null wire field                                                                                                  | close as zero                                                                       |
| **D3**        | Unblocked by D4. No `useOptionalChain` exemption exists; the canon's cited survivor (`bounty/scripts/template.html:951`) is gone (the surface is now `.tsx`, inside biome)                                                                     | IN as a canon edit: no exemption                                                    |
| **D5**        | **Resolved** by D52 (2026-09-09): digestify's 124/130 are session outcomes, outside the failure taxonomy. `outcome-contract.md:292-295` still says "to be carded"                                                                              | IN as a doc fix citing D52                                                          |
| **Row 3**     | **Failure half built and gated** (`EXIT_FOR` in `src/kit/wire/errors.ts:55-58`, acc, the golden). House-style's "0 · 2 · 124 · 130, alike" is false: every spell emits 5, some 1 and 6, conjurations have no 130, `bounty join` idles out at 0 | IN as the rule amendment; the session-ending ward stays first to drop               |
| **D2**        | The ledger now states its own gap, so clause (i) is met; `outcome-contract.md` has no rule ids to key a row on                                                                                                                                 | MERGE with clause (ii); only if outcome-contract is in canon scope                  |
| **D1**        | No envelope names its board (`bounty add` → `{ok,added,valuesIgnored}`). Building it is a wire change across nine spells                                                                                                                       | OUT (or mint the canon only)                                                        |

## A canon-vs-code mismatch phase 1 created

`outcome-contract.md` § "The refusal text we owe anthill" prescribes a
`valuesIgnored`-shaped **envelope** entry for Boundary 3's measured instance
(`add -- hello --session-key K1`). Phase 1 shipped a **stderr** `# warning:`
line from the registry instead, and the envelope still says
`valuesIgnored:null`. One of them has to be amended; that is the team's call on
the wire, and clause (ii) is the mechanism that should have caught it.

## Plan premises now wrong

1. "7 entry points by path / 16 by behaviour" for `c1`: now 1.
2. D6 cell counts for gate-honesty and terminator-invariant.
3. Row 3 as "the only unbuilt behavioural row": its failure half is built.
4. D5 "to be carded": ruled by D52.
5. D2's item says outcome-contract has gated rule ids: it has none.

## Triage items filed today, placed

`bounty-open-restore-missing-exits-zero` belongs with row 3. The rest
(`init --stdin-tasks` wipe, `add --stdin` drops the positional, astrolabe
`status` spawns a daemon, the two-answers tail) are fix-queue work, not phase 2.
`astrolabe-close-stale-port-internal-error` is covered by phase 1's `close` fix.
