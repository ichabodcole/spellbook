---
type: item
title: A paused grapevine daemon is taken for gone, and a second one starts
description:
  readDaemonPort deletes the port and pid files when the daemon doesn't answer
  within 500 ms, so start or restart --force spawns a second daemon beside a
  stopped (SIGSTOP) one.
status: draft
lifecycle: triage
id: 01a176ad-1aaa-77b5-960e-775139c32393
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-25 }
from: items/bounty-grapevine-skill-review.md
---

# A paused grapevine daemon is taken for gone, and a second one starts

Found by the SKILL review and confirmed by its verifier (2026-10-25). After
`kill -STOP` on a scratch daemon, `stop` returned `{ok:true, daemon:false}` and
`start` (and `restart --force`) spawned a second daemon beside the stopped one.
`doctor` then listed the old one as `unresponsive`.

The cause: `readDaemonPort` (`src/grapevine/backend/cli.ts` around 368–391)
deletes the port and pid files when `GET /` doesn't answer within 500 ms, so a
daemon that is alive but slow or stopped reads as absent. The
`daemon_still_running` refusal from `ci-red-on-linux` covers only a daemon that
keeps answering.

## Definition of done

- [ ] A daemon whose pid is alive but doesn't answer is reported as stuck (with
      its pid and the act that clears it), not removed from discovery.
- [ ] `start` and `restart` refuse to spawn beside a live pid.
- [ ] Tested with a SIGSTOPped daemon of the test's own.

## Related Documents

- [Review bounty + grapevine SKILL.md for accuracy and usefulness](./bounty-grapevine-skill-review.md)
