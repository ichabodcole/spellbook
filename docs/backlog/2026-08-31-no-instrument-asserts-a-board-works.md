# Nothing in the gate can distinguish a served 200 from a working board

**Added:** 2026-08-31 · **Found by:** `cassandra`, stated as the standing caveat
on both of spell-kit sprint 01's local-sim drives · **Scope:** house-wide ·
**Severity:** medium — it is the gap every surface-bearing sprint closes by hand
and none of them closes durably

## The claim, in her words

> **Phase 1a is proven; it is not guarded.** The cells run every gate, this
> drive ran once by hand.

Both relocated spells were verified end to end — React hydrating, Tailwind
actually applied, images decoding, live push in both directions, and for imago
the `shared/` contract proven **by effect** (an identical source through the
daemon and the browser producing identical dimensions). **None of that is
reachable by `bun run check && bun test`.**

## What makes this more than "we lack e2e tests"

The drives established that the **obvious** automated checks are actively
misleading here:

- **A byte-size or rule-count check prefers the broken artifact.** A 288 KB
  inert stylesheet with 4,002 rules matching nothing outscores the real 142 KB
  one on every count-shaped measure; only **rules matching the live DOM**
  separates them (165 vs 2).
- **A DOM-shape assertion cannot see a broken image** — a failed `<img>` keeps
  its `src` and satisfies every structural check. `naturalWidth` is the
  discriminator.
- **A wrong Contract 5 cwd serves HTTP 200 and renders a board**, with one
  Tailwind marker instead of 213.

So a naive smoke check would not merely be weak — it would **pass on exactly the
artifacts these drives caught.** The discriminating form found twice is
**remove-it-and-diff against the live DOM**, which needs no baseline and no
knowledge of correct output.

## The cost of leaving it

imago's 33 cross-tree edges are invisible to every arm of the gate. The drive
that proved them would have to be **re-run by hand after any change to
`shared/`** — and nothing says so at the point where someone would change it.

## Acceptance

- [ ] Decide whether a board-level check belongs in the gate at all, or stays a
      **ritual** attached to relocation and to `shared/` changes. Both are
      defensible; the current state is neither.
- [ ] If it stays a ritual, it needs a **trigger** — a note where `shared/` is
      edited, not a line in a retro. A ritual with no trigger is the deferral
      this file exists to prevent.
- [ ] Any automated form must be calibrated against a **deliberately broken
      artifact** before it is trusted, per both drives.
