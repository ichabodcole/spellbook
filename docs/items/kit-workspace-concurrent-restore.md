---
type: item
title: Two concurrent restores of one session start two daemons
description:
  The kit's already-running check is check-then-act in the CLI and the daemon
  takes no lock, so two simultaneous open --restore calls both start and one
  daemon's writes are lost. Inherited from Story Studio 027d7a3.
status: stable
lifecycle: done
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
- [x] Offered to Story Studio on `kit-parity` (message 55, 2026-10-25).

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

The verifier's fix round (F1, F3, F5) is in `a23c211d`:

- **A live daemon whose pointer went is found again (F1).**
  - The daemon now checks its own pointer every second, on its attention clock,
    and publishes it again if it is gone. That covers the OS cleaning the temp
    folder under a long session.
  - While its lock is held, `open` waits only for what is left of the holder's
    start window, counted from the lock's `at`, and at least 2.5 s for the
    pointer to come back. It no longer waits a fresh 45 s.
  - A holder that is up gets the usual "already running at <url>", and
    `state --session` then works.
  - A holder that does not answer is named with its pid and its lock file.
    `kill <pid>`, then `open --restore <id>`, is offered only when the pid is
    confirmed to be this session's daemon (round 3, below). No hint in that
    chain points to a verb that finds the session by its pointer, so none leads
    back to the same refusal.
  - `open`'s "does it answer" check is now bounded at 3 s. A stopped process's
    port accepts the connection and then never replies, which hung the check for
    as long as the fetch would wait.
- **A failed start releases the lock (F3).** This is now tested.
- **The id is checked before the lock (F5).** `--restore ..` no longer locks the
  folder above the sessions root.
- **Orphan guards are tidied.** The next successful take removes reap guards
  left by recoverers that died. Orphan temp files are left alone: a live
  starter's temp file is in use until its link, and nothing tells the two apart.
- **`MAX_REAP_DEPTH` stays 4.** It costs nothing, and each level needs a
  recoverer to crash at exactly that moment.

Round 3 (R1–R3) is in `954925cd`:

- **A stop verb only for a confirmed daemon (R1).** An agent acts on a hint as
  written, so `kill <pid>` must never name the wrong process. Two changes make
  sure of that:
  - **The lock records its session.** A lock naming another session holds
    nothing. A live session's folder copied with its lock therefore restores as
    its own session, and the live daemon is never named.
  - **`open` confirms the pid before it says `kill`.** All of these must hold:
    - the lock still names that pid, and was taken for this session;
    - `ps` shows the pid running this app's daemon entry;
    - its command line carries no `--restore` for another session;
    - it was running when the lock was written, so it is not a reused pid.

    Anything unconfirmed names the pid and the lock file, says what could not be
    confirmed (for example "`ps` cannot say what it is"), tells the agent not to
    stop the process on this word, and gives `ps -p <pid>` to check.

- **The pointer-repair wait is tested (R2).** The pointer test's holder is now
  older than its start window, and the fixture's attention clock is slowed to 2
  s. The 2.5 s wait for the repair is then the only thing that lets `open` find
  the daemon. Removing the wait, or cutting it to 0.5 s, turns the test red.
- **Only the session's own pointer is repaired (R3).** `publishPointer` takes
  `{ latest: false }`, so a repair never makes an older session `latest` again.
- **The test timings were not refreshed (R4).** The machine was heavily loaded
  (load average 27 to 80 on 14 cores), so the refresh is left for the lead.

Known limits:

- **F2: a mixed-build race.** A CLI built before this change, racing one built
  after it, can still start two daemons, because the old daemon takes no lock. A
  sequential mix is fine.
- **F4: a wall-clock step on Linux.** A forward step of more than 1.5 s after a
  daemon starts can make its live lock look stale. `etime` is measured from boot
  time, so the step moves the computed start past the lock's `at`.
- **The non-atomic publish (M13) is untested.** No test forces a reader to see a
  half-written lock: the hard link makes that impossible, and no test can hit
  the window.
- **A lock forged by hand can still be confirmed.** A lock written by hand
  naming this session and a time after the named process started would pass
  every check if the pid is another new (never restored) session's daemon, or
  any process whose command line contains the daemon entry. Nothing the kit
  writes produces such a lock: a copied lock names its own session.
- **No `kill` without `ps`.** Where `ps` cannot answer (Windows, a stripped
  PATH), the stop verb is never offered. A stuck daemon is then named for a
  person to judge.

Tests:

- `src/kit/workspace/concurrentRestore.integration.test.ts`:
  - two restores at once give one daemon, over three rounds;
  - a daemon killed with SIGKILL leaves a lock that the next restore recovers;
  - a clean close removes the lock;
  - a live daemon whose pointer was deleted is found and named by its URL, past
    its start window, through the repair wait alone, and `state` reaches it;
    `latest` is not put back;
  - a stuck (SIGSTOP) holder that has held the lock past a start window is named
    quickly, with a confirmed `kill` hint, and acting on that hint works;
  - a live session's folder copied with its lock restores, and the live daemon
    is left alone;
  - without `ps`, a lock naming an unrelated live process gives no `kill`;
  - a lock naming another session's healthy daemon gives no `kill`, either
    without `ps` or with a lock forged to name this session (its command line
    names its own session);
  - one test per guard of `confirmHolder` (session, daemon entry, start time),
    each passing every other guard, so only that guard keeps `kill` off: a lock
    naming no session, a live non-daemon process (`sleep`), and a process with
    the daemon entry on its command line that started after the lock. The last
    uses a `ps` shim that answers the CLI and not the daemon;
  - a start refused for a corrupt manifest leaves no lock;
  - `--restore ..` is refused 400 before any lock is taken.
- `src/kit/wire/daemonLock.test.ts`:
  - a reused pid, and a file that is not a lock;
  - a lock naming another session holds nothing;
  - both windows of the recovery race, forced step by step;
  - a crashed reaper's guard, recovered and later tidied;
  - eight processes racing for one stale lock.

Story Studio has the same bug at HEAD `139ba211`. In
`packages/kit/src/workspace/server.ts` (around line 1112), `boot` reads the
pointer and asks whether that daemon answers. The pointer is only published
after the port is bound, though, so two daemons that start together both see
none. That is still check-then-act, and no lock is taken.

## Port-back notes

- New `src/kit/wire/daemonLock.ts`, with no imports from outside the kit:
  - `takeDaemonLock(dir, elapsed?, session?)`, which records the session and
    also tidies orphan reap guards;
  - `releaseDaemonLock(lock)`;
  - `readDaemonLock(dir)`, `processCommand(pid)` and `startedBy`, which only
    read.
- `src/kit/wire/discovery.ts`: `publishPointer` takes `{ latest: false }`. This
  rebuilt every spell's dist that bundles it, with no change in behaviour.
- `server.ts`:
  - adds `SessionLockedError` (409, carrying `pid`);
  - `boot` checks the id, then locks before `WorkspaceSession.restore`, or right
    after `create`;
  - the lock is released in `start`'s failure path and as the last step of
    teardown;
  - `runWorkspaceDaemon` adds `locked_by` to a refused handshake;
  - the attention clock publishes the daemon's own pointer again if it is gone
    (`keepPointer`), never `latest`.
- `verbs.ts`:
  - when `open --restore` gets a handshake carrying `locked_by`, it waits for
    whatever remains of the holder's start window, measured from the lock's
    `at`, and at least 2.5 s;
  - if the holder answers in that time, it refuses as "already running at
    <url>";
  - if not, it names the holder's pid and lock file. It offers `kill <pid>` only
    once `confirmHolder` has shown the pid to be this session's daemon;
  - `answers` (the "does it answer" check) is bounded at 3 s.
- For Story Studio:
  - **Where the lock goes.** Its lock would sit in `projectsRoot/<id>`, which is
    the `dir` in its `server.ts` (line 1050). That is not the user's
    `_project.md` folder.
  - **When the lock is taken.** Spellbook locks a new session only after
    `create`, and that is safe only because the id was just minted. Story
    Studio's `create` can be keyed on a project id that is already known, so
    there it should lock before `create`, and the folder has to exist first.
    This ordering does not port unchanged.
  - **What the loser gets.** Story Studio's "`open` attaches to the first"
    behaviour would replace our refusal.
  - **What ports as is.** The lock module, the pointer self-repair and the
    bounded answer check.
- `grimoire/kit-disk-write-ward.test.ts` counts the two writer helpers.
  `readDaemonLock` only reads, so it is not on the ward's list, and the
  pointer's republish is the same single `publishPointer` call, still counted
  once.
