# Bounty: `--fresh --restore` destroys the snapshot it is meant to restore from

**Added:** 2026-08-06

**This is a data-loss defect and it arguably outranks #80.1.** Found during the
`spell-hardening` P0 ratify round, on the one claim the project's HANDOFF had
flagged as still-unverified and load-bearing.

The `spell-hardening` project **strikes the instruction** that would have told
users to run this (D3's corrective-verb half) — but it does **not fix the
verb.** That is this item.

## The measurement

Race-free construction, throwaway key, precondition asserted as its own cell:

```
PRECONDITION      live=0  snapshot=2      <- VALID CONTROL (could have come out otherwise)

open --session-key K --restore <id>
  EXIT 0 · occurrences of "restore" in stdout+stderr: 0
  live AFTER = 0        -> --restore was INERT on the attach path

open --session-key K --fresh --restore <id>
  EXIT 0
  live AFTER = 0        -> did NOT restore
  snapshot AFTER = 0    -> AND THE SNAPSHOT IS GONE
```

## The mechanism — this is #73, load-bearing

`cli.ts:398-408`, the `live && flags.fresh` branch, tears the board down by
sending **`POST /cmd {type:"close"}`**. **`close` writes the snapshot.** The
board being closed is the **empty** one, so close flushes `live(0)` over
`snapshot(2)`. `--restore` _is_ then correctly appended at `cli.ts:415` and the
new daemon _does_ restore — **from a snapshot emptied ~200ms earlier.**

**The teardown and the restore are wired to the same file in the wrong order.**
`--restore` is not ignored on this path; it is honoured against a corpse the
teardown just made.

## Acceptance Criteria

- [ ] **`--fresh --restore` restores the snapshot's contents**, or refuses.
      Ordering fix: the teardown must not flush live state over the snapshot it
      is about to read — snapshot the _restore source_ before closing, or tear
      down without a snapshot-writing `close`.
- [ ] **A regression test pinning it**, with the precondition (`live=0`,
      `snapshot=N`) asserted as its own cell so the gate fails when the number
      it depends on is stale rather than silently comparing against it.
- [ ] **Once it is safe, revisit D3's refusal message.** `spell-hardening` ships
      a refusal that names **no** corrective verb, because there is currently no
      safe one. When there is, the refusal can name it.

## Why it matters more than the exit code

A user in the exact situation the refusal is written for — **live board empty,
real data only in the snapshot** — would follow the instruction and **destroy
the only copy**, converting a recoverable state into an unrecoverable one.

The only sequence measured to preserve the snapshot is **`kill -9 <pid>` + a
plain keyed `open`**. ⚠ Read the PID with
`pgrep -f -- "--id <unique-session-id>"`, never from the discovery file (it
carries `url`/`port`/`session_id`/`title` and **no PID**, so a kill built on it
silently no-ops) and never with a bare `pkill` on the shared `scripts/server.ts`
argv, which has already cost this repo a live daemon.

## Notes

Related:
[`2026-08-06-bounty-session-key-hijack-and-identity`](./2026-08-06-bounty-session-key-hijack-and-identity.md),
`spell-hardening` Phase 0b and Phase 1 (#73's backup-then-write guard, which
would have made this survivable).
