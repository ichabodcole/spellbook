---
type: item
title:
  "Bounty: respawn-empty + close clobbers the snapshot (data loss, no rotation)"
status: stable
description:
  Fix potential data loss when snapshot updates clobber concurrent session
  modifications
lifecycle: backlog
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
