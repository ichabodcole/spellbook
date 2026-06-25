---
date: 2026-06-24
spell: glamour
rule: house-style.md → "Drive a conjuration through a daemon + thin CLI"
disposition: judgment-only
---

# Event volume to agents is a first-class constraint — broadcast on deliberate commit, not on every local state change

## The situation

In the glamour-v2 dogfood, the human typed a free-text annotation on a reference
image. The daemon broadcast a state event on **every keystroke** — the
supervising agent's event tail received `"It se"` → `"It serv"` →
`"It servers as a pretty good refe"` → … one event per character, plus a final
settled value. From the browser the typing felt normal; from the agent side (and
every other connected subscriber, and the replay log) it was a per-character
firehose.

## What the familiar concluded

Live updates are good collaborative UX — broadcast state on every change so all
clients stay perfectly in sync, instantly. The annotation field is just bound to
state; state changes broadcast; nothing special.

## What the mage wanted instead

The agent — and any other subscriber — is a **consumer of a deliberate event
stream, not a mirror of the human's keystrokes.** Cole's call: "we have to add a
save button vs live updates, or a debounce, so you don't get blasted with
events… that's probably a good lesson regarding event volume hitting the agent
side." The local input can stay live (good UX), but the **network broadcast must
be decoupled from it** — commit on blur / explicit save, or debounce to idle.
This is the same philosophy as glamour's earlier explicit-Send-button decision
(deliberate commits over live streams), now generalized: the unit of broadcast
is a _finished thought_, not a render tick.

## The distilled judgment

When a conjuration's daemon broadcasts to agent consumers, **event volume is a
design constraint on par with correctness.** Every broadcast is (1) a message in
some agent's finite context/attention budget, (2) a line in the replay log a
reconnecting agent must re-read, and (3) fan-out multiplied across N
subscribers. Per-keystroke or per-frame state pushes are an agent-context DoS:
they flood attention, bloat replay, and scale badly with co-presence. So
**decouple local echo from network broadcast** — keep the input responsive
locally, but throttle what crosses the wire. Default to commit-on-blur /
explicit-save (or a debounce) for any free-text or high-frequency input that
feeds an agent event stream; treat "broadcast on every change" as a smell to
justify, not the default. Reinforces the daemon + thin-CLI rule from the
consumer side: the thin client tails a stream, so the daemon owes that stream
restraint.
