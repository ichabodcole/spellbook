---
type: item
title:
  "`astrolabe close` exits 0 carrying an error envelope — wrong on both axes,
  and they cancel"
status: stable
description:
  Fix astrolabe close to return non-zero exit code when returning error envelope
lifecycle: done
id: 019feeaa-e8f0-724d-96f4-6765e4ebd9a1
kind: task
generated: { by: unknown, at: 2026-08-10 }
cycle: 2026-09-filed-is-not-fixed
parent: feature/spell-hardening
---

# `astrolabe close` exits 0 carrying an error envelope — wrong on both axes, and they cancel

**Filed:** 2026-08-10 · **Status:** open, unsized · **Board card:** `s5-8` ·
**Scope ruling:** OUT of sprint 05 — a fix, not a gate

> ⚠ **RELAY.** Found by `thoth` (VERIFIED BY HIM at HEAD, unpiped) while trying
> to kill his own predicate; calibrated by `cassandra`, whose measurements
> corrected the original diagnosis. **Everything below is TAKEN ON REPORT** by
> the author of this file, who re-ran none of it.

## The defect

`plugins/spellbook/skills/astrolabe/scripts/cli.ts:362` — `cmdClose`
short-circuits with a hand-built envelope and returns, so it never reaches
`cmd()`, which is where the `#85` fix lives 240 lines up in the same file.

```
$ astrolabe close        # no daemon running
exit=0  {"ok":true,"applied":false,"error":"no daemon running"}

cmd(), the #85 discipline:
if (!r.applied && r.error) die(r.error);   // applied:false + error == rejection -> non-zero
```

**Wrong on both axes, and the two errors cancel:**

- By the `#85` fix's own stated discipline this payload is a **rejection** and
  must exit non-zero. It exits **0**.
- By the semantics it is a **benign no-op** (you asked to close; it is already
  closed), so it should carry an `outcome` noun and **no** error. It carries an
  error and no noun.

Mis-shaped as a rejection **and** mis-exited as a success — which is exactly why
it looks fine and why nothing caught it.

## ⛔ The original diagnosis was wrong and would send the next reader hunting a ghost

The first write-up said _"the fix landed in the shared helper while a
hand-rolled sibling kept the old shape"_, implying `cmdClose` **diverged** at
`3d863d5`.

**cassandra ran the pre-fix world** in a detached worktree at `a354db4` (the
fix's parent) and found `"no daemon running"` **already present** at
`cli.ts:353`.

> `cmdClose` was **already** divergent. The fix simply never reached it.

So the question is not _"what did the #85 fix miss"_ — it is **"why does
`cmdClose` bypass `cmd()` at all"**. Anyone picking this up under the old
framing will look for a regression that does not exist.

## Two measurements that constrain how any check for this must be written

**1. There is no envelope at all on the rejection path.** `die()` (`cli.ts:44`)
writes prose to **stderr** and exits 2; **stdout is zero bytes.** That is a
_third_ state, not "an envelope missing a field". A check that `JSON.parse`s
stdout hits the empty string here — throw and it is red for the wrong reason;
catch-and-skip and the row is decoration. **Any cell must name the no-envelope
state explicitly.**

**2. The fixture trap.** `astrolabe close` **returns before the daemon is
down**, so a check written the obvious way (`close; close`) gets
`{"ok":true,"applied":true}` and **passes vacuously.** cassandra was one step
from reporting that this does not reproduce. Any cell must assert the daemon is
down as its own **printed** precondition.

⚠ **Second spell with that race.** `bounty`'s `b14` is the first. Whether the
close-returns-before-down race is one house-wide defect or two local ones is not
settled here and is worth someone asking deliberately rather than discovering a
third time.

## Scope, with a number

C′'s non-zero-side clause does not convict this site specifically — **it
convicts astrolabe's entire error channel, 15 `die(` sites.** Whether
stderr-prose rejections are contract-conforming is a **canon** question
(thoth's, in scope for sprint 05); the 15 repairs are out of sprint 05
regardless of how it is ruled.

## ⛔ Sequencing — do not fix this without checking whether it is still load-bearing

Ruled by prospero: at the time of filing this was the **only live arm** of
thoth's predicate C. C's other conviction is TAKEN ON REPORT from a commit
message and a reconstructed tree. **Fixing this drains the last live instance a
check was calibrated against** — which is H1's mechanism with the sign flipped,
done deliberately, hours after measuring that it had not happened on its own.

The dependency may have lapsed by the time anyone reads this. **Check before you
cut**, and if it has lapsed, say so rather than assuming.

## Note from the acc-conformance migration (2026-09-26)

astrolabe's CLI moved onto the kit registry
([item](acc-conformance-astrolabe.md)). `close` is now a registry row, but its
handler (`cmdClose` in `src/astrolabe/backend/cli.ts`) is unchanged: with no
daemon it still prints `{ok:true, applied:false, error:"no daemon running"}` at
exit 0. The migration did not route it through `die` on purpose — which of the
two shapes is right (a rejection, or a benign no-op with an `outcome` noun) is
the product question this item asks, and Cole ruled product behaviour comes
after acc. The fix is one line in `cmdClose` either way.

## Fixed (2026-09-27)

Branch `fix/astrolabe-close-noop`, cycle `2026-09-filed-is-not-fixed`.

**The sequencing constraint has lapsed, checked rather than assumed.** A grep of
`grimoire/`, `scripts/` and `tests/` for the site (`cmdClose`,
`"no daemon running"`, `s5-8`) finds no ward or check that reads it; the only
grimoire mention of `astrolabe close` is `grimoire/tail-since-refusal.test.ts`'s
`afterAll`, which runs it as cleanup and ignores its output. The
[re-measure](../features/spell-hardening/sprints/06-filed-is-not-fixed/remeasure.md)
reached the same verdict.

**Which shape:** the benign no-op (the lead's 2026-09-27 ruling). `cmdClose` in
`src/astrolabe/backend/cli.ts` now:

- **No daemon, or a stale port file** (nothing answers on it) →
  `{"ok":true,"applied":false,"outcome":"already-closed"}`, exit 0, **no `error`
  key**. The noun follows astrolabe's own `already-<state>` family
  (`already-connected`/`-disconnected`, `already-raised`/`-cleared`) and the
  contract's own examples (`already-running`, `already-current`); the contract
  names no close-specific noun, so this is the nearest spelling rather than a
  new one. It names the state (closed) that made the work unnecessary, and a
  caller can pick its next act from it alone (open, if it wants a board).
- **A live daemon** → the close goes through `cmd()`'s discipline (applied:false
  with an error dies), then **waits up to 3s (80 ms polls, bounty `b14`'s bound)
  until the daemon stops answering** before printing
  `{"ok":true,"applied":true}`. So `close; close` is applied, then the no-op —
  the fixture trap is gone.
- **Still answering at the bound** → a failure, not a success: `internal`, exit
  1, stdout empty, message "close was acknowledged but the daemon was still
  answering after 3s". Chosen over bounty's `ok:true, down:false` because an
  `applied:true` that has not completed is exactly the act-not-completion lie
  this item is about; a wedged teardown is the spell's fault, hence `internal`.

Tests in `src/astrolabe/backend/cli.test.ts` (all four failed on `8eccceb6`,
pass now): no daemon; stale port file; close-then-close with the daemon-down
precondition **asserted as its own step** against a fake daemon that tears down
500 ms after the ack; and a daemon that never goes down (exit 1, `internal`).
Driven by hand through the shipped launcher against a real daemon: `close`
(none) → no-op exit 0; `open; close` → applied:true, `info` → `running:false`
immediately; `close` → no-op; SIGTERM the daemon (port file left) → `close` →
no-op exit 0.

Not in scope, unchanged: the other `die(` sites and the stderr-prose question
(C′'s unratified clause).
