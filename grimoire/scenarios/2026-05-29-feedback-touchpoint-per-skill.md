---
date: 2026-05-29
spell: cross-cutting
rule: Every spell ships a feedback touchpoint (new)
disposition: added-rule
---

# A loop in the system ≠ a touchpoint in each artifact

## The situation

After reading HiveMind's "intentional design for feedback loops" lens, the
question was whether to state it as a Spellbook authoring rule or leave it
implicit.

## What the familiar concluded

The grimoire (fresh-agent + scenarios + decay) _is_ a feedback-loop system, so
the lens is already embodied — no need to add a rule; leave it.

## What the mage wanted instead

A feedback loop at the meta-system level is not the same as a **touchpoint in
each artifact.** Agents don't volunteer friction — they silently work around it;
humans are the same without a place to speak. So every skill needs its own
structured opening for the agent to report friction, plus a human-feedback
prompt when there's a surface. And it needs a real channel: **GitHub issues
against the repo** (the tools' home), since this is a real repo people can file
against.

## The distilled judgment

Embodying a feedback loop at the system level does not create the per-artifact
touchpoints that _generate_ the signal. Build the touchpoint into every skill,
and give it a concrete destination — without one, the loop has nothing to carry.

## Binding

- **Rule affected:** added "Every spell ships a feedback touchpoint"; wired into
  `inscribe` (SKILL.md step) and `ward` (checklist). Descends from the
  intentional-design-for-feedback-loops lens.
- **Repeal criterion:** never — but the _channel_ may change (a second one, e.g.
  a future HiveMind intake, could augment GitHub issues).
