---
date: 2026-05-29
spell: inscribe + ward (repo-dev authoring skills, not a shipped spell)
spell_version: pre-migration scaffold
agent:
  general-purpose subagent, cold (no session context, no methodology jargon
  supplied)
task: cold-read review — "help me create a new tool in this repo"
---

# Fresh-Agent Findings — inscribe + ward (2026-05-29)

The first dogfood of the fresh-agent methodology, run on the very skills that
describe it.

## Setup

A cold subagent, given only the trigger ("help me create a new tool here"),
pointed at `inscribe` + `ward`, told to follow references naturally and report
cold-read friction. No session context; no methodology vocabulary supplied.

## Headline

Both skills are **written for the post-migration repo.** They repeatedly say
"clone an existing spell," but `plugins/spellbook/skills/` holds only a README
(spells not migrated yet). The single most-repeated operational instruction
dead-ends. This independently reproduces the over-seeding critique — the skills
reference a world one migration ahead of the one a reader stands in.

## Real bugs (migration-independent — fixable now)

- **"the wand" is undefined load-bearing jargon.** Used in `inscribe`,
  `house-style.md`, and `trigger-registry.md` as a settled noun central to the
  naming rationale, but defined only in an unbuilt fragment. A cold reader can't
  resolve it.
- **The Bun-gotchas reference loops.** `inscribe` → `scaffold/README` → "read
  house-style" → house-style "see `scaffold/README` for specifics" → scaffold
  "not yet written." Never lands on the actual gotchas.
- **`inscribe` is over-specified.** The naming-is-solidification philosophy is
  stated 3–4× (intro, phase 4, house-style, registry). Violates its own "Start
  minimal; subtract before you test" rule.
- **`inscribe` is under-specified on operations.** No link to the spell
  file-anatomy (it lives in `skills/README.md`, unlinked); no test example. The
  include/exclude calculus is backwards — keeps reachable philosophy, omits the
  needed-and-unreachable.
- **`ward` version contradictions:** (a) "don't put a version in
  marketplace.json," but marketplace.json _has_ `metadata.version: 1.0.0` (the
  marketplace's own version ≠ a plugin entry — the rule is imprecise); (b)
  checklist says hand-edit plugin.json version, but release-please now syncs it
  from conventional commits — contradictory; (c) plugin.json `0.1.0` vs
  marketplace `metadata.version 1.0.0`, unexplained.
- **`ward` smoke-test is grapevine-specific** — a worked example presented as
  general guidance.
- **`ward` grep template** uses `--include=*.md`, which fails under zsh.

## Migration-ahead (expected; resolve when spells migrate)

clone-an-empty-folder · drift-check paradox (empty roster vs 4-row listings) ·
"shipped" status while the folder is empty · no test harness to model.

## The questions (the gold — verbatim highlights)

"what is the wand?" · "which spells? where?" · "where is the agent-surface-bun
recipe from this repo?" · "do I hand-bump plugin.json or does release-please?" ·
"is marketplace.json already violating its own rule?" · "what files go in a
spell folder?"

## Genuinely good (keep)

The conceptual arc (problem → coalescence → harden), `ward`'s change-type
checklists, the fresh-agent README + decay-ledger, and the name/invocation
distinction.

## Disposition

| Finding                       | Route                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------- |
| "wand" undefined              | fix now — one-line gloss + pointer at first use                              |
| gotchas reference loop        | fix now — one terminal source (recipe, marked external-for-now)              |
| `inscribe` over-spec          | fix now — the subtraction pass (this is the prescribed response)             |
| `inscribe` missing anatomy    | fix now — link `skills/README.md`                                            |
| `ward` version contradictions | fix now — marketplace-metadata vs plugin-entry; release-please owns the bump |
| `ward` grapevine smoke-test   | generalize (now or at migration)                                             |
| `ward` grep zsh failure       | fix now — drop `--include`, make zsh-safe                                    |
| migration-ahead items         | accept; resolve when spells migrate                                          |

## Applied (2026-05-29)

The "fix now" rows are done: `inscribe` subtraction pass (cut the repeated
philosophy + meta-commentary), "wand" glossed as a planned CLI + pointer at each
first use (`inscribe`, `house-style`, `trigger-registry`), Bun-gotchas loop
broken (terminal source is the recipe, not a cycle through scaffold), spell
file-anatomy linked from `inscribe`, `ward` version section rewritten
(release-please owns the bump; marketplace `metadata.version` vs plugin-entry
clarified), `ward` smoke-test generalized off grapevine, zsh grep fixed. The
migration-ahead rows are accepted as-is and resolve when the spells land.

## Meta (decay signal)

The methodology worked: a cold agent reproduced the over-seeding critique and
found real bugs (wand, loop, version) the authors missed. Reinforces "Start
minimal; subtract before you test" and "Architect for the reader's context." The
_questions_ were the gold, as predicted.
