# Bounty: board UI polish pass (size badges + wordmark)

**Added:** 2026-07-16 · **Tracks:** GitHub issues
[#72](https://github.com/ichabodcole/spellbook/issues/72) and
[#11](https://github.com/ichabodcole/spellbook/issues/11)

Two small board-surface items bundled for one pass:

## Acceptance Criteria

- [ ] **Size badge on cards (#72).** Tasks carry `size` (S/M/L → 5/10/20-min
      heartbeat estimates) but the board renders no indication — the human can't
      sanity-check sizing without reading CLI state JSON. Add an `S`/`M`/`L`
      chip on the card (hover shows the `--expect` minutes), and an edit
      affordance in the card's inline-edit flow so re-sizing when scope grows
      isn't CLI-only. (Surfaced live: operator repo doc-linking session,
      2026-07-16 — sizing was invisible exactly when the human wanted to check
      it.)
- [ ] **Wordmark (#11).** The surface still renders "Tuskboard" — regenerate as
      Bounty.
- [ ] Close #72 and #11.

## Notes

Both are surface-only. **Amended 2026-09-06 by the bounty conversion:** the
surface is no longer `scripts/template.html` — it is React at
`src/bounty/surface/`, built into a committed `dist/`, and **the Alpine mirror
this note told you to mind no longer exists.** The predicates live once in
`plugins/spellbook/skills/bounty/shared/predicates.ts` and the board imports
them, so a change that needs a server-side field is now one edit, not two kept
in step. The fields this item wants (`size`, `expect`) already exist; it is
still pure presentation, and it is now a `TaskCard.tsx` change plus a cell
beside it. Still small enough for a single gopher-grade lane.
