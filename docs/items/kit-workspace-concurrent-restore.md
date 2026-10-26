---
type: item
title: Two concurrent restores of one session start two daemons
description:
  The kit's already-running check is check-then-act in the CLI and the daemon
  takes no lock, so two simultaneous open --restore calls both start and one
  daemon's writes are lost. Inherited from Story Studio 027d7a3.
status: stable
lifecycle: active
id: 01a13c64-ca08-759c-8075-f36b83fd6430
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-14 }
tags: [kit, workspace]
parent: feature/workspace-kit-follow-ups
priority: medium
cycle: 2026-10-release-6
---

# Two concurrent restores of one session start two daemons

Found by the finalize review of the
[workspace-daemon cycle](../cycles/_archive/2026-10-workspace-daemon.md)
(2026-10-14).

The kit's "already running" check (`src/kit/workspace/verbs.ts`, around
line 567) checks and then acts, in the CLI, and the daemon takes no lock. Two
`open --restore <id>` calls at the same moment both exit 0 on different ports.
The manifest then keeps only one daemon's writes, and the other's messages are
lost. Story Studio's `027d7a3` has the same check.

## Definition of done

- [x] The daemon takes an exclusive per-session lock (for example `wx` on
      `<session>/daemon.lock` holding the pid), and a second daemon refuses.
- [x] A stale lock left by a killed daemon is recovered.
- [x] A test starts two restores at once and gets one daemon.
- [ ] Offered to Story Studio on `kit-parity`.

## Done and verified

In `523ecc0e`. The daemon takes `<session>/daemon.lock`
(`src/kit/wire/daemonLock.ts`) before it reads the session or binds, and
releases it last at teardown. A second daemon refuses with `locked_by` in its
handshake.

Deliberate choices:

- **The loser gets a refusal, not an attach.** Its `open` waits for the winner
  to answer, then gives the same `conflict` a restore of an already running
  session gets: `session <id> is already running at <url>`, with the hint
  `use it: state --session <id>`. One state gives an agent one outcome, however
  the two calls were timed. An exit 0 that quietly pointed at the other daemon
  would also hide that the loser's own paths were never added.
- **Stale means a dead pid, or a reused one.** A pid is reused when
  `ps -o etime=` says its process started after the lock was written. Where `ps`
  cannot answer, a live pid counts as the holder: a refused restore can be
  retried, but two daemons on one session cannot be undone.
- **Stale recovery is guarded.** Only the starter that takes
  `daemon.lock.reap-<nonce>` may remove the stale lock, and only while the lock
  still has that nonce. A guard left by a recoverer that crashed is recovered
  the same way, one level down. The lock file appears whole, through a hard link
  from an exclusive temp file.
- **A new session takes the lock too,** straight after `create`, because its
  folder does not exist before that. Nobody can name a freshly minted id, so
  nothing can contend for it in between.

Tests:

- `src/kit/workspace/concurrentRestore.integration.test.ts`: two restores at
  once give one daemon, over three rounds. A daemon killed with SIGKILL leaves a
  lock that the next restore recovers. A clean close removes the lock.
- `src/kit/wire/daemonLock.test.ts`: a reused pid, a non-lock file, both windows
  of the recovery race forced step by step, a crashed reaper's guard, and eight
  processes racing for one stale lock.

Story Studio has the same bug at HEAD `139ba211`. In
`packages/kit/src/workspace/server.ts` (around line 1112), `boot` reads the
pointer and asks whether that daemon answers. The pointer is only published
after the port is bound, though, so two daemons that start together both see
none. That is still check-then-act, and no lock is taken.

## Port-back notes

- New `src/kit/wire/daemonLock.ts`, with no imports from outside the kit:
  `takeDaemonLock(dir)` and `releaseDaemonLock(lock)`.
- `server.ts`:
  - adds `SessionLockedError` (409, carrying `pid`);
  - `boot` locks before `WorkspaceSession.restore`, or right after `create`;
  - the lock is released in `start`'s failure path and as the last step of
    teardown;
  - `runWorkspaceDaemon` adds `locked_by` to a refused handshake.
- `verbs.ts`: when `open --restore` gets a handshake carrying `locked_by`, it
  waits for that pid's pointer to answer, then refuses as "already running at
  <url>". The old "already running" check now goes through the shared `answers`
  and `alreadyRunning` helpers.
- On Story Studio's side, its project model would key the lock on the project
  folder, and its "`open` attaches to the first" behaviour would replace the
  refusal. The lock module itself should port unchanged.
- `grimoire/kit-disk-write-ward.test.ts` counts the two helpers.
