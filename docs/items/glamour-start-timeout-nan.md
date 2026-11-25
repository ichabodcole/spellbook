---
type: item
title:
  glamour open --start-timeout with a non-number fails at once and kills the
  daemon
description:
  open parses --start-timeout with parseInt and no check, so a non-number gives
  NaN, the handshake timer fires almost at once, and the new start helper then
  stops the daemon.
status: draft
lifecycle: triage
id: 01a21107-6510-7585-a4ef-3a421acb775b
kind: bug
generated: { by: claude-opus-5-5, at: 2026-11-24 }
from: items/glamour-daemon-holds-cli-stderr/sessions/2026-11-24-open-frees-stderr.md
---

# glamour open --start-timeout with a non-number fails at once and kills the daemon

Found in the review of
[glamour-daemon-holds-cli-stderr](./glamour-daemon-holds-cli-stderr/item.md).
`cmdOpen` computes `Math.max(5000, parseInt(flag) * 1000)`; for `abc` that is
`NaN`, so the handshake timer fires almost at once. It predates that fix, but
the kit's `startDaemon` now stops a daemon that misses the handshake, so the
daemon is killed rather than orphaned. The workspace validates the same kind of
flag with `flagSeconds`.

## Definition of done

- [ ] A non-numeric or negative `--start-timeout` is refused as a usage error
      (exit 2) naming what it accepts, before anything is spawned.
- [ ] Tested.
