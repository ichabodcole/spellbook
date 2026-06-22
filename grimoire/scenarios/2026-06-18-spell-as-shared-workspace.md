---
date: 2026-06-18
spell: imago (cross-cutting)
rule: A spell is a shared workspace — design for co-presence (new)
disposition: added-rule
---

# A spell is a board both parties work, not a form one submits

## The situation

imago began as the obvious shape for AI image generation: a prompt box and a
Generate button. Over its build it evolved into something else — a dynamic
back-and-forth where the agent and human discuss the image, artifacts
accumulate, and the generation tools are used _in service of_ a conversation
rather than a transaction. Reviewing that evolution, the mage asked whether the
grimoire had captured the underlying shape-insight, or only imago's surface
features.

## What the familiar concluded

The grimoire had the _mechanics_ — dual channels (human WebSocket / agent
cmd-state-events), `readback-parity` (the agent reads `state` at surface
parity), surface-fit, client-thin — but only as architecture and transport. The
manifesto's framing was even one-directional: "the surface is a membrane — you
act on it, intents bubble up, the agent interprets and responds." Human → agent.
A first instinct was to write the principle around imago as the defining
example.

## What the mage wanted instead

Two corrections. First, the principle is **co-presence**: human and agent are
_both users_ of one surface, each perceiving the shared work-object through its
own channel (the human a UI, the agent data + events) and each acting through
its own affordances — the membrane faces both ways, two parties with different
faculties present to each other through it. Second — and the load-bearing
correction — **don't let imago be the defining example.** Different spells lean
into different interaction _goals_ while sharing the same shape: imago is
co-creation (constant back-and-forth over a shared artifact); grapevine and
bounty are observation-with-the-door-open (the surface is the human's window
into agents working underneath, with the ability to step in); digestify is
co-ideation (the agent presents, the human reads and answers in one round). The
asymmetry — of faculties _and_ of goals — is normal, not a defect. The unifying
test is co-presence, not symmetry.

## The distilled judgment

A spell is a board both parties work, not a form one submits. The shared
principle is co-presence: each side can **see** the work (through its own lens)
and **act** on it (through its own affordances); neither is a spectator or a
submit button. Symmetry is _not_ required and rarely present — what's required
is that the work-object and its state are legible and actionable from both
seats. The anti-pattern to watch is the traditional app's gravity (_input →
service → output_): a surface that takes input and ships it somewhere instead of
a place two parties keep working something together. When you generalize a
principle from one spell, check it against the others first — the shape is
shared across the spectrum of leans, but no single spell defines it.

## Binding

- **Rule affected:** `house-style.md` → spawned a new rule, "A spell is a shared
  workspace — design for co-presence." Reinforces `readback-parity` (the agent's
  half of "both see it") and sits beside surface-fit. Flowed up into the
  manifesto as §2, "The board, not the form."
- **Repeal criterion:** if a spell shape emerges where one party is
  _legitimately_ a pure spectator or a pure submit-button and the surface is
  still doing real work (not just a degenerate pipeline), the co-presence
  framing is too strong — revisit it then.
