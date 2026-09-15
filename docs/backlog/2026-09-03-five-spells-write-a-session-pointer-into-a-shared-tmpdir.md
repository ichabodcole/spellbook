# Five spells write a session pointer into a shared `tmpdir()` namespace

**Filed:** 2026-09-03 · **Found by:** circe (glamour port, cold read of her own
lane) · **Scope:** repo-wide, ruled OUT of the glamour port · **n = 5**

## The defect

`plugins/spellbook/skills/glamour/scripts/server.ts:460` writes
`tmpdir()/glamour-latest.json` **unconditionally** — a "latest session" pointer
in a namespace shared by every process on the machine, keyed only by spell name.
glamour is the **fifth** spell doing this.

## ⛔ MEASURED: the test suite DELETES the pointer, it does not merely overwrite it

_cassandra, 2026-09-03, worktree at `380713c`. Harness is three lines and
re-runs at any sha; evidence in the session scratchpad._

Plant a live daemon's pointer at `$TMPDIR/glamour-latest.json`, run
`bun test tests/daemon.integration.test.ts` with that `TMPDIR`: **16 pass / 0
fail, and the pointer is GONE — not overwritten, absent.**

The mechanism, read in source _after_ the measurement:

1. `server.ts:460` writes `latestFile` **unconditionally at boot** — the user's
   pointer is overwritten with the test daemon's session id. **This is the
   damage.**
2. `server.ts:510-512` at close reads it back and unlinks **iff**
   `parsed.session_id === sessionId` — which is now **true, because step 1 just
   wrote it.**

**The ownership guard on the DELETE is correct. The collision happened at
CLAIM.** That is `house-style.md`'s `drive-conjuration-through-daemon` boundary
check verbatim: _ownership-of-the-delete is not ownership-of-the-namespace._

**The cost, in the terms it will be met in:** run glamour's tests — or just
`bun run gate` — while a real glamour session is open, and `glamour state` with
no `--session` resolves nothing. The daemon is **alive and unreachable by
default discovery**. No red, no warning; `exit 5 not_found` on the next verb.

It also runs the other way: a human running the spell normally writes a pointer
a later test run reads as real state.

## The instance already paid for

During spell-kit sprint 03, running magpie's daemon for a visual check
contaminated the test suite: `$TMPDIR/magpie-latest.json` broke a test asserting
that no session exists. Same defect, different spell, diagnosed then as a magpie
quirk rather than as a class.

## Why it is filed and not fixed

Ruled out of scope for `glamour-conversion` (2026-09-03): repo-wide, touches
five spells' daemons, and the port's ABSENT list forbids backend rewrites. circe
scoped `TMPDIR` as well as `GLAMOUR_HOME` in the two cells her lane adds, which
closes the port's own exposure without touching the defect.

**The fixture-side half IS in scope and is being fixed** (ruled 2026-09-03):
`daemon.integration.test.ts` gains the same `TMPDIR = mkdtempSync(...)` line
beside its existing `GLAMOUR_HOME` scoping. One line, in a test glamour already
ships. That stops **the suite** eating a live session; it does nothing for two
concurrent user sessions, which is what the spell-side fix below is for.

## What a fix would have to decide

`house-style.md`'s boundary check names the shared-namespace hazard already, so
the rule exists and five spells predate or ignore it. A fix must choose:

1. **Scope the pointer** — key it on the session/home dir rather than the spell
   name, so a test's pointer cannot collide with a human's.
2. **Or make the write conditional** on not being under a scoped home.

Option 1 is the one consistent with how `*_HOME` already isolates the data; the
pointer is simply the one piece of state that was never moved inside it.

## Related

- `docs/backlog/2026-09-02-nothing-can-tell-a-move-from-a-copy.md`
- `grimoire/house-style.md` — the shared-namespace boundary check
