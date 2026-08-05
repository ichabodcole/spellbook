# Bounty: overrun-poke false-fires on session-length cards (card-model gap)

**Added:** 2026-08-05 · **Tracks:** GitHub issue
[#76](https://github.com/ichabodcole/spellbook/issues/76)

A card's `--size S|M|L` sets a heartbeat estimate (~5/10/20 min), and a `doing`
card that overruns pokes its owner. That's right for **build** cards — discrete
work with a completion. It **false-fires** on **session-length** cards: a
coordinate/expediter or verify seat holds one card that's engaged across the
_whole session_ and never completes within any S/M/L budget, so its poke fires
repeatedly while the seat is working correctly.

**The cost isn't the noise — it's that the channel gets discredited.** Observed
in a multi-seat session: both the coordinate and verify seats were poked all
session while productively engaged, and a lead who receives alerts he acts on
none of ends up discarding them unread. An alert that is correct but meaningless
trains its audience to ignore the channel it arrives on, which is worse than the
gap it was built for.

## Suggested shape (either)

- An **ongoing / no-estimate card type** (`--size none`) that opts a card out of
  the overrun-poke — for standing, session-length lanes.
- A **per-card poke-mute** flag.

## Alert on evidence, not elapsed time

The deeper fix, worth weighing before shipping either flag: poke on **evidence
of a stall** — no commits by this owner while holding an in-progress card, no
vine post — rather than on elapsed minutes. That makes the signal meaningful for
build _and_ session cards, and removes the need for the human to classify cards
correctly up front. See also the size-badge work in
[`2026-07-16-bounty-board-ui-polish.md`](./2026-07-16-bounty-board-ui-polish.md)
— if sizing stays invisible on the board, mis-sized cards can't be corrected
from the surface anyway.

## Acceptance Criteria

- [ ] A session-length card can be held all session without generating
      overrun-pokes.
- [ ] Build cards still get their poke — the fix doesn't disarm the feature.

**Workaround in place:** the coordinate seat's playbook treats a poke as a
_movement-check prompt_ (re-check git + board + last vine post), never a stall
signal in itself — only a card both overrun **and** truly silent is real. That's
a discipline patch for a card-model gap.

## References

- `plugins/spellbook/skills/bounty/scripts/` — heartbeat / overrun-poke path,
  `add`/`update --size`, `--expect`
- Context: multi-seat anthill session (typed-links), filed via finalize-session
  feedback aggregation
