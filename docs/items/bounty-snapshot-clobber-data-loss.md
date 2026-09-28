---
type: item
title:
  "Bounty: respawn-empty + close clobbers the snapshot (data loss, no rotation)"
status: stable
description:
  Fix potential data loss when snapshot updates clobber concurrent session
  modifications
lifecycle: done
id: 019fd324-3bba-7856-8146-5d7f9f8f06e2
kind: task
generated: { by: unknown, at: 2026-08-05 }
cycle: 2026-09-data-you-cant-get-back
---

# Bounty: respawn-empty + close clobbers the snapshot (data loss, no rotation)

Two independent sessions hit the **same destructive sequence**, months apart, on
different repos. **The recovery move is what destroys the data**, which is why
it keeps happening:

1. The bounty daemon dies (see #64 — idle-death, and an external `pkill`,
   below).
2. `open --session-key K` respawns an **empty** board under the same session id
   — it does **not** hydrate from K's existing snapshot.
3. `close` on that empty board **writes 0 tasks over the good snapshot**,
   unconditionally. `~/.bounty/snapshots/k-operator-….json` went from 9 tasks to
   **35 bytes**.
4. `open --restore <id>` afterwards has nothing left to restore.

There is a **single snapshot file with no rotation**, so step 3 is terminal. One
session lost 10 completed-card histories. The other survived only because every
card mutation had been narrated on a grapevine channel and `add --id` made
faithful reseeding possible.

**The empty-fresh-session-under-the-same-id shape is what makes the clobber look
safe** — nothing about the board's appearance says "this is not your board."

## Acceptance Criteria

- [ ] **Guarded write.** A snapshot write refuses to overwrite a non-empty
      snapshot with an empty or materially smaller state without explicit
      confirmation.
- [ ] **Rotation.** Snapshots are versioned (`<session>-<ts>.json`, keep N)
      rather than a single overwrite slot — so a guard that's wrong is still
      recoverable.
- [ ] **Respawn restores by default.** `open --session-key K` over a dead board
      hydrates from K's snapshot; at minimum it warns _"snapshot for this key
      holds N tasks; live board is empty — restore?"_ rather than presenting an
      empty board as normal.
- [ ] **Tail-death visibility.** A final `daemon exiting` event on the SSE
      stream, so consumers can distinguish death from idle. Three agents' `tail`
      Monitors died silently alongside the daemon.

## Fix alongside #64

`#64` (daemon idle-dies mid-session) is the **trigger** for this sequence and is
already tracked in
[`2026-07-16-bounty-daemon-idle-death.md`](./2026-07-16-bounty-daemon-idle-death.md).
These are two halves of daemon-lifecycle robustness and want one pass — but they
are **independently worth fixing**: even with a perfectly stable daemon, an
unguarded clobbering `close` is a loaded footgun.

## Adjacent footgun — unscoped daemon kills (worth its own decision)

Multiple spells name their daemon literally `scripts/server.ts` (bounty,
mind-mapper, …), so **`pkill -f "scripts/server.ts"` is an unscoped kill across
the whole toolbox** — this is how the daemon died in #73. House-style candidate:
a unique per-spell process marker (e.g. an `--name <spell>` argv marker) so
process management can be scoped to one spell. This is a
`grimoire/house-style.md` convention question (thoth's lane), not just a bounty
fix.

## References

- `src/bounty/backend/` — daemon lifecycle, `close`, snapshot write path,
  `open --session-key` / `--restore`
- `~/.bounty/snapshots/` — the single-slot snapshot files
- Context: mind-mapper V1 session 2026-07-16 (daedalus, self-reported on the
  vine); operator team session (9-task board, session key `operator`)
- The anthill-side half is filed upstream as `ichabodcole/anthill#43` (convene
  should warn on snapshot-vs-live mismatch)

## Fixed (2026-09-28)

Worked in cycle
[Data you can't get back](../cycles/2026-09-data-you-cant-get-back.md). A
no-stake re-measure ran the sequence above first, and it no longer happens in
its August form.

**Already done before this cycle:**

- **Respawn restores by default.** `open --session-key K` over a dead board
  restores K's snapshot (b7, #97). Pinned by the existing b7 cell.
- **Guarded write**, in the form of backup-then-write rather than refusal. The
  first shrinking write of a daemon's life copies the old snapshot to
  `<id>.pre-<ts>.bak.json`.
- **Tail-death visibility.** A signal death runs the teardown and sends the
  `closed` frame, and a SIGKILLed daemon ends a live tail with `tail.lost`. The
  `tail.lost` half had no bounty cell; one now pins it, and another pins SIGTERM
  saving a mutation made inside the debounce window.

**Fixed in this cycle:** the re-measure found three new paths to the same loss,
and one gap in reporting it.

- **Two daemons for one key.** Concurrent keyed opens started two daemons under
  one id, and the one no verb could reach later wrote its stale board over newer
  work. A per-id lock taken at boot now allows one daemon per id, and a losing
  `open` reports the winner's board.
- **An unreadable snapshot was written over.** It is now copied aside
  byte-for-byte first, and a snapshot whose `tasks` is not an array is a
  `restoreFailed` instead of an empty board.
- **The backup was never named to the caller.** `close` and `open` now carry
  `snapshotBackups`, with each backup's path, task count and restore command.

**Not done here:** **Rotation** as asked (versioned snapshots, keep N) is cut,
with a retention limit, to
[item/bounty-snapshot-rotation-by-content-and-retention](./bounty-snapshot-rotation-by-content-and-retention.md).
The unscoped `pkill` footgun above is untouched.

**Follow-ups from the no-stake verifier**, fixed in this cycle:

- **No `ps` on PATH crashed instead of refusing.** The lock's liveness check ran
  `ps`, and a missing `ps` threw: `open` printed a raw Bun stack with no
  envelope, and the daemon died on `uncaughtException`. A `ps` that ran and
  failed counted the holder as live and reported "already running". Both are now
  "liveness unknown", and a lock held by a pid bounty cannot judge is never
  taken over. `open` refuses before spawning, exit 6 (`conflict`), with one
  envelope naming the lock file, the pid and why; its hint gives the recovery
  (fix `ps`, or remove a lock whose pid is not this board's daemon). A daemon
  that gets that far exits 6 before reading or writing anything, and logs
  `lockLivenessUnknown` to `daemon.log`.
- **A snapshot that could not be written silently dropped new work.** With the
  snapshot path a directory, or not writable, every write failed inside a
  "best-effort" catch, and `close` answered
  `{"ok":true,"down":true,"snapshotBackups":[]}` over a board saved nowhere. A
  failed write now dumps the board to `<id>.unsaved-<ts>.json` (in `snapshots/`,
  or in `$BOUNTY_HOME` when `snapshots/` is the problem), named as an `unsaved`
  backup. Mid-session it shows on `state.snapshotSaveFailed` and as a
  `snapshotSaveFailed` event. `close` exits 6 (`conflict`, stdout empty) naming
  the snapshot path and the dump, with the restore command in its hint: the save
  it owed did not happen, and the fix is on disk. If nothing at all can be
  written, `close` refuses and leaves the board running.
- **`open` hung forever on a daemon that was not answering.** Its liveness probe
  fetched with no timeout, so a SIGSTOPped daemon parked `open` for good and the
  "held by a running daemon (pid N) that is not answering" refusal above was
  unreachable. Every CLI-to-daemon request on the `open` and `close` paths now
  gives up after 2 s: `open` reaches that refusal (exit 1, `internal`), and
  `close` exits 1 naming the pid; both hints say to resume or end that pid. The
  requests behind `add`, `update`, `claim`, `block`, `unblock`, `remove`,
  `message`, `init` and `state` are still unbounded.

**Follow-ups from the second verifier**, fixed in this cycle:

- **A stale `unsaved` dump was still offered as a restore.** A save failed and
  dumped a 2-task board; the path healed, a third task was saved, and `close`
  exited 0 while still listing the dump with its restore command. Running it
  rolled the board back, and a later same-count close left the third task in no
  file. Once a snapshot write succeeds, an older `unsaved` dump is now
  **superseded**: it stays in `snapshotBackups` with `restore: null` and a
  `superseded` note, and stderr says there is nothing to do. The file is kept,
  not deleted: a task removed between the dump and the save exists only in the
  dump, and deleting is the caller's call.
- **Checking the other backup kinds found one more route.** `shrink` and
  `pre-fresh` copies are meant to roll back, but restoring any of them over a
  snapshot that had newer work wrote over that snapshot with no copy, unless the
  task count dropped. A board restored from another file now copies its own
  snapshot to `<id>.pre-restore-<ts>.bak.json` first, when that snapshot holds a
  task the restored board does not, and names it on `open`'s envelope with its
  restore. `unreadable` copies never had a restore act.
- **With nothing writable, only `close` was guarded.** The idle timeout ended
  the daemon and dropped the tasks that were in no file. Now, while the board is
  in no file, no request ends it: the idle timeout is held (logged as
  `idleCloseHeld`, and shown on `state` as `snapshotSaveFailed.held`) and
  retries the save each time it comes round, ending the board as a normal
  timeout once a save works; the browser's Close board is refused the same way,
  with a message on the board. Both share `close`'s guard. SIGTERM and SIGINT
  are deliberately not guarded (a signal is an order to stop), and `SKILL.md`
  says so. The other ways out need no guard: the heartbeat sweep never ends the
  daemon, and the housekeeping stop and the drain run only after one of the
  guarded requests (or a signal) has already ended it. An uncaught exception
  still exits without saving, as before. Not changed: `open --fresh` over such a
  board has its teardown `close` refused, so it attaches to the old board, with
  nothing lost but no fresh board either.
- **Two misleading texts.** With the snapshot path a directory or mode 000, the
  reported error was the copy error from setting the old file aside
  (`ENOTSUP … copyfile … .unreadable-….bak.json`); it is now the real cause
  (`EISDIR`, `EACCES`), and the file is still never written over. With
  `snapshots/` itself a file, the hint said to fix `snapshots/<id>.json`, a file
  that does not exist. `snapshotSaveFailed` now carries a `fix` naming the path
  that is actually wrong (`snapshots/` in that case), and the hints use it. The
  nothing-writable close refusal carried its act only in its message; it now has
  a `hint`, ending in the `close` to run again.

**Follow-ups from the third verifier**, fixed in this cycle by one rule rather
than a fourth case guard (decision-log row 13):

- **`pre-restore` skipped silently when it could not read or copy.** Restoring
  another board with `snapshots/` read-only (route A), or with the board's own
  snapshot mode 000 (route B), skipped the copy. Once the disk healed, a
  same-count write erased the old tasks, and `close` called the `unsaved` dump
  "superseded, nothing to do". A keyed respawn over a mode-000 snapshot lost
  tasks the same way. The cause was the same each time: a daemon wrote over a
  snapshot it had never read or kept a copy of.
- **The rule.** A daemon writes over its own snapshot only if it read that file
  at boot, wrote it itself since, or has just copied it aside. A board with no
  snapshot yet owns it. Otherwise, before its first write it copies the file to
  `<id>.unread-<ts>.bak.json`, a new `unread` backup with a restore act. If the
  copy fails, the file is not written: the board goes to the `unsaved` dump, and
  `snapshotSaveFailed.error` says the file could not be copied aside. The next
  write tries again, so once the disk heals the old board is kept before it is
  written over. A copy made at boot (`unreadable`, `pre-restore`) or by the
  shrink rotation also gives ownership, so the file is never copied twice. A
  plain open, add and close, or a keyed respawn and close, makes no copy and
  leaves no new file; a cell pins both.
- **Guards kept.** The boot `unreadable` and `pre-restore` copies stay: they
  happen at boot, so `open` can name them, and when they fail the rule catches
  the write. `pre-restore` now compares the whole board, not only `tasks`, so a
  restore that differs from the snapshot only in its title is kept first. The
  shrink rotation stays: on a board the daemon read at boot, the rule does
  nothing, and a drain still needs its copy. It no longer copies bytes that were
  just copied by another guard. The per-write `unreadable` check stays too: it
  covers a file damaged under a daemon that already owns it.
- **"superseded" is said only after a write the rule allowed.** If that write
  replaced a snapshot the daemon never read, the `unread` copy is listed beside
  the dump, with its restore.
- **Changed as a result:** `--fresh` over an existing snapshot now keeps it once
  (as `shrink` if the fresh board is smaller, else `unread`). Before, a fresh
  board that grew past the old one wrote over it with no copy.
