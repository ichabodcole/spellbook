# Backend convergence — proposal

> **ARCHIVED 2026-09-10.** All eight spells build their whole backend and share
> one spine. The roll is complete and independently verified: gate 2,022 pass /
> 0 fail unpiped, `dist-check` green on all three arms, 16 of 16 shipped entries
> genuine launchers, no source-shipped backend anywhere in the roster.
>
> **Two of this document's four "done means" criteria were overturned by ruling
> rather than met** — the ward was kept (D87) and `tail.test.ts` became the
> port's oracle rather than being re-pointed (D82/D86). Both departures are
> recorded in the amendment block below, because a criterion that was changed
> and a criterion that was missed look identical to a future reader.
>
> **What outlived this project lives elsewhere, deliberately:** the open
> inventory moved to
> [`docs/architecture/house-conformance-register.md`](../../../architecture/house-conformance-register.md)
> (33 open rows, spanning eight spells) so that archiving this folder could not
> bury it — including B1/B2, the epoch parameter, which this proposal excluded
> **by name** as a dependency rather than smuggling it into scope. The method
> lives in
> [Phase B of the porting playbook](../../../playbooks/porting-a-spell-playbook.md),
> whose population is now closed. The architecture doc that describes the result
> is
> [`docs/architecture/spell-backend-architecture.md`](../../../architecture/spell-backend-architecture.md),
> and its prose is **unassigned** (D95).

**Created:** 2026-09-08 · **Last Updated:** 2026-09-10 · **Status:** ⛔
**COMPLETE — all eight spells ported, 2026-09-08→09; the record closed
2026-09-10** · **Ruled by:** Cole

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

### ⛔ AMENDMENT, 2026-09-10 — two of the four criteria were OVERTURNED BY RULING, and neither departure was discoverable from here

**This block exists because the defect was not the departures. Both were well
argued, in the right place, by the port that met the condition. The defect is
that a reader of the criterion could not find out** — the argument lived in the
decision log and the register, and the sentence stating the criterion went on
asserting it. Criteria 1 and 4 stand as written; criterion 1's evidence is the
ledger below.

- ⛔ **Criterion 2 — "`grimoire/daemon-lifecycle-ward.test.ts` is DELETED" — is
  OVERTURNED. The ward is KEPT** (D87; register **F2**, 2026-09-09). Its stated
  condition ("when the backends build and share a spine") became true at
  mind-mapper's port; its **reasoned** condition ("these properties become true
  by construction") did not, for **one of its three clauses**. `idleTimeout` is
  passed at each daemon's own `Bun.serve` call and **no kit module owns it** —
  `src/kit/wire/heartbeat.ts` supplies the constant, the parse and the clamp and
  cannot supply the option, because the kit never calls `Bun.serve` — so a ninth
  daemon that omits it still drops every SSE client at ten seconds.
  `readSession`'s ENOENT branch never converged at all (four CLIs still carry
  their own). Only the atomic write became true by construction, and **that
  clause's population is now EMPTY**, which is filed as register **C9** and
  which D91 then found the ward's own zero-population guard cannot see. The
  reason is written into the ward's own header (`daemon-lifecycle-ward.test.ts`
  l.36–40); the deletion is now pending on clause 1 finding a home that owns the
  `Bun.serve` options, which is a kit question rather than a port's. ⚠ **The
  transferable half: a stopgap's deletion condition is usually written as an
  EVENT and meant as a PROPERTY. Check the property.**
- ⛔ **Criterion 3 — "`mind-mapper/scripts/tail.test.ts` is RE-POINTED at the
  shared client" — is OVERTURNED, and the verb was UNEXECUTABLE** (D82, D86;
  register **B7/F3**, 2026-09-09). That suite **imports nothing from the spell**
  and reaches the CLI by `Bun.spawn` against a scripted fake server, so there
  was no import to re-point. It was ruled the port's **ORACLE** instead — left
  alone, green either side of the swap (4 cells / 16 assertions, 1,249 ms →
  1,250 ms) — **with exactly one recorded edit, because its fake server is a
  WRITER of the wire**: adopting `createEventLog` renamed the cursor field, D81
  priced that rename by counting READERS, and a fixture standing in for the
  daemon was in no count. The four cells' subjects are untouched; the fixture's
  schema moved. The file is now `src/mind-mapper/backend/tail.test.ts` — **the
  path this criterion names no longer exists.** It also caught a
  `ReferenceError` that `biome` passes and `bun run build` exits 0 over, closed
  in the gate by D88.

## ⛔ The defect ledger — L1–L7 and B1–B8, one row each

**This is criterion 1's evidence, and until 2026-09-10 nothing in the tree
carried it.** The criterion — _"the seven spine defects and eight tail defects
cannot recur, because there is one implementation to get right"_ — is the
project's headline claim, and it was the only one with no ledger: the verdicts
existed, scattered across six module headers, four session documents and two
phase journals, and no document mapped the fifteen to an outcome. Built here,
where the criterion is.

**Read the two verdict columns as different claims.** _By construction_ means a
caller cannot re-express the defect — the shape of the shared module forbids it.
_By convention_ means the shared module made the right thing easy and one answer
canonical, but a caller can still get it wrong, so the closure is only as good
as the eight call sites. **Three rows close by convention and one closes only
opt-in**, and that distinction is the honest reading of "cannot recur".

### The spine — L1–L7 (`docs/investigations/2026-09-08-daemon-spine-census.md`)

| #      | verdict                                                                           | closed by                                      | evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------ | --------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **L1** | ✅ CLOSED — **construction**                                                      | `kit/wire/housekeeping.ts`                     | `subscriberCount` is a **REQUIRED** argument of `shouldIdleClose` (`housekeeping.ts:72-79`) and of `HousekeepingOptions` (`:83`), so there is no overload that cannot see its subscribers. Cell: `housekeeping.test.ts:8` "⛔ L1 — A LIVE SUBSCRIBER KEEPS THE DAEMON OPEN". Driven on real daemons at glamour and imago.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **L2** | ✅ CLOSED — **convention**                                                        | `kit/wire/housekeeping.ts`                     | ⚠ **The kit cannot close this one.** `idleMs()` and `touch()` are supplied BY THE CALLER, so "what counts as activity" is the daemon's answer, not the module's — the adoption is what made it _one_ question instead of a property of whichever route the author remembered. Named in code at `src/imago/backend/server.ts:1413-1421` (the one-word fix, and the comment says so) and at `src/bounty/backend/server.ts:1763-1764` (already correct, "not this module's doing"). Driven at imago: a 2 s `/state` poll held a `--timeout 4` daemon for 14 s.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **L3** | ✅ CLOSED — **construction**                                                      | `kit/wire/discovery.ts`                        | `discovery.ts:11-20` names L3 and says "CLOSED BY CONSTRUCTION"; `writeFileAtomic` is the only write. Cells: `discovery.test.ts:16,23,31`. Seven pointer-writing daemons now call it — which is exactly what emptied register **C9**'s population.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **L4** | ✅ CLOSED — **construction + convention**, and **named by no document until now** | `kit/wire/sse.ts` + `kit/wire/housekeeping.ts` | ⛔ **The only one of the fifteen with no verdict anywhere in the tree** — not in a module header, not in a session document, not in a journal (verified 2026-09-10 by grep for `L4` across `src/`, `grimoire/` and `docs/`). Settled here, from the tree, in its two halves. **The heartbeat-interval leak closes by construction:** the keepalive timer is created inside `sseResponse` (`sse.ts:276`) and cleared in the once-only `teardown` (`sse.ts:224-227`), so it is not reachable from outside and cannot be forgotten — `sse.ts:123-127` is the paragraph that records why the copies' parallel `Set` of timers is gone. **The unclosed WebSockets close by convention:** `drainAndStop`'s `sockets` is OPTIONAL (`housekeeping.ts:144`, iterated at `:217-218`) and glamour passes it (`src/glamour/backend/server.ts:642`, `drainAndStop({ server, clients: sseClients, sockets })`), so a ninth daemon with sockets and no argument leaks them again. Cell: `housekeeping.test.ts:103` "closes every tail and socket, then stops the server". |
| **L5** | ✅ CLOSED — **construction**                                                      | `kit/wire/eventLog.ts`                         | `eventLog.ts:50` — "**1 · L5 — the buffer is bounded**". Cell: `eventLog.test.ts:78` "the replay window is BOUNDED — census defect L5". Driven at imago with 1,100 frames: cursor 1101, replay from `since=0` exactly 1000, oldest id 102.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **L6** | ⚠ **CLOSED ONLY OPT-IN**                                                          | `kit/wire/eventLog.ts`                         | ⛔ **The module says so about itself:** `eventLog.ts:16` — "`epoch` is OPTIONAL here, **so L6 is closed only for a caller that asks**" — and `:54`, "L6 — a frame carries an epoch, WHEN THE CALLER ASKS FOR ONE (opt-in)". **Measured 2026-09-10: two of the six adopters stamp one** — astrolabe (`server.ts:234`, `createEventLog({ epoch: crypto.randomUUID() })`) and mind-mapper (`events.ts:169`, `{ epoch }`, kept REQUIRED locally). **Four stamp none** — bounty (`server.ts:824`), glamour (`server.ts:149`), imago (`server.ts:528`), magpie (`server.ts:215`) — each by ruling, not omission (D39: a session-scoped daemon stamps no epoch; D48, D70). grapevine keeps its own log (REJECT-STRUCTURAL, D68) and digestify has no log at all. Cells: `eventLog.test.ts:26,33`. **The residue is register B1/B2**, which now live in the house register rather than in this folder.                                                                                                                                                             |
| **L7** | ✅ CLOSED — **construction**                                                      | `kit/wire/sse.ts`                              | The transient channel: `SseClient.send` puts a frame on the live streams without it entering the replay log. Named in code at `src/imago/backend/server.ts:549-556` and `src/bounty/backend/server.ts:1055-1064` ("⛔ THIS CLOSES CENSUS DEFECT L7 AND IT IS A WIRE-OBSERVABLE CHANGE"), and at `phase-7-journal.md:239` for mind-mapper. Driven at imago: after one connect+disconnect the replay holds exactly one frame, `ready`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### The tail — B1–B8 (`docs/investigations/2026-09-08-tail-reader-convergence.md`)

⚠ **These `B` numbers are the CENSUS's. Three other `B` namespaces exist in this
project and none of them is this one** — the register's section B ("the spine is
not finished"), the playbook's Phase B steps B0–B10, and grapevine's own
inventory rows. Read `B7` below as _the tail cursor assigns rather than taking a
max_, not as register B7 or playbook step B7.

| #      | verdict                                                                    | closed by                | evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------ | -------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **B1** | ✅ CLOSED — **construction**, with a NAMED RESIDUE                         | `kit/wire/tailEvents.ts` | "Where is the daemon" is a **callback**, not a URL (`tailEvents.ts:15-19`, `:137`, called at `:402` before every attempt). Cell: `tailEvents.test.ts:118` "resolve is called before EVERY attempt, so a moved daemon is followed". ⛔ **Driven and seen to FAIL FIRST** in `src/astrolabe/backend/cli.test.ts`: against the unfixed CLI the post-restart read was EMPTY after the full 15 s window; against the shared client it passes in 279 ms. Independently re-driven against the `5b52e95` control. ⚠ **The residue is register B1** — a restart at cursor EQUALITY leaves a tail connected-and-silent (D23), which is epoch-shaped and must be designed against all seven tails at once. **The port defect is closed; the equality gap is deferred, and they are not the same claim.**                                                                                                                                                                                                                                                                                                                                                                      |
| **B2** | ✅ CLOSED — **construction**                                               | `kit/wire/tailEvents.ts` | The idle watchdog is a property of the one client (`idleMs`, default 45 s, `tailEvents.ts:212`), and comments feed it BEFORE frame selection (`:505-510`) so a quiet-but-live stream survives. Cells: `tailEvents.test.ts:144,167`. Independently driven: control parked forever on one `/events` request; HEAD reconnected at +47.4 / +92.6 / +137.9 s.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **B3** | ✅ CLOSED — **construction**                                               | `kit/wire/tailEvents.ts` | The signal handlers end the tail cleanly instead of `process.exit`ing (`tailEvents.ts:257-259`, installed `:367-368`, removed `:573-574`); `tailEvents.ts:61-63` is the re-homed scar — the drain fix had been applied to the `closed` frame and not to the signal handler, twelve lines above its own fix. **No kit cell sends a signal to a live tail; driven instead**, control vs HEAD: 65,536 of 403,068 bytes (astrolabe) / 401,487 (magpie) → **all of it**, both spells.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **B4** | ✅ CLOSED — **construction**                                               | `kit/wire/tailEvents.ts` | EPIPE is a completed read, not a crash: `tailEvents.ts:372-374`, `stop(0)`. **No kit cell closes a downstream pipe; driven instead**: `tail \| head -1` hung indefinitely on the control, exit 0 at HEAD.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **B5** | ✅ CLOSED — **construction**                                               | `kit/wire/tailEvents.ts` | One backoff, and no branch that sleeps without growing (`tailEvents.ts:492`, `:564` — both comments name B5). Cell: `tailEvents.test.ts:472` "an empty response grows the backoff (B5) instead of storming at a constant interval". ⚠ **It went FURTHER than the criterion asked**: the reset moved from a successful OPEN to the first BYTE, and the fall-through grew a doubling line none of the seven loops had.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **B6** | ✅ CLOSED — **construction**                                               | `kit/wire/tailEvents.ts` | `parseSseFrame` is the spec algorithm rather than either house dialect. Cells: `tailEvents.test.ts:95` (strips exactly one leading space; accepts the spec-legal spaceless form) and `:105` (accumulates multi-line data with newlines).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **B7** | ✅ CLOSED — **construction**, with an unused opt-out                       | `kit/wire/tailEvents.ts` | The cursor takes a **max**, not an assignment: `cursor = cursorPolicy === "assign" ? n : Math.max(cursor, n)` (`tailEvents.ts:541`), and the default is `"monotonic"` (`:317`). Cell: `tailEvents.test.ts:223` "the cursor is monotonic by default — a replayed frame cannot regress it". ⚠ **`cursorPolicy: "assign"` re-expresses the defect on request, and no spell in the roster passes it** (grepped 2026-09-10: the only three occurrences are the declaration, the default and the branch, all inside `tailEvents.ts`). Kept as an escape hatch; it is the one place a caller can put B7 back.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **B8** | ⛔ **OPEN — behaviour UNCHANGED, converged and DOCUMENTED, and NOT RULED** | `kit/wire/tailEvents.ts` | ⛔ **The census's one low-confidence row is the one still standing, and it is standing on purpose in exactly one place instead of five.** `tailEvents.ts:186-189` states the defect as a property of the module: _"The cursor cannot advance past a frame nobody can read, so a PERMANENTLY malformed frame is re-delivered on every reconnect for the daemon's life."_ The frame is skipped and the cursor is not advanced (`:517-521`). **What converged is the reachability** — one code path, one `onMalformed` hook, one cell (`tailEvents.test.ts:343`) — so a fix is now one edit instead of five. **What did not happen is a decision.** ⚠ **Searched 2026-09-10 and found nothing**: no D-number in D1–D91 rules it, no register row files it, and the census's own "constructed from code shape; no reproduction" was never converted into a reproduction. **Recording it as _unsettled by ruling_ rather than as closed, per D42** — absence of a finding must never be spelled the same way as absence of a subject. It wants either a reproduction and a fix, or a ruling that says re-delivery is the correct behaviour for a frame nobody can read. |

**Where the fifteen stand, counted.** **Eleven** closed by construction (L1, L3,
L5, L7 and every tail row but B8); **one** by convention alone (L2 — the kit
takes the activity clock from its caller); **one** in halves (L4 — the timer by
construction, the sockets by convention); **one** closed only opt-in (L6, with
four of six adopters stamping nothing, each by ruling); and **one open and
unruled (B8)**. Two closures carry named residues that outlive this project and
live in the house register rather than here: L6's epoch (register **B1/B2**) and
L4's optional `sockets` argument.

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
