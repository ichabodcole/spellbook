# `canon-ledger-ward.ts` guards the canon and is run by nothing

**Filed:** 2026-09-02 · **Status:** open · **Found by:** the non-author audit of
spell-kit

`scripts/instruments/canon-ledger-ward.ts` checks that every `house-style.md`
rule pairs injectively with a `decay-ledger.md` row. It is **not** a `.test.ts`,
so `bun test` never collects it — and it is not in `package.json`, not in
`.github/workflows/ci.yml`, and not in the gate.

**The exclusion is deliberate and the reason is good:** a `.test.ts` is
collected the moment it exists, so an in-progress ward reds a peer's gate.
Recorded in `.anthill/dev/thoth.md`.

**The problem is that "run it by hand" has no owner and no occasion.** Sprint 03
rewrote the canon this ward guards, _added CI_, and did not add this.

⚠ **It has already passed over a real defect** (2026-09-01): the lead changed a
rule-id, the matching ledger row went stale, and the ward reported **17/17, zero
orphans** — because it pairs on fuzzy token overlap and the new heading still
shared the word `build` with the dead row. **A pairing check guards THAT a row
exists, never THAT it agrees.** So the fix is two-sided: give it a trigger, and
decide whether pairing is the property worth checking.

## Candidate fixes

- add it to `bun run gate` after the suite (it is fast, and the gate already
  builds first)
- or add it to `ci.yml` as a step beside `dist-check`
- or accept hand-running it, and name **who** and **when** in the `ward` skill —
  the same repair Contract 3's pending marker just needed
