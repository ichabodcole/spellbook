# Census: the daemon spine, eight concerns across eight daemons

**Date:** 2026-09-08 · **Status:** census closed; feeds the backend convergence
project · **Scope:** every backend file that calls `Bun.serve` **Follows:**
[the duplication recon](./2026-09-08-backend-duplication-recon.md), whose
recommendation defined this scope

## Why this exists

The recon found the daemon spine is one design implemented six times (eight,
counting every `Bun.serve`), and named the pass that would turn that into a
decision:

> One table: for each concern, which spells have it, and which of the
> divergences are deliberate vs stale. That table is the whole decision.

**Verdict vocabulary, used throughout.** `deliberate` requires evidence — a
comment explaining the difference, a test pinning it, or a spell-specific need
that can be cited. `stale` means the copies were the same and one moved.
`unexplained` means they differ and the census could not tell which. The default
is **unexplained, not deliberate**; the easy failure of a census like this is
rationalising every difference as intentional.

Byte-identity claims below are md5 over extracted blocks, not judgement.

## The table

| concern                 | present in                                                       | verdict                                                                                                                                                                     | one implementation?                         |
| ----------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `resolveMode`           | 8/8                                                              | **no divergence** — the four code lines are byte-identical everywhere; the two md5 groups differ only by the `export` keyword                                               | **yes**, trivially                          |
| `STATIC_CONTENT_TYPES`  | 8/8                                                              | **stale** — the sole difference across all eight is `charset=utf-8` on `.html` in three spells                                                                              | **yes**, zero design content                |
| `serveDist`             | 8/8, five byte-identical                                         | **deliberate** for digestify (substitutes into the entry HTML in memory) and grapevine (surface at `/watch`, not `/`); **unexplained** for bounty's unreachable extra guard | **yes, but only the file half** — see below |
| event bus               | 6 inline + mind-mapper's module; grapevine is a different design | mixed; mind-mapper's epoch and bounded buffer are **deliberate** and better                                                                                                 | **yes for six**; grapevine cannot be served |
| `sseResponse`           | 7/8                                                              | four **deliberate** divergences with strong citations; glamour's missing timer set is **stale** and a bug                                                                   | **yes for all seven**                       |
| idle timeout + snapshot | 5 session daemons                                                | glamour/imago/magpie's subscriber-blind close is **stale** and a bug; grapevine and mind-mapper having neither is **deliberate**                                            | **yes for the five**                        |
| discovery write         | two rival conventions                                            | the split is **not adjudicable as one thing**                                                                                                                               | **no — a resemblance**                      |
| close-and-drain         | 8/8                                                              | bounty's watchdog **deliberate** and unique; glamour's shortened grace and missing sweeps **stale**                                                                         | **yes for all eight**                       |

### The one that is not one thing

Discovery writing splits into per-session tmpdir JSON (bounty, glamour, imago,
magpie) and singleton `$HOME/daemon.{port,pid}` (astrolabe, grapevine,
mind-mapper). They disagree about **what identity means** (session id vs pid),
**what the payload is** (a JSON envelope vs a bare integer), **how many readers
there are**, and **what "still ours" means at cleanup**. A signature general
enough to cover both stops being a discovery writer and becomes two primitives
that genuinely are one implementation each:

```ts
writeFileAtomic(target: string, text: string): void
unlinkIfMatches(path: string, expected: string): void
```

Above that grain, **picking one convention is a product decision, not a
factoring one**, and it is out of a census's scope.

## Convergence targets — not a merge of equals

Where one implementation is materially better, convergence should be _toward_
it:

1. **mind-mapper's `sseResponse`** — the only one with a once-only teardown
   funnel and `req.signal` wiring, and the only one whose comment records a
   **measured** result: `try { controller.enqueue() } catch` never fires on an
   orphaned stream in Bun 1.3.14, because enqueue buffers silently. **Six
   daemons' dead-client detection rests on a mechanism their own comments
   describe incorrectly.**
2. **mind-mapper's `createEventBus`** — the only bus that is a module, the only
   one with a bounded buffer and an epoch, and the only one unit-tested.
3. **bounty's `shouldIdleClose` + shutdown watchdog** — clock-free and testable;
   the watchdog is the corpus's only unconditional-termination guarantee, and it
   exists because a 23-minute hang shipped.
4. **astrolabe's heartbeat/idleTimeout coupling** — the others hardcode 15s
   against 255s and write the relationship only in prose. Astrolabe enforces
   `heartbeat ≤ idleTimeout/2` for any configured value, which is exactly the
   invariant whose violation caused the bug the ward now pins.
5. **glamour's `emitTransient`** — presence frames kept out of the replay log,
   correct in one copy of five.

## Live defects — acceptance criteria, not a work queue

**Ruled 2026-09-08 (Cole): these are NOT fixed as separate branches.** No
release is pending and the only consumer is not currently using the affected
spells. They are recorded here as **what the convergence must make impossible by
construction** — if a shared spine lands and these are still reachable, it did
not do its job.

| #   | defect                                                                                                                                                                   | correct in                                | broken in                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- | --------------------------------- |
| L1  | idle close ignores live subscribers — an agent tailing a quiet board is killed with its connection open                                                                  | astrolabe, bounty                         | glamour, imago, magpie            |
| L2  | `GET /state` does not count as activity — an agent polling in a loop is idle-closed under itself                                                                         | astrolabe, bounty, glamour                | imago, magpie                     |
| L3  | non-atomic discovery write in the **singleton** convention; grapevine's `Bun.write` is additionally **not awaited**, so it serves requests before the pointer is on disk | the four session spells (fixed `76079b6`) | astrolabe, mind-mapper, grapevine |
| L4  | glamour leaks every SSE heartbeat interval at shutdown and never closes its WebSockets — `c.close()` does not invoke the stream's `cancel()`                             | astrolabe, bounty, imago, magpie          | glamour                           |
| L5  | unbounded event buffer, grown for the daemon's life                                                                                                                      | mind-mapper (capped at 1000)              | five daemons                      |
| L6  | no epoch on the resume cursor — after a restart, `seq` restarts at 0 and a resuming client cannot distinguish a stale watermark from a fresh one                         | mind-mapper                               | five daemons                      |
| L7  | presence frames enter the replay log, so every reconnecting tail replays the whole browser-presence history                                                              | glamour                                   | four daemons                      |

⛔ **L3 exposes a blind spot in `grimoire/daemon-lifecycle-ward.test.ts`,
written the same day.** Its atomic-write clause matches
`writeFileSync(sessionFile|latestFile)` and its `readSession` clause selects on
that function name — so the entire singleton convention is invisible to both,
including `mind-mapper/scripts/cli.ts`'s `livePort()`, which returns `null` on a
torn read and is the same absent-versus-failed conflation the clause exists to
prevent. **The ward was generalised from the four copies its author had just
fixed, and reproduced the exact failure it was built to stop.** That is the
strongest available argument that a text scan over six copies is a stopgap.

## Coverage

**Read in full:** astrolabe `server.ts`, glamour `server.ts`, digestify
`review.ts`, mind-mapper `events.ts`, `grimoire/daemon-lifecycle-ward.test.ts`.

**Every spine region located, read and cited, with a full symbol index of the
file but not an end-to-end read:** bounty, imago, magpie, grapevine and
mind-mapper's servers.

**Deliberately skipped:** mind-mapper's 20 SQLite domain modules; grapevine's
channel store beyond the fan-out and subscribe paths; magpie/imago/glamour's
image and style modules; astrolabe's `state.ts`; all CLIs; all tests but the
ward.

**Named gaps.** Grapevine's HTTP route handlers were not read end to end, so a
second SSE or timer path there would have been missed — greps for
`text/event-stream` and `setInterval` returned only the one site each, which
bounds but does not eliminate it. And every `deliberate` verdict rests on
comments and on tests located but **not executed**.
