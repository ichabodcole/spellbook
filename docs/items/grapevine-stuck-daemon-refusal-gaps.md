---
type: item
title: Grapevine's refusal for a daemon that will not stop leaves three gaps
description:
  After the stop race fix, doctor adds nothing for a stuck daemon, a refused
  stop --hold leaves its hold active without saying so, and roll's hold release
  on the refusal path is untested.
status: draft
lifecycle: triage
id: 01a17266-76ba-76e7-aa08-0432ad6ad8d3
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-25 }
from: items/ci-red-on-linux.md
---

# Grapevine's refusal for a daemon that will not stop leaves three gaps

Found 2026-10-25 by the no-stake verifier of
[ci-red-on-linux](ci-red-on-linux.md). `stop`, `restart` and `roll` now wait for
the daemon to go, and refuse with `daemon_still_running` (exit 1) when it
doesn't within 5 s. Three gaps remain, each low:

- **`doctor` is a weak pointer.** The refusal's hint is `try: … doctor`, but
  doctor reports the stuck daemon as authoritative and `ok`, and its hints are
  about other daemons. The real remedy is the `kill <pid>` in the message.
- **A refused `stop --hold N` leaves its hold behind.** The hold is written
  before the stop; the refusal doesn't say a hold is now active. It lapses after
  N seconds.
- **`roll`'s hold release on the refusal path is untested.** Releasing it only
  on success (instead of in `finally`) passes `cli.stop.test.ts` and
  `cli.daemon.test.ts`.

## Definition of done

- [ ] The refusal names an act that actually answers it (doctor made useful for
      this case, or a different hint), per "a warning needs an action".
- [ ] A refused `stop --hold` either releases its hold or says it is active.
- [ ] A test goes red when `roll` skips the hold release on the refusal path.
