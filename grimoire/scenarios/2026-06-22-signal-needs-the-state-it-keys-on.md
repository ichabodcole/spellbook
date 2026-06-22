---
date: 2026-06-22
spell: bounty
rule: house-style.md → "Drive a conjuration through a daemon + thin CLI"
disposition: judgment-only
---

# A signal is inert unless the condition it keys on is actually modeled in state

## The situation

Bounty's `doing`-column heartbeat poked cards that were correctly parked in
`doing` but legitimately waiting on a peer (a lockstep handoff) — it read as
"stuck?" when nothing was wrong (issue #40, from the dream-flute multi-agent
team). The obvious fix: skip the heartbeat for any card the board already
computes as `blocked` (it carries `blockedBy` → derived
`blocked`/`liveBlockers`). Cheap, reuses existing state, and a unit test proves
"a blocked overdue card produces no poke."

## What the familiar concluded

Ship blocked-skip; the unit tests are green; done. The predicate is correct and
the guard is in both the daemon poke (`computeDuePokes`) and the surface's
card-aging cue (`cardOverdue` ⇄ the Alpine `staleInfo` mirror).

## What the mage wanted instead

The team lead who filed the issue (consulted live over grapevine before the
build) gave the load-bearing answer: in their real session the lockstep waits
were **informal** — cards sat in `doing` and the "hold your commit" coordination
happened on the side-channel, **never** as a `block <id> --on <peer>` edge. So a
naive blocked-skip would **pass every unit test and do nothing in the actual
situation that triggered the issue** — the state it keys on (`blockedBy`) wasn't
being set. The fix only bites when paired with a **workflow nudge**: model a
lockstep/serialize wait as a block edge, and the nag goes quiet for free (and
self-clears when the peer reaches `done`). The nudge went into the spell's
SKILL, not just the team's SOP, so it's discoverable for everyone.

## The distilled judgment

When you fix a noisy signal by **skipping the cases where a condition holds**,
ask first: _is that condition actually present in the state at the moment the
signal fires?_ If the condition is something users must opt into expressing
(here, a block edge), the tooling fix is **inert without a workflow convention
that populates it** — so ship the mechanism **and** the nudge that makes the
state real, or the green test suite is lying to you about the fix working.
Validate the assumption with the people who hit the bug, not the test fixture:
the fixture sets `blockedBy`; the real session didn't.

(Corollary already in force: the skip had to land in both the daemon helper and
its hand-mirrored Alpine twin — the surface-mirror lockstep this rule's
readback-parity scenario covers.)

## Binding

- **Rule affected:** `house-style.md` → "Drive a conjuration through a daemon +
  thin CLI" — extends its readback/surface-parity corollary with: a state-keyed
  signal is only as good as the discipline that populates that state; pair the
  mechanism with the convention that makes the state real.
- **Repeal criterion:** if a signal keys on a condition the system sets
  automatically (not user-opted), the nudge is unnecessary — the mechanism
  stands alone. The pairing is required only when the keyed-on state is opt-in.
