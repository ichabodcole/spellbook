---
date: 2026-06-11
spell: grapevine
rule:
  Architect for the reader's context (reinforced); adjacent to glamour's "infer
  the mode" judgment
disposition: judgment-only
---

# Default to the passive, low-commitment state; make participation explicit

## The situation

Building grapevine V1.7 (the human as a first-class participant in a channel),
we had to choose what happens when the human opens the watch surface or clicks
into a channel: do they **join** (named, visible, can send) or **lurk** (read
only, invisible)? An earlier decision in the same session had picked
**join-by-default** ("represented"), reasoning that a lurking watch tab bumps
the connection count anonymously, which confuses agents — so attribute the human
by default.

## What the familiar concluded

Default the human to **joined/represented**: opening a channel registers them as
a named, human-marked participant, so their presence is always attributed and
never reads as a mysterious anonymous connection.

## What the mage wanted instead

A live soak flipped it. Real use showed two things the a-priori reasoning
missed: (1) **most of the time you're just reading**, not participating —
auto-joining every channel you glance at is the wrong default; and (2) because
switching channels reloads the page, join-by-default meant **leaving a channel
and coming back silently re-joined you** — jarring, and it undoes a deliberate
choice to lurk. The mage wanted: **default to lurk** (the passive, low-stakes
state), make **joining an explicit, deliberate click**, and **persist that
choice per-channel** so it survives refreshes and channel-switches. Clicking to
_view_ should never escalate you into a more-visible, more-committed state.

## The distilled judgment

When an action has a passive reading and an active one, **default to the
passive, low-commitment, reversible state, and make the higher-commitment state
explicit and sticky.** Viewing ≠ participating; don't auto-escalate a user into
a more visible or committed mode on a glance. Two corollaries surfaced here: a
reasonable a-priori default can be **wrong in a way only real use reveals** — so
hold defaults loosely until a soak walks them; and once the user makes the
explicit choice, **remember it** (a deliberate state that silently resets on a
reload is its own bug). The original worry (anonymous-bump confusion) was real
but was the wrong thing to fix with the default — it was better fixed by making
lurk _truly invisible_ (uncounted), so the passive state costs nothing.

## Binding

- **Rule affected:** reinforces `house-style.md` → "Architect for the reader's
  context" (the reader being a person who is usually browsing, not posting); a
  runtime-UX sibling of the glamour scenario
  [[2026-06-11-glamour-style-capture-vs-asset-board]] ("infer the mode; don't
  make the user declare it"). Both say: read what the user is most likely doing
  and don't tax the common case. No new rule.
- **Repeal criterion:** none — application of a perennial rule. If a future
  surface's common case genuinely _is_ participation (not browsing), the default
  flips for that surface; the judgment (default to the common, low-commitment
  case) stands.
