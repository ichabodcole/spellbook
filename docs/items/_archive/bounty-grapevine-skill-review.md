---
type: item
title: "Review bounty + grapevine SKILL.md for accuracy and usefulness"
status: stable
description:
  Review bounty and grapevine skills for integration completeness and
  correctness
lifecycle: done
id: 019f4ac0-85d8-7803-82b4-b9dcecee4e52
kind: task
generated: { by: unknown, at: 2026-07-09 }
priority: medium
cycle: 2026-10-release-6
released_in: 6.0.0
---

# Review bounty + grapevine SKILL.md for accuracy and usefulness

Bounty and grapevine are the **most-used spells**, so their `SKILL.md` docs
carry the most weight — and drift the most as the daemons/CLIs evolve. Do a
focused review pass over both to make sure each skill is **accurate** (matches
what the code actually does today) and **useful** (an agent can act from it),
but **not overly exhaustive** — trim guidance that's stale, redundant, or more
detail than an agent needs to drive the spell well. Accuracy + signal, not
completeness.

The two skills have grown feature-by-feature (session pinning + caller-owned
keys on bounty; tail catch-up, truncation hints, presence/lurk on grapevine), so
the docs likely have accreted layers worth consolidating.

## What to check (per skill)

- [x] **Accurate** — every verb/flag/behavior described still exists and behaves
      as stated; recent additions are covered (bounty `--session-key`/idempotent
      `open` — #69; grapevine `tail --last` + the `full`/`truncation_hint`
      recovery pointer — #67/#68). No references to removed/renamed behavior.
- [x] **Useful, not exhaustive** — cut or tighten guidance that's redundant with
      the CLI `help`, over-explains edge cases, or reads as changelog rather
      than how-to. Keep the trigger phrases, the mental model, and the "when to
      use / when not to." Prefer one clear path over enumerating every knob.
- [x] **Trigger accuracy** — the `description` frontmatter still fires on the
      right phrases and doesn't over/under-trigger.
- [x] **Consistency** — house-style alignment between the two (they share the
      daemon+cli pattern); run the `ward` checklist if conventions changed.

## Notes

- Good candidate to run through the **anthill team** (thoth owns canon/skill
  wording) rather than solo — see [[prefer-anthill-team-for-implementation]].
- This is a doc/accuracy pass, not a feature change — no daemon/CLI edits
  expected unless the review surfaces a doc↔code mismatch that's actually a bug.

## Done and verified

`7783df74` (bounty, 1151 → 525 lines) and `738e2702` (grapevine, 863 → 406
lines). Every verb, flag and refusal the two SKILLs describe was run against the
built CLIs on a scratch `HOME`/`TMPDIR`. The wrong claims were: bounty's
`open --port/--host/--id` (the CLI refuses them), bounty's idle default (7200 s,
not 30 min), and grapevine's "`roll` releases a hold" (it refuses while held).
The cuts are changelog banners and notes, the snapshot-ownership essay, and
sections that repeated each other. The shared tail rule is unchanged word for
word, and every caller-facing flag is still named
(`grimoire/flag-invariant.test.ts`, `grimoire/tail-rule-parity.test.ts` and
`grimoire/shipped-skill-references.test.ts` are green).

Not ticked: **trigger accuracy**. Both descriptions were read and lightly
tightened (bounty adds "a list the user only needs to read" to its don'ts;
grapevine adds "let me watch the agents talk"), but nothing measured whether
they fire. The ward checklist's fresh-agent re-run and decay-ledger check were
not done either. Code gaps found along the way go to the lead for filing; none
were fixed here.

## References

- `plugins/spellbook/skills/bounty/SKILL.md`
- `plugins/spellbook/skills/grapevine/SKILL.md`
- Related ritual: the planned periodic spell grooming sweep (spell health /
  modernization) — this is a targeted instance for the two highest-use spells.

## Trigger check (lead, 2026-10-25)

The verifier wrote 12 phrases per spell, 6 that should fire and 6 that should
not. Grapevine covered 6 of 12 (missing disposition and daemon operation) and
bounty 8 of 12 (missing restore; GitHub project boards and the `docs/items`
board not excluded). The fix round (`d75edd72`, `44ff5e61`) added the missing
phrases and exclusions. Not measured against a live router.
