# Bounty: a session key can be hijacked, and a read cannot say which board answered

**Added:** 2026-08-06

Found during the `spell-hardening` P0 ratify round, by having it happen to the
team twice in forty minutes. **Not among the fourteen issues that project
covers.** Three related defects on the board-binding path, all measured, none
fixed there.

They share one shape with the rest of `spell-hardening`: **a wrong answer shaped
exactly like a right one, exit 0.**

## Acceptance Criteria

- [ ] **Any process carrying `BOUNTY_SESSION_KEY` can seize a live keyed board,
      and the CLI serves it with no signal.** `cmdOpen` (`cli.ts:384`) reads the
      ambient key; `sessionKeyToId(key, cwd)` resolves it; a second process
      takes the **idempotent-attach branch** (`cli.ts:388-397`) onto the live
      board. **Measured:** for about a minute, `bounty state` returned a
      two-card board of `X`/`Y` owned by `worker1`/`worker2` — a stranger's
      board — under the team's own key, with nothing at the read site to say so.
- [ ] **A write against the hijacked board fails with the WRONG REASON.** A seat
      running `update <id> --status doing` got **`no such task <id>`**, not
      `no running bounty session`. The task provably existed. A caller acting on
      that message would **re-create the card**. Same family as #83 — a write
      whose failure reports something other than what happened.
- [ ] **A `bounty` read cannot identify which board answered it.** Measured:
      there is **no session id, key, port or board identity anywhere** in a
      `state` response (`{state:{title,tasks},cursor}`). This is what makes the
      two defects above undetectable from the consumer side, and it forced the
      `spell-hardening` gates to pin identity out-of-band instead (`plan.md`
      G3). Consider surfacing the resolved `session_id` in the read envelope.
- [ ] **`.bounty-session` at the repo root is a second, quieter binding
      channel.** It binds _any_ unkeyed bounty verb run from this tree to the
      team board. It did not bite the gate (the pin-file tests use injected
      readers and never touch a real filesystem), but it is one `close` away
      from biting a person.

## Evidence

- Team board `k-spellbook-f4249899` died twice on 2026-08-06 (`daemon.log`,
  `reason:"close"`, `subscribers:3` then `subscribers:0`). The first is fully
  explained by the test-suite hijack — see
  [`spell-hardening` Phase 0e](../projects/spell-hardening/plan.md). **The
  second is unexplained and deliberately left unattributed**, because two wrong
  attributions-from-proximity were made and retracted the same evening.
- The stranger-board read and the misleading `no such task` were found
  independently by two seats and only resolved when the halves were put together
  — neither could see it alone.

## Notes

The **hermeticity** half (our own test suite doing the hijacking) is fixed as
`spell-hardening` Phase 0e. **This item is the rest of it:** hermetic tests stop
_our_ tests, not any other process, and they do nothing about the identity gap.

Related:
[`2026-08-06-bounty-fresh-restore-destroys-snapshot`](./2026-08-06-bounty-fresh-restore-destroys-snapshot.md),
and #85–#88 / the
[CLI-contract investigation](../investigations/2026-08-06-spell-cli-contract-investigation.md),
which decides what a read envelope owes its caller.
