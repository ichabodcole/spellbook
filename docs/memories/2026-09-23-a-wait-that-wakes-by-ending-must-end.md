---
type: memory
title: "A wait that wakes by ending must end on every path"
description:
  A background task wakes the agent only by exiting, so a one-shot that does not
  exit fails silently; the tail handoff hit that shape three times, each on a
  path other than the happy one
tags: [tail, monitor, background-tasks, silent-failure]
status: stable
generated: { by: claude-opus-5.5, at: 2026-09-23 }
---

# A wait that wakes by ending must end on every path

## What happened

The tail handoff (`src/kit/wire/tailHandoff.ts`) parks an idle agent in a
background `tail --once`. The harness wakes the agent only when that task
**exits**. Its output means nothing until then. So every way the wait can finish
has to end the process, and one that doesn't is indistinguishable from a quiet
session.

It went wrong three times, each on a path other than the happy one:

- **The event path** (the feasibility spike). The one-shot printed its event and
  stayed alive, because the client returned on a terminal frame with the SSE
  stream still open. Fixed by aborting the connection before returning.
- **The dead-daemon path.** A killed daemon made the tail retry forever on
  stderr. Fixed: refused connections end it with `tail.lost` on stdout.
- **The closed-in-the-gap path** (the verifier's D1). A re-arm at a session that
  had closed retried "no session yet" forever. Fixed: a re-arm that can't find
  its session ends it with `tail.closed`.

None of the three printed anything wrong. They just never ended.

## What to carry forward

- **For anything that signals by exiting** (a `run_in_background` wait, a
  Monitor command with a natural end), list every way the wait can finish:
  success, the peer closing, the peer dying, the peer never existing, and a
  stop. Show that each one ends the process. The printed line is not the proof.
- **Test the exit, not the output.** The cells that caught these assert that the
  process exits within a bound. A cell that reads the last line passes on a
  process that hangs after printing it.
- **Retry-forever is a hang in any caller that waits for an end.** A retry loop
  needs a condition that says "this will not come back", and the one that says
  so must end with a line naming the next act.

**Key files:** `src/kit/wire/tailEvents.ts`, `src/kit/wire/tailHandoff.ts`,
`src/scriptorium/backend/tail-handoff.integration.test.ts`

**Docs:**
[The session](../projects/scriptorium/sessions/2026-09-23-the-tail-hands-off-before-the-cap.md)
·
[The investigation](../investigations/2026-09-22-monitor-expiry-and-the-tail.md)
