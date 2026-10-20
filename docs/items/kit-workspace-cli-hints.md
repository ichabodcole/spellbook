---
type: item
title: The kit CLI's hints for an unknown session and the tail keepalive
description:
  On the kit path, an unknown --session is told no daemon is running and to
  restore it, even while that daemon runs; and tail --once prints a non-JSON
  keepalive comment line.
status: stable
lifecycle: ready
id: 01a13c0d-b24c-75b2-af4d-ac78fa192dec
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-14 }
tags: [kit, cli]
parent: feature/workspace-kit
from: items/scriptorium-on-kit-daemon.md
cycle: 2026-10-shell
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

- [x] An unknown session gets a hint that names what actually happened.
- [x] `tail --once` prints only JSON lines, or the keepalive is documented as
      part of the tail's output.
- [ ] Offered to Story Studio on `kit-parity` if the fix is in kit-generic code.
      (The fix is kit-generic; the port-back notes below are the offer. Posting
      it on `kit-parity` is left to the lead.)

## Done and verified

`fix(kit): the CLI's no-session refusal names what happened` on
`impl/kit-cli-contract-v2` (2026-10-19), on top of
[kit-ended-session-hint](./kit-ended-session-hint.md)'s chapter, which it
extends (the same function, so pick both, in order).

- **The refusal names the session asked about.** The ended-session chapter made
  the kit's `noSession(session)` the shipped CLI's rule
  (`src/scriptorium/backend/cli.ts` `noSession`) in kit words: a saved session
  with no daemon gets `no running <app> session <id>` and
  `` `open --restore <id>` `` for THAT id, so `close --session <id>` no longer
  hints at a different session. This chapter adds the last case: an id that is
  not saved here (a typo, another app's or another home's id, such as a shipped
  Scriptorium session handed to the kit path while it runs) gets
  `no <app> session <id> is saved here (<sessions folder>)`, the saved ones as
  `choices`, and no restore. Naming the folder is the kit's addition: the
  shipped CLI says "in this home", and on the kit path the shipped and kit
  sessions live in two folders of one home.
- **The keepalive is documented.** It was never on stdout: `tailEvents` writes
  comment sentinels to stderr, so `tail --once`'s stdout is JSON lines only (the
  shipped tail does the same, and the SKILL already tells the agent to skip `:`
  lines). The help's Output paragraph now says so, and a test pins both halves.
- **SIGTERM leaving the pointer** is unchanged: readers cope, as the item says.
  A bare verb whose newest session's pointer names a dead pid says that session
  is not running ([kit-ended-session-hint](./kit-ended-session-hint.md)).

Tests (`src/kit/workspace/verbs.test.ts`): a named session with no daemon
(`state`, `close`) names that session, not the newest; an agent or timeout end
still offers the way back; an unknown `--session` names the saved ones and no
restore, and says so when none is saved; and `tail --once` against a stub daemon
prints `grounding`, the event and `tail.woke` as JSON on stdout with
`: kit-fixture-keepalive` on stderr, and the help names it. The
`daemon.integration.test.ts` case for `--session no-such-id` was rewritten to
the new truth. Mutations, each red then restored: the unknown-id branch off (1
red), the named id replaced by the newest (3 red), the tail's sentinels routed
to stdout (1 red), the help's keepalive sentence dropped (1 red). Driven side by
side on scratch homes with the shipped CLI: the kit path now answers a closed
named session, an unknown id and the shipped session's id (while it runs) as
above; a live `tail --once` held past one 15 s heartbeat printed three JSON
lines on stdout and `: scriptorium-keepalive` on stderr.

## Port-back notes

- `src/kit/workspace/verbs.ts`: `noSession(session)` (from the ended-session
  chapter) also answers an id not saved here, with the saved ones as `choices`.
  Story Studio's `requireSession` and `noSessionHint` at `develop` `5b3bd8d`
  (`packages/kit/src/workspace/verbs.ts:387-429`) have the same gap.
- `src/kit/workspace/verbs.ts`, the help footer's Output paragraph: one sentence
  on the keepalive lines on tail's stderr.
