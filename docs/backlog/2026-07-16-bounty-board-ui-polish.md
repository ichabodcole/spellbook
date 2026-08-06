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

Both are surface-only (template.html / Alpine mirror). Mind the lockstep-mirror
convention: if the size badge needs a server-side field it already exists
(`size`, `expect`) — this should be pure presentation. Small enough for a single
gopher-grade lane; could ride along any other bounty session.
