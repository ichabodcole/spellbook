---
date: 2026-06-15
spell: bounty
rule: house-style.md → "Drive a conjuration through a daemon + thin CLI"
disposition: judgment-only
---

# Readback parity — the agent's `state` must show what the human's surface shows

## The situation

Bounty migrated to the house pattern: a daemon holds canonical state, the agent
drives it through `cli.ts` (`/cmd` write, `/state` read-back, `/events` tail),
and the browser is a WebSocket membrane. The live event path (`tail`) was given
`--mine`/`--owner` scoping, self-echo suppression, and `by`/`owner` stamps. The
surface computed and rendered blocked-ness (`⛔ blocked by N`) for the human.
The snapshot path — `state`, the command the SKILL pushes hardest as the
orient-and-confirm primitive — returned the **raw** board: unscoped, and with
only the raw `blockedBy` edge list, no computed blocked-ness.

## What the familiar concluded

The build (and its 71 green tests) treated `state` as done: it returns the
canonical board + a cursor, which is all the agent strictly _needs_ — it can
filter by `owner` itself and join `blockedBy` against the other tasks' statuses
to determine blocked-ness. Functionally complete.

## What the mage wanted instead

A live fresh-agent test (two cold workers) exposed why "functionally complete"
wasn't enough: the agent's readback was a **worse view than both neighbors
had.** The human (surface) got blocked-ness computed and a scoped board; the
live agent (`tail`) got a scoped stream — but the agent's _snapshot_ (`state`)
got the firehose and raw edges. Worse, the two gaps compound: once
`state --mine` filters the board to a worker's lane, the blocker task (owned by
someone else) is filtered _out_, so the worker can't even re-derive what it's
waiting on. The reasoning: in an agent-driven surface, the agent is a
first-class consumer, and its primary readback must not be the weakest lens on
the system. Don't hand the agent raw fields to re-derive what you already
compute for the human — reach parity.

## The distilled judgment

When you build an agent-driven surface, **the agent's snapshot readback must
reach parity with the human surface**: scope it the way the live/notification
path scopes, and **serialize the derived/computed state the surface shows**
(blocked-ness, counts, status rollups) as response-only projection — not just
the raw fields. The test of "is the readback done?" is not "can a clever agent
re-derive everything from it?" but "does it show what the human already sees?"
Parity, computed at serialize time (never stored), is the bar. A green test
suite won't catch this — only driving the surface cold as the agent does.

## Binding

- **Rule affected:** `house-style.md` → "Drive a conjuration through a daemon +
  thin CLI." This is a corollary of its read-back primitive (`GET /state`):
  read-back means **parity with the surface**, not just raw canonical state.
- **Repeal criterion:** if a future surface has no human view to reach parity
  _with_ (a purely headless conjuration), the "parity" framing dissolves — the
  readback just needs to be scoped + computed for the agent's own use.
