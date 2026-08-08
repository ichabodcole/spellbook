# The tail loop's stream reader is never cancelled, so the P0f fix cannot land as a shape fix

**Found:** 2026-08-08, spell-hardening sprint 03, card `t-df17accf` (thoth).
**Status:** measured, not fixed. Deferred with evidence rather than attempted.
**Blocks:** the P0f remediation at `glamour/scripts/cli.ts:484`,
`imago/scripts/cli.ts:254`, `magpie/scripts/cli.ts:254`.

## The one-line fix replaces a truncation with a hang

Sprint 01's canon for an in-function exit is `process.exitCode` + a natural
return. At these three sites that reads `stopped = true; return;` — the loop
exits, `cmdTail` returns, `main` returns, and Bun drains stdout on the way out.

**It hangs.** The enclosing `cmdTail` takes `res.body.getReader()` and the inner
read loop `break`s out of it on both paths (`catch` and `chunk.done`) **without
`cancel()` or `releaseLock()`**. An un-cancelled reader on a still-open response
keeps the process alive, and `process.exit()` is currently the only thing ending
these tails.

## The measurement

Isolated rig, **server in its own process** so the client's exit depends solely
on client-side handles:

```
cancel   await reader.cancel() before returning     exited rc=0
leak     break out WITHOUT cancelling               HUNG  (>6s, killed)
hang     setInterval — rig control, MUST hang       HUNG  (>6s, killed)
```

`cancel` and `leak` differ by exactly one statement.

> ⚠ **A first rig said the opposite.** With the test server in the _same_
> process, `leak` reported `exited rc=0` — because stopping that server
> force-closed the socket the leak was holding. **The `hang` control fired in
> both rigs.** A passing control proves the detector works; it is silent on
> whether an arm isolates its variable. If you re-run this, keep the server out
> of process.

## Why this is the `bounty/join.ts:328` scar again

`join.ts` carries a comment recording that this exact one-line fix was tried,
measured at a 15 s hang, and reverted:

> _"`process.exit` was doing double duty: draining the payload was broken, but
> force-terminating a live socket was load-bearing. So the honest fix is a
> lifecycle change (close the socket on every path, then return naturally), not
> the one-liner — a bigger change than P0's shape fix and carded separately.
> Shipping a hang to fix a truncation is a bad trade."_

**Same double duty, same conclusion, three more sites.** The difference is that
this one was caught **before** shipping rather than after.

## The fix, when someone takes it

Cancel the reader on every path out of the inner read loop — a
`finally { await reader.cancel().catch(() => {}) }` around it — **then** the
natural return is safe. The mechanism is already proven by the `cancel` arm.

**What is NOT proven, and is the whole cost of this card:** whether cancelling
mid-stream drops frames on the happy path. That needs a real per-spell drive
against a live daemon, not a rig. Do not land the lifecycle change on the
strength of the isolated measurement alone — it establishes that cancelling
_releases the process_, not that cancelling _is safe where it is called_.

## Do not merge this with the signal-handler funnel

The `bounty/server.ts` handlers (598/605/609) look like the same defect and are
its opposite:

|                 | the funnel                              | these three                         |
| --------------- | --------------------------------------- | ----------------------------------- |
| process         | the daemon                              | the CLI                             |
| what is pending | an awaited teardown that is **skipped** | a socket that is **held**           |
| the fix         | route the handlers through the teardown | release the handle before returning |

The funnel's fix does not make this return safe, and this fix does not emit the
funnel's frame. They share a sentence — _"an exit that does not know what is
pending"_ — and a sentence is not a merge.

## Coverage while this is open

`grimoire/exit-site-inventory.test.ts` pins all 37 exit sites by
`(file, normalised text, family)`, so these three cannot be silently reworded,
moved, or joined by a fourth. **It pins the inventory, not the judgment** — it
cannot tell you a family assignment is correct, only that the ground has not
moved under the reading that produced it.
