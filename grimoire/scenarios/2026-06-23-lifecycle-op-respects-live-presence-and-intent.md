---
date: 2026-06-23
spell: grapevine
rule: house-style.md → "Drive a conjuration through a daemon + thin CLI"
disposition: judgment-only
---

# A clearing/lifecycle op must gate on live presence AND explicit intent — because its trigger verb is reachable incidentally and repeatedly

## The situation

Grapevine's channel-lifecycle release added two ops that mutate a channel a team
reuses across sessions: `open` should auto-unarchive a retired channel (so a
convene-at-start wrapper stops breaking), and `open --fresh` / `reset` should
clear a stale log for a new session. The literal plan said "auto-unarchive on
`open`" and "clear on `--fresh`." Both looked safe in isolation.

## What the familiar concluded

Implement the obvious thing: on `POST /channels`, if the channel is archived,
unarchive it; if `--fresh`, snapshot-then-clear. Unit tests pass. Done.

## What the mage wanted instead

Two real-use facts (one surfaced by the implementer mid-build, one by the
requester — dream-flute maestro — live over grapevine before the build) broke
the naive version:

1. **The trigger verb is reachable _incidentally_.** `pull` / `tail` / `who` /
   `read` / `topic` / `watch` all call `POST /channels` as an idempotent
   "ensure-loaded" step. So unconditional auto-unarchive would un-retire a
   channel merely by _reading_ it. Fix: gate auto-unarchive behind an
   `explicit: true` flag only the real `open` verb sends; read verbs keep their
   prior fire-and-forget 409.

2. **The trigger verb is reachable _repeatedly_.** The team's `convene` is
   idempotent — re-run mid-session for status checks. So `open --fresh` must
   **never** wipe a session that's in flight. Fix: `--fresh` clears only when
   the channel has **no live subscribers** (any connection, including a lurking
   watch tab), and is a silent no-op when seats are present. `reset` (the
   explicit verb) refuses a live channel without `--force`, and the snapshot
   always precedes the clear so even a forced clear is recoverable.

The daemon is what makes this expressible: it owns the live-subscriber truth
(`ch.subscribers.size`) and the archived marker, so the guard lives server-side
where the CLI can't see — the thin CLI just passes `explicit`/`fresh`/`force`.

## The distilled judgment

Before a verb mutates durable shared state, ask **how that verb is reached**,
not just what it does. If the same entrypoint is hit _incidentally_ (other verbs
piggyback on it) or _repeatedly_ (an idempotent caller re-runs it), a mutation
that's "obviously safe" on the happy path becomes a footgun: it fires on a read,
or wipes a live session on a re-run. Gate the mutation on **explicit intent**
(distinguish the deliberate caller from the incidental one) and on **live
state** (refuse/no-op when presence says it's unsafe), and put the guard where
the truth lives — the daemon, not the CLI. Tests that only exercise the happy
path will pass while the real situation that motivated the feature stays broken
(cf. [2026-06-22-signal-needs-the-state-it-keys-on.md] — same lesson from the
same team: validate against how the feature is actually reached/used, not just
its unit contract).
