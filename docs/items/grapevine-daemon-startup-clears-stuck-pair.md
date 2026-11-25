---
type: item
title:
  The grapevine daemon's own startup check still takes a stuck daemon for gone
description:
  daemon.ts's startup ping deletes the port and pid pair when an existing daemon
  does not answer in 500 ms, so a daemon spawned by an old CLI can still start
  beside a paused one.
status: draft
lifecycle: triage
id: 01a210e0-7df6-77fe-a23f-eeb3d73bee1f
kind: bug
generated: { by: claude-opus-5-5, at: 2026-11-24 }
from: items/grapevine-paused-daemon-reads-as-gone/sessions/2026-11-24-stuck-not-gone.md
---

# The grapevine daemon's own startup check still takes a stuck daemon for gone

Left by
[grapevine-paused-daemon-reads-as-gone](./grapevine-paused-daemon-reads-as-gone/item.md).
The CLI now reports a live but silent daemon as stuck and refuses to spawn
beside it, but `src/grapevine/backend/daemon.ts` (around line 1499) still
deletes the port and pid pair when its own 500 ms startup ping times out. Only a
spawn from an older CLI reaches it today. `daemon.ts` is frozen under the size
limit, so a fix makes room first.

## Definition of done

- [ ] A daemon starting beside a live, silent grapevine daemon (same home)
      leaves the pair alone and exits, saying which pid holds the home.
- [ ] Tested with a SIGSTOPped daemon of the test's own.
