---
date: 2026-06-11
spell: glamour
rule: none (judgment that shaped glamour's SKILL.md, not a house-style rule)
disposition: judgment-only
---

# Glamour serves two modes; infer the mode, don't expose it

## The situation

While writing glamour's `SKILL.md`, the question came up of how to present what
the spell does. glamour composes a re-castable **style spec** from references —
but the user community for "help me with my images" splits: some want a _style_
(a durable spec that future generation reproduces), and some want _assets_
pulled out of the look (logos, stickers, icons, mascots) to use as discrete
files. media-forge exposes **transform** verbs (background-removal, cutout,
vector) that only make sense for the asset case.

## What the familiar concluded

Document both modes as first-class options and have the agent **ask the user up
front** which one they want — a clean either/or at the top of the flow, so the
agent knows whether to offer the transform verbs.

## What the mage wanted instead

Don't make the user answer a mechanical mode question. The mode is almost always
**legible in the intent already** — "nail down the visual style for my game" is
style-capture; "pull these logos out as transparent PNGs" is asset-board. Asking
up front taxes every user with a fork that most don't need to think about, and
it leaks the tool's internal structure (that there even _are_ two code paths)
into the user's experience. The right move: state the default (style-capture —
the spec is the deliverable, generated images are illustrative), describe
asset-board as the case where transform verbs belong, and tell the **agent** to
infer mode from intent. Offering cutout/vector verbs in a style-capture session
is the concrete failure to avoid — it misreads what the user came for.

## The distilled judgment

When a tool has internal modes, prefer **inferring the mode from intent** over
asking the user to declare it. A mode question is only worth surfacing when the
signal is genuinely ambiguous _and_ the cost of guessing wrong is high. Default
to the common mode, describe the other as a recognizable case, and put the
discrimination logic in the agent's reading of intent — not in a prompt that
makes every user pay for the rare branch. This is the same instinct as "generous
invocation" and "start minimal," applied to runtime UX rather than to authoring:
don't make the human carry a decision the agent can make from context.

## Binding

- **Rule affected:** none — judgment only. It shaped glamour's `SKILL.md` ("Two
  modes — infer from intent, don't ask mechanically") and is adjacent to the
  existing house-style instinct toward generous, low-friction invocation.
- **Repeal criterion:** if real use shows the agent routinely misreads the mode
  (offering transform verbs in style-capture sessions, or missing asset-board
  intent), revisit — a single lightweight confirmation at the moment the
  transform verbs would first be offered would be the smaller fix, still short
  of a mandatory up-front fork.
