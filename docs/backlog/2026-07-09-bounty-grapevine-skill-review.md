# Review bounty + grapevine SKILL.md for accuracy and usefulness

**Added:** 2026-07-09

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

- [ ] **Accurate** — every verb/flag/behavior described still exists and behaves
      as stated; recent additions are covered (bounty `--session-key`/idempotent
      `open` — #69; grapevine `tail --last` + the `full`/`truncation_hint`
      recovery pointer — #67/#68). No references to removed/renamed behavior.
- [ ] **Useful, not exhaustive** — cut or tighten guidance that's redundant with
      the CLI `help`, over-explains edge cases, or reads as changelog rather
      than how-to. Keep the trigger phrases, the mental model, and the "when to
      use / when not to." Prefer one clear path over enumerating every knob.
- [ ] **Trigger accuracy** — the `description` frontmatter still fires on the
      right phrases and doesn't over/under-trigger.
- [ ] **Consistency** — house-style alignment between the two (they share the
      daemon+cli pattern); run the `ward` checklist if conventions changed.

## Notes

- Good candidate to run through the **anthill team** (thoth owns canon/skill
  wording) rather than solo — see [[prefer-anthill-team-for-implementation]].
- This is a doc/accuracy pass, not a feature change — no daemon/CLI edits
  expected unless the review surfaces a doc↔code mismatch that's actually a bug.

## References

- `plugins/spellbook/skills/bounty/SKILL.md`
- `plugins/spellbook/skills/grapevine/SKILL.md`
- Related ritual: the planned periodic spell grooming sweep (spell health /
  modernization) — this is a targeted instance for the two highest-use spells.
