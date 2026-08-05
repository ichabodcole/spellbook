# Bounty: respawn-empty + close clobbers the snapshot (data loss, no rotation)

**Added:** 2026-08-05 · **Tracks:** GitHub issues
[#73](https://github.com/ichabodcole/spellbook/issues/73) and
[#74](https://github.com/ichabodcole/spellbook/issues/74)

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

- `plugins/spellbook/skills/bounty/scripts/` — daemon lifecycle, `close`,
  snapshot write path, `open --session-key` / `--restore`
- `~/.bounty/snapshots/` — the single-slot snapshot files
- Context: mind-mapper V1 session 2026-07-16 (daedalus, self-reported on the
  vine); operator team session (9-task board, session key `operator`)
- The anthill-side half is filed upstream as `ichabodcole/anthill#43` (convene
  should warn on snapshot-vs-live mismatch)
