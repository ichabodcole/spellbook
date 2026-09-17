---
type: backlog
title: "Grapevine: presence events (join / leave)"
status: stable
description:
  Broadcast presence events in grapevine to show agent and human activity status
lifecycle: open
generated: { by: unknown, at: 2026-06-28 }
---

# Grapevine: presence events (join / leave)

An agent supervising a channel gets **no signal when a human or agent joins or
leaves** — it only learns someone is present when they send a message, or by
polling `who`. For the human-as-participant model, a join event lets agents
greet/acknowledge a human when they arrive.

**The design trap to avoid:** do NOT emit join/leave as **messages in the JSONL
log**. Presence is flaky — `tail` auto-reconnects on drops, the watch reloads on
every channel switch — so "emit a message on connect" would spam
`joined`/`left`/`joined` into history on every transient reconnect.

**Right shape:** an **ephemeral presence frame** on the SSE stream (e.g.
`kind:"presence"`, `{event:"join"|"leave", alias, human}`) that is **never
persisted**, plus **debounce** so a reconnect / channel-switch reload doesn't
fire a fake join (only emit on genuinely new presence; grace period on leave).
Consumers that care subscribe; the log stays clean. Possibly scope to **human**
joins only at first (agents reconnect constantly — their join/leave is noise).

Pairs with the V1.7 human marker (`who.humans`) — this is the push version of
what `who` answers by poll today.

## References

- `plugins/spellbook/skills/grapevine/scripts/daemon.ts` — `broadcast`,
  `visibleSubs`, presence roster
