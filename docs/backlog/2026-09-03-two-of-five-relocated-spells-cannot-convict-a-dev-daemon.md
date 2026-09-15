# 2 of 5 relocated spells cannot convict a dev-mode daemon

**Filed:** 2026-09-03 · **Measured by:** cassandra at the glamour ratify (comms
`#1122`), surfaced again by daedalus's Contract 1 re-read at finalize ·
**Horizon:** NEXT SESSION · **Home:** this file

## The gap

A `release-serve.test.ts` with a forced-dev cell (`SPELLBOOK_SURFACE_MODE=dev`)
is what proves a relocated spell's daemon **dies naming the missing surface
entry** instead of silently serving something wrong. Across the five relocated
spells:

| spell           | file                   | forced-dev cell                      |
| --------------- | ---------------------- | ------------------------------------ |
| astrolabe       | ✅                     | ✅                                   |
| imago           | ✅                     | ✅                                   |
| glamour         | ✅                     | ✅ (landed `cae26f8`)                |
| **mind-mapper** | ✅                     | **✗ — 0 occurrences of the env var** |
| **magpie**      | **✗ — no file at all** | **✗**                                |

**Two of five cannot convict a dev-mode daemon.** For those two, the failure
Contract 1 exists to prevent is unguarded.

## ⛔ The route matters more than the number

**This was measured at the ratify, written into a verdict, and nothing carried
it forward.** It re-surfaced five hours later only because a docs re-read
happened to brush it — and needed a second seat to correct the count from 1 to 2
when it did.

> A gap named in a verdict nobody re-reads is indistinguishable from a gap
> nobody found.

That is the deferred-item beat's whole thesis, demonstrated on an item that
predates the beat by one session.

## Why it is cheap now (the cost input that moved the horizon)

Set to _not scheduled_ by the lead, then moved to **next session** on two seats'
evidence — **a deferral's horizon should be set by its cost, and nobody knew the
cost until they supplied it:**

- **glamour's `plugins/spellbook/skills/glamour/tests/release-serve.test.ts` is
  the fourth port of this gate** and the first with three transports. It is a
  template, not a one-off.
- **magpie is a two-transport spell with a built backend** — so it is the
  _imago-shaped subset_: copy, delete a transport, repoint. Not a fresh test.
- **mind-mapper needs only the override cell**, not a file.
- **cassandra's `cal-release.sh` already takes a sha**, so calibrating the
  result is a command rather than a project.

## Done-when

Both spells carry a forced-dev cell that **reds when the surface entry is
absent**, demonstrated red-then-green in that order by a non-author — a cell
that has only ever been green is unrun.

## Related

- `.anthill/dev/seams.md` — Contract 1 (the dev-import specifier; its 2026-09-03
  amendment names this gap in passing)
- comms `#1122` — the original measurement
