---
date: 2026-06-25
spell: glamour
rule: house-style.md → "A spell is a shared workspace — design for co-presence"
disposition: judgment-only
---

# The surface's gestures are a vocabulary the human signals the agent with — each must be distinct and documented in the skill

## The situation

Glamour's gallery let the human mark items: a star, a heart (like), a pin.
During the dogfood Cole asked the plain question — "does liking vs starring mean
anything different to you?" It didn't: the agent read both as bare booleans,
neither was defined anywhere, and the user himself wasn't sure what each was
for. Three overlapping "I like this" gestures, zero shared meaning.

## What the familiar concluded

They're UI affordances inherited from an earlier surface — the agent can read
the flags off state if it ever needs them; harmless to leave as-is. Maybe
collapse the redundant ones to reduce clutter.

## What the mage wanted instead

Cole reframed it: **these marks are how the human communicates intent to the
agent**, so they can't be undefined or ambiguous — "it's got to be part of the
skill: what do these things mean, how should an agent interpret them, and the
user should understand that too." Keep them only if each earns a _distinct_ job,
and write that vocabulary into the SKILL so both sides share the language. We
landed on: **like** = taste signal (soft positive), **star** = shortlist (the
working set / "my picks"), **pin** = canonical (defines the style; drives the
Canonical section and travels with the saved style), **archive** = out. Two more
moves made the vocabulary real: each gesture got a **visible payoff**
(combinable mark filters; the Canonical section became a live view of pins) so
the signal is worth sending, and the per-item text annotation was made
**ambient** (read on demand, not pushed — reinforces the event-volume rule).

## The distilled judgment

In a shared agent⟷human workspace, **every gesture the human can make is a
message to the agent** — so the gesture set is a _vocabulary_, and it must be
designed like one: each gesture has a single unambiguous meaning, the meanings
are written into the skill so the human and the agent share them, and each
carries a visible payoff that makes the signal worth sending. Undefined or
overlapping affordances aren't neutral clutter — they're noise the agent can't
reliably interpret and the human can't trust. When you add a mark/toggle/gesture
to a surface, define what it tells the agent, or don't ship it. (And decide its
delivery: a deliberate signal worth interrupting the agent for, vs. context the
agent reads on demand — see 2026-06-24-throttle-agent-facing-event-volume.)
