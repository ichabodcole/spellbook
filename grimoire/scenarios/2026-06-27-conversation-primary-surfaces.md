---
date: 2026-06-27
spell: magpie
rule: A spell is a shared workspace — design for co-presence
disposition: judgment-only
---

# Conversation is the primary capability; buttons are shortcuts for it

## The situation

Building magpie's phase advancement. The Slice phase needed a way for the user
to seal it and move to Remove. I'd built a persistent gold "Close down this
phase?" gate pinned at the bottom of every phase body — a standing button to
click.

## What the familiar concluded

A persistent, prominent button is the obvious affordance: the user always knows
where to advance, and the action is one click away.

## What the mage wanted instead

Kill the standing button. It greets you the moment you enter a phase you haven't
worked yet (premature), and it trains the user to hunt the screen for "where's
the button to do X?". The default reflex should be **just tell the agent** —
"looks good, let's go" — and the agent orchestrates the advance. Buttons, when
they appear, are **shortcuts for a conversational act**: the agent
(facilitator), sensing readiness, can offer an inline CTA in the thread ("Ready
for removal? [Move to Remove →]") — a one-click version of the user saying it —
but its absence never blocks the user, who can always express the same intent in
words.

## The distilled judgment

In a co-presence surface, **conversation is the primary capability and nothing
gets in the way of it.** Build every action so it can be driven by talking to
the agent; then layer affordances as conveniences on top — an agent message can
carry a CTA whose click dispatches the same command the user could have asked
for. Don't add a standing UI control for something the user can just say; if you
add one as a backstop, keep it quiet and secondary. The win generalizes:
"actionable agent messages" (a CTA attached to a chat turn) is a reusable
affordance, not a one-off.

## Binding

- **Rule affected:** refines "A spell is a shared workspace — design for
  co-presence." Pairs with surface-as-shared-state-board (same session).
- **Repeal criterion:** an action that genuinely cannot be expressed
  conversationally (rare) is outside this rule — for those, a standing control
  is fine.
