---
type: item
title: Harden the kit's session-pointer API before a spell adopts it
description:
  The ported discovery pointer API trusts a dead-pid latest pointer, treats pid
  0 or -1 as alive, does not match a file name to its session_id, and writes a
  predictable temp name in a shared tmpdir on Linux.
status: stable
lifecycle: ready
id: 01a138c6-ae85-761c-a3f1-6a7bd4aa7385
kind: chore
generated: { by: claude-opus-5-5, at: 2026-10-13 }
tags: [kit, wire]
parent: feature/workspace-kit
from: features/workspace-kit/sessions/2026-10-13-kit-foundation.md
cycle: 2026-10-shell
---

# Harden the kit's session-pointer API before a spell adopts it

The kit-foundation cycle ported Story Studio's session-pointer API into
`src/kit/wire/discovery.ts`. No spell uses it yet. The finalize review
(2026-10-13) reproduced four weaknesses:

- `readPointer` trusts `<spell>.latest.json` even when its pid is dead. Only the
  fallback scan checks liveness.
- `isPointer` accepts `pid <= 0`, and `process.kill(0 or -1, 0)` reads as alive,
  so such a pointer wins the fallback.
- The fallback doesn't check that a file's name matches its `session_id`.
- On Linux, where `tmpdir()` is a shared `/tmp`, other users can plant pointers.
  The temp name `${target}.${pid}.tmp` is predictable, so a symlink can be
  planted ahead of the write.

## Definition of done

- [x] A dead-pid `latest`, a pid of 0 or below, and a name/`session_id` mismatch
      are each skipped, with a test (by the lead's ruling, a dead-pid `latest`
      is reported as the newest session crashed, never skipped to a sibling)
- [x] Pointers live in a per-user directory, or the temp file is opened
      exclusively, so another user can't plant or redirect one

## Done and verified

`fix(kit): the session pointer is a claim checked before it is trusted` on
`impl/kit-cli-contract-v2` (2026-10-19), with a verifier round folded in. All in
`src/kit/wire/discovery.ts`.

- **A pointer is checked for trust; a dead pid is not a trust failure.** A
  `latest` with a pid of 0 or below (or not a whole number), or whose file
  another user owns, falls back to the scan of live session pointers, as a
  missing `latest` already did. A `latest` with the wrong shape still throws. A
  well-formed `latest` naming a dead pid is returned as it is (the lead's
  ruling, after the verifier showed that skipping it sent a bare `close` to an
  older live session): it says the newest session crashed, which is the caller's
  to say. The kit CLI no longer reads `latest` at all (see
  [kit-ended-session-hint](./kit-ended-session-hint.md)), so this is the API's
  own answer for any other caller.
- **A pid of 0 or below is never a pointer.** `isPointer` requires a whole
  number above 0, and `pidAlive` refuses one too (defence in depth: signal 0 to
  0 or -1 reaches a process group). A session's own pointer with such a pid
  throws as the wrong shape, as other malformed pointers do.
- **A session's pointer must name its own session.** The scan skips a
  `<app>.<id>.json` whose `session_id` is not `<id>`; reading one by name throws
  ("names another session").
- **Another user's pointer is not this user's daemon.** Owner checked by uid
  (`ownedByMe`, where there are uids): skipped in `latest` and the scan, and a
  throw when read by name.
- **The write cannot be redirected.** `publishPointer` writes through
  `writePointerFile` (added for the newest-session record): a temp name with the
  pid and random bytes, opened `wx` (exclusive, never following a symlink) with
  mode 600, then renamed into place. Pointers are now readable by their user
  only. `writeFileAtomic` itself is unchanged: every other spell, and the
  shipped Scriptorium's manifest and pointers, write through it, and the brief
  keeps the shipped app as it is. Rename over a file another user planted at the
  pointer's own name fails (the sticky `/tmp`), so a plant can block a publish
  but never redirect one; the read-side owner check keeps it from being trusted.

Deliberately not changed: a session's own pointer naming a dead pid is still
returned, because its daemon dying without removing it is a crash, and the
tail's `tail.lost` is how the caller hears it.

Tests (`src/kit/wire/discovery.test.ts`, five new): a dead-pid `latest` is
returned as the newest session, crashed (the dead pid is a child the test
started and reaped); pids 0, -1 and 1.5 in `latest` and a newer session pointer
are skipped, and throw when read by name; a file named for `s9` holding `s1` is
skipped and throws by name; with `process.getuid` reporting another uid,
`latest` reads null and a named read throws; a symlink planted at the old
predictable temp name leaves its target untouched, and the pointer is mode 600.
The shared fixture's pid became `process.pid` (alive, ours) rather than 4242,
since reading `latest` checks it and no test should signal a process it did not
start.

Mutations, each planted, seen red, and restored (one red each): the liveness
check put back on `latest`, the `pid > 0` check dropped, the scan's name check
dropped, the named read's `session_id` check dropped, the uid check disabled,
and `publishPointer` back on `writeFileAtomic`. Driven on a scratch home: two
kit sessions, the newer one's daemon killed with SIGKILL (its pid read from its
own pointer under the scratch TMPDIR); the pointer files were mode 600.

## Port-back notes

- `src/kit/wire/discovery.ts` (Story Studio's
  `packages/kit/src/wire/discovery.ts` at `develop` `5b3bd8d` has none of
  these):
  - `readPointer`: a `latest` that fails `isPointer` or `ownedByMe` falls back
    to `newestLivePointer` (a wrong shape still throws); one naming a dead pid
    is returned as it is; a named read throws on a `session_id` mismatch or
    another user's file.
  - `isPointer` requires `Number.isInteger(pid) && pid > 0`; the old check is
    `isPointerShape`. `pidAlive` returns false for a pid of 0 or below. Story
    Studio exports `pidAlive` and uses it in `livePointers` too.
  - `newestLivePointer` skips a file whose name is not `<app>.<session_id>.json`
    (Story Studio's `livePointers` already does) and another user's file.
  - `publishPointer` writes through `writePointerFile` (random temp name, `wx`,
    mode 600). Story Studio may prefer to put this in `writeFileAtomic` itself;
    we kept ours unchanged because the shipped apps write through it.

## Related Documents

- [Kit foundation — 2026-10-13](../features/workspace-kit/sessions/2026-10-13-kit-foundation.md)
