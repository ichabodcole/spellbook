# Backend convergence — proposal

**Created:** 2026-09-08 · **Status:** scoped, not started · **Ruled by:** Cole
**Evidence:** three investigations, all 2026-09-08 —
[the recon](../../investigations/2026-09-08-backend-duplication-recon.md),
[the spine census](../../investigations/2026-09-08-daemon-spine-census.md),
[the tail convergence design](../../investigations/2026-09-08-tail-reader-convergence.md)

## The problem, stated once

Eight spells' backends independently implement one design. The daemon spine —
event bus, `sseResponse`, dist serving, housekeeping, close-and-drain — is one
design written six times; the CLI's SSE tail reader is one protocol client
written seven times.

**The cost is not the duplicated lines.** The first census priced extraction at
~100 lines repo-wide and correctly concluded that justified nothing. The cost is
that **a fix costs six edits and reliably gets one to four of them**, and there
are roughly fifteen verified instances of exactly that standing in the tree
today.

The copying is not even hidden. The same explanatory comment appears verbatim in
four files, another in seven, and the prose names what it copied from — _"as
imago does it"_, _"magpie's taxonomy, bounty's delivery"_, _"astrolabe's
pattern, via mind-mapper"_. **The house knew it was copying and had no way to
share**, because a source-shipped backend cannot import from `src/kit/`: the
specifier dangles on a consumer's machine.

That blocker is gone. Contract 3's 2026-09-04 amendment made the criterion _a
backend that imports from outside its own deployed skill folder MUST build_, and
records the direction: **"Every spell gets a build. The open question is ORDER,
not WHETHER."** The census's one unpriced obstacle — bounty and grapevine having
no `src/` at all — was paid off by the three surface ports of 2026-09-05→07.

## Rulings

All ruled by Cole, 2026-09-08. Options not taken are in
[the decision log](./decision-log.md).

- **D1 — Prove the spine on the two that already build.** Astrolabe and magpie
  build their CLIs and already share `printJson`, so they can adopt new shared
  modules at **zero migration cost**. That settles the module boundaries against
  real consumers before anyone pays a migration.
- **D2 — The whole backend builds.** Not the CLI entry only. The duplication is
  worst on the daemon side; building only the CLI forfeits five of the eight
  spine concerns permanently.
- **D3 — Both discovery conventions survive, each as one implementation.**
  Session-JSON serves the multi-session spells, singleton `port`/`pid` serves
  the standing daemons; they encode genuinely different models. What gets shared
  is the two primitives underneath, which is where the defect lives anyway.
- **D4 — The live defects are acceptance criteria, not a work queue.** No
  release is pending and the only consumer is not currently using the affected
  spells. They are not fixed as separate branches; they must become impossible
  by construction.
- **D5 — Naming and layout of the shared modules is deferred to
  implementation.** Decide the directory from the modules, not before them.
  `src/kit/lib/` today holds a backend-only emitter beside a surface-only
  helper, so it is a residual category rather than a category, and the useful
  cut may be contract-versus- utility rather than audience.

## What gets shared

From the two censuses, with signatures already drafted there:

| module                                | serves | note                                                               |
| ------------------------------------- | ------ | ------------------------------------------------------------------ |
| `resolveMode(distDir)`                | 8      | byte-identical in all eight today                                  |
| `contentTypeFor(ext)`                 | 8      | the only divergence is a stale charset                             |
| `serveFromDist(distDir, rel)`         | 8      | **the file half only** — URL→filename mapping stays in each router |
| `createEventLog<T>()`                 | 6      | converge toward mind-mapper's: bounded buffer, epoch               |
| `sseResponse()`                       | 7      | converge toward mind-mapper's teardown funnel                      |
| `startHousekeeping()`                 | 5      | `subscriberCount` must be **required**, which closes L1            |
| `drainAndStop()`                      | 8      | bounty's watchdog wraps it rather than being a field               |
| `writeFileAtomic` / `unlinkIfMatches` | 7      | the shared half of D3                                              |
| `tailEvents<Ev>()`                    | 7      | `resolve` is a callback, not a URL — this is the whole design      |
| the CLI error contract                | 8      | `CliError` / `die` / `EXIT_FOR`; `printJson` is already shared     |

**Convergence is toward the best sibling, not a merge of equals.** Mind-mapper's
`sseResponse` and event bus, bounty's idle logic and shutdown watchdog,
astrolabe's heartbeat/idleTimeout coupling, glamour's transient channel.

**Grapevine's event bus cannot be served** — its replay reads a durable `.jsonl`
off disk and its subscriber records carry presence metadata. Named and left out.

## Phases

**Phase 0 — instruments, before anything moves.** Contract 3's criterion,
`dist-check`, and the four wards that observe an arriving spell. Also: confirm
whether building drags `acc` conformance in front of the four spells that have
no `acc.config.json` (bounty, digestify, grapevine, imago). If it does, that is
a dependency to price, not a surprise to absorb mid-phase.

**Phase 1 — the shared spine, proven on astrolabe and magpie.** Both already
build; neither pays a migration. Ends with the module set adopted by two real
consumers and their behaviour unchanged.

**Phase 2 — the migration pathfinder.** One source-shipped spell takes the whole
backend into `src/<spell>/backend/`, emits `dist/`, keeps a launcher, and adopts
the Phase 1 modules. **Glamour is the recommended subject**: it has an
`acc.config.json`, it is mid-sized, it is a fork of the imago line so the
pattern transfers, and Cole is not currently using it, so the blast radius of
getting it wrong is small. Its journal becomes a playbook phase, exactly as the
surface ports produced Phases R and S.

**Phases 3–N — the roll**, against that playbook, ordered by ascending risk:
imago, bounty, digestify, then astrolabe's and magpie's daemon halves, then the
two hard ones — grapevine and mind-mapper, which share least and are largest.

## Done means

The convergence is finished when the defects the censuses recorded are
**unreachable**, not merely fixed. Concretely:

- The seven spine defects (L1–L7) and eight tail defects (B1–B8) cannot recur,
  because there is one implementation to get right.
- `grimoire/daemon-lifecycle-ward.test.ts` is **deleted**. It is a text scan
  over six copies — what you build when you cannot have one implementation — and
  it says so in its own header. Its deletion is a deliverable, not a side
  effect.
- `mind-mapper/scripts/tail.test.ts`, today the only executable specification of
  tail behaviour in the repo, is **re-pointed at the shared client rather than
  rewritten**. Those four tests are the acceptance criteria for the tail half.
- Every spell's backend builds, and `dist-check` is green with the backend
  entries in the roster.

## What this deliberately does not reach

- **The surfaces.** They have their own story and their own playbook phases.
- **The micro-utilities** — `openBrowser`, `randHex`, `MIME_BY_EXT`,
  `readStdin`, filename sanitizers. Real, numerous, and the least interesting; a
  decision about the spine settles them as a side effect.
- **Choosing one discovery convention** (D3).
- **Epoch resume for the five daemons that cannot do it.** The client carries
  the hook; the daemons must learn to stamp an epoch first. Named as a
  dependency, not smuggled in.
- **Grapevine's tail keeping its own loop**, if serving it ever needs a fifth
  escape hatch beyond `accept`/`render`/`firstFrame`/`resolve`. Stated up front
  rather than discovered at implementation time.

## The risk worth naming

**Five copies of the `P0f SHAPE B` comment are load-bearing documentation of a
real bug** — a 23-minute hang that shipped. Collapsing seven tails into one
collapses that reasoning into one place. That is the point, but the comments
must be **re-homed onto the shared client, not deleted**. The same is true of
bounty's `shouldIdleClose` rationale and mind-mapper's measured Bun finding. A
convergence that loses the scars re-earns them.
