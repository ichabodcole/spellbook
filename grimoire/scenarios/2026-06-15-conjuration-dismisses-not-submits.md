---
date: 2026-06-15
spell: bounty
rule: house-style.md → "Match the kind to the interaction: cantrip for cast-and-resolve, conjuration for duration"
disposition: judgment-only
---

# A conjuration dismisses; it doesn't submit

## The situation

Bounty inherited a **submit** button and a **close-without-submitting** (cancel)
button from the old one-shot/duplex surface recipe. In the old substrate the
agent's call _blocked_ on the surface's stdout, so "submit" was how the user
said "done — here's the final state" (exit 0) and "cancel" was abandon (exit
130). The migration kept both during the faithful port.

## What the familiar concluded

Port them faithfully and move on — they're existing, tested behavior; removing
them is scope the migration didn't ask for.

## What the mage wanted instead

cole noticed the buttons and asked whether they still earn their place. They
don't: in the daemon model the agent isn't _waiting_ — it sees every change live
over `/events` and reads `/state` on demand, so "submit-as-flush" has nothing to
flush. And it's a category error against the spell taxonomy: a **cantrip**
resolves (cast → act → submit → exit); a **conjuration** _stands until
dismissed_. Bounty is a conjuration, so submit (a cantrip affordance) leaked in.
Completion already lives in the columns (a task reaching `done`, the review
gate), not in a board-level submit. The over-modeled submit/cancel pair
collapsed to a single **"Close board"** dismiss (exit 0, reason `"user"`); the
board is also durable now (snapshot/restore), so dismissal is non-destructive.

## The distilled judgment

When a surface streams state to the agent live, a terminal **submit** is
vestigial — there's nothing to flush. Match the affordance to the kind: cantrips
_resolve_ (submit/exit); conjurations _dismiss_ (a single close). If you find a
standing, live-streamed surface carrying a "submit," it's a cantrip concept that
leaked into a conjuration — collapse it to a dismiss, and let the durable state
make dismissal cheap. Completion is expressed in the structure (columns,
status), not a global submit.

## Binding

- **Rule affected:** `house-style.md` → "Match the kind to the interaction." A
  refinement of its boundary check: a streamed-to-agent conjuration shouldn't
  carry a cantrip's submit/resolve affordance — only a dismiss.
- **Repeal criterion:** if a conjuration genuinely needs a human to _finalize
  and hand off_ a curated artifact (distinct from per-item completion), a
  deliberate "submit/finalize" could re-earn its place — capture that case
  before adding it.
