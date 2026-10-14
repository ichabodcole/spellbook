---
type: item
title: The kit CLI's hints for an unknown session and the tail keepalive
description:
  On the kit path, an unknown --session is told no daemon is running and to
  restore it, even while that daemon runs; and tail --once prints a non-JSON
  keepalive comment line.
status: draft
lifecycle: triage
id: 01a13c0d-b24c-75b2-af4d-ac78fa192dec
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-14 }
tags: [kit, cli]
parent: feature/workspace-kit
from: items/scriptorium-on-kit-daemon.md
---

# The kit CLI's hints for an unknown session and the tail keepalive

Found while verifying [the flagged Scriptorium](./scriptorium-on-kit-daemon.md)
(2026-10-14). Both behaviours are the kit's own and predate it:

- With an unknown `--session`, including a shipped Scriptorium's id, the kit
  answers "no daemon is running… open --restore <id>", even while that daemon
  runs. Following the hint is safe: it gives a conflict. But the hint is wrong.
- `tail --once` prints a `: scriptorium-keepalive` line, which is not JSON.
- `close --session <id>` for a session that isn't running hints at a different
  session's id (found by the finalize review).
- SIGTERM leaves the session pointer behind, because no signal handler is
  installed. Readers cope with a stale pointer; the shipped daemon behaves the
  same way.

## Definition of done

- [ ] An unknown session gets a hint that names what actually happened.
- [ ] `tail --once` prints only JSON lines, or the keepalive is documented as
      part of the tail's output.
- [ ] Offered to Story Studio on `kit-parity` if the fix is in kit-generic code.
