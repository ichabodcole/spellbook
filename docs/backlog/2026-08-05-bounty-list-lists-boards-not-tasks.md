# Bounty: `list` enumerates boards, not tasks — the empty result reads as missing cards

**Added:** 2026-08-05 · **Tracks:** GitHub issue
[#79](https://github.com/ichabodcole/spellbook/issues/79)

`bounty list` lists **boards**, not tasks. `list` is the verb a caller reaches
for when they want to see what's on the board — the verb is right, the noun is a
different one than the caller has in mind.

The failure mode is a **plausible zero**. After seeding six cards, a caller ran
`bounty list`, got zero hits, concluded the cards had not been created, and was
one message away from **filing a false defect against a tool that was working
perfectly.** The cards were fine; the board had gone 46 → 52.

Nothing errors, nothing warns, and **the zero is indistinguishable from a real
zero** — so it confirms the wrong hypothesis instead of raising a question.

## Acceptance Criteria

Either (pick one, don't do both):

- [ ] **Rename to say what it enumerates** — `bounty boards` — leaving `list`
      free to mean tasks (or unclaimed).
- [ ] **Have the output name its own noun** — _"2 boards"_ rather than a bare
      empty set — so a caller expecting tasks can tell the question they asked
      wasn't the question that was answered.

Fold whichever lands into the `SKILL.md` accuracy pass tracked in
[`2026-07-09-bounty-grapevine-skill-review.md`](./2026-07-09-bounty-grapevine-skill-review.md).

## References

- `plugins/spellbook/skills/bounty/scripts/cli.ts` — `cmdList`
- Context: anthill team session 9; same session filed the `state --full` pipe
  truncation ([#78](https://github.com/ichabodcole/spellbook/issues/78))
