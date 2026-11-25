---
type: item
title: A hold lapsing during a roll can start two grapevine daemons
description:
  If a stop --hold hold runs out while roll is starting the new daemon, a
  waiting tail's reconnect can spawn a daemon beside roll's, because the
  daemon's already-running check is not atomic.
status: draft
lifecycle: triage
id: 01a210b2-d937-770c-bf11-4bbd82f1c22d
kind: bug
generated: { by: claude-opus-5-5, at: 2026-11-24 }
from: items/grapevine-hold-has-no-way-out/sessions/2026-11-24-roll-ends-a-hold.md
---

# A hold lapsing during a roll can start two grapevine daemons

Found in the review of
[grapevine-hold-has-no-way-out](./grapevine-hold-has-no-way-out/item.md). After
`stop --hold <s>`, waiting tails reconnect with backoff (up to 5 s). If the hold
runs out while `roll` is starting the new daemon, a tail's reconnect can call
`ensureDaemon` and spawn its own daemon beside roll's: the daemon's
already-running check (port and pid files) is not atomic. A tail running an
older CLI would start a stale daemon. The window is narrow and predates that
fix; no test covers it.

## Definition of done

- [ ] Two concurrent starts (roll and a tail's respawn) end with one daemon, by
      an atomic claim (an exclusive-create lock file or the bind itself).
- [ ] Tested with two starts racing in a private `GRAPEVINE_HOME`.
