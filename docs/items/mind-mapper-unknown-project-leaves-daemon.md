---
type: item
title: mind-mapper open with an unknown project leaves a daemon running
description:
  mind-mapper open --project <unknown> exits 2 but the daemon it started keeps
  running, and the CLI has no verb to stop it.
status: draft
lifecycle: triage
id: 01a177a1-fae8-7251-96c4-8af6ef52a40e
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-26 }
tags: [mind-mapper, cli]
from: items/shrink-shipped-dist.md
---

# mind-mapper open with an unknown project leaves a daemon running

Found by the no-stake verifier of `shrink-shipped-dist` (2026-10-26).

`mind-mapper open --project <unknown>` exits 2 (usage). The daemon it started
for that open is still running afterwards, and mind-mapper's CLI has no stop or
close verb, so only a kill by PID ends it. mind-mapper is unreleased.

## Definition of done

- [ ] A refused `open` leaves no daemon running: either refuse before spawning,
      or stop the daemon it started.
- [ ] Tested.
