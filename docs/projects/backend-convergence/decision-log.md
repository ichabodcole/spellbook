# Backend convergence — decision log

Live record. Every choice with the options not taken. Append as you go.

---

## D1 · Prove the spine on the two spells that already build

**Ruled:** Cole, 2026-09-08.

Astrolabe and magpie already build their CLIs and already import
`src/kit/lib/printJson`, so they can adopt new shared modules at zero migration
cost. The module boundaries get settled against real consumers before anyone
pays for a build migration. Then one source-shipped spell is the migration
pathfinder and its journal becomes a playbook phase — the method that produced
Phases R and S from the surface ports.

**Not taken:** _build all six first, then extract_ — the original framing;
cleanly separates mechanical from design work, but pays six migration costs
before a single module is validated by a consumer. _One spell end-to-end, then
roll_ — every branch delivers real convergence, but the module boundary is set
by whichever spell happens to go first.

## D2 · The whole backend builds, not just the CLI entry

**Ruled:** Cole, 2026-09-08.

Astrolabe and magpie today build only `cli.ts`; `server.ts` ships as unbuilt
source beside it, so "the backend builds" has never meant the whole backend. The
spine census found the duplication is worst on the **daemon** side — event bus,
`sseResponse`, housekeeping, close-and-drain are all daemon concerns.

**Not taken:** _CLI entry only_ — cheapest and already proven, but the daemon
half could never adopt shared code, forfeiting five of eight spine concerns
permanently. _Whole backend, daemon last_ — smaller branches and earlier wins,
at the cost of touching every spell twice.

## D3 · Both discovery conventions survive, each as one implementation

**Ruled:** Cole, 2026-09-08, on the census's explicit escalation.

Session-JSON (bounty, glamour, imago, magpie) and singleton `daemon.port` /
`daemon.pid` (astrolabe, grapevine, mind-mapper) encode genuinely different
models: multi-session versus standing-singleton. What gets shared is the two
primitives underneath — `writeFileAtomic` and `unlinkIfMatches` — which is where
defect L3 lives anyway.

**Not taken:** _everything to session-JSON_ — richer payload and already the
majority, but it gives standing daemons a session concept they do not need and
costs three migrations. _Everything to singleton port/pid_ — simpler, and pid
liveness probing is a real advantage, but it cannot express concurrent sessions,
which four spells actively use; listed for completeness and judged not viable.

## D4 · The live defects are acceptance criteria, not a work queue

**Ruled:** Cole, 2026-09-08.

Roughly fifteen verified defects sit in the tree, several user-facing — an agent
tailing glamour or magpie killed with its connection open, astrolabe's `join`
unable to survive a daemon restart, a 250 ms reconnect storm in glamour. They
are **not** fixed as separate branches.

In Cole's words: no release is pending, he is the only real consumer, and he is
not currently using the affected spells — so he would rather wait and fix them
all at once through a single build process and shared code, _"where if you fix
it one place, you fix it in other places."_

**Not taken:** _fix the two verified user-facing ones now_ (both one-line
changes) — recommended by the orchestrator and declined on the grounds above.
The cost of the ruling is that these defects stand until the convergence lands;
the benefit is that fixing them by hand would have been fifteen more instances
of the six-edit failure the project exists to end.

## D5 · Naming and layout of the shared modules is deferred

**Ruled:** Cole, 2026-09-08, when the question of a `kit/cli/` directory came up
before the module inventory existed: _"defer the naming."_

Decide the directory from the modules, not before them. `src/kit/lib/` today
holds `printJson` (backend-only) beside `cn` (surface-only), so it is a residual
category — "TS that isn't UI or CSS" — rather than a category. The more useful
cut may be **contract versus utility**: change `die` and an agent observes
something different and the spell needs an acc re-grade; change `sleep` and
nothing observable moves.

**Not taken:** _settle the shape up front_ so nothing lands in the wrong place —
rejected as deciding on priors rather than on evidence.

## D6 · The daemon can build — one bundler flag, measured

**Found:** orchestrator, 2026-09-08, in Phase 0. **Not a ruling; a measurement
that unblocks D2.**

`src/build.ts:95` refused the daemon: _"CLIs ONLY. A server does bundle, but
drags the entire surface graph into the backend artifact; that is unruled and
out of scope. Do not add server.ts."_ Measured, that is accurate about the
default and not the whole story:

```
bun build .../astrolabe/scripts/server.ts --target=bun --external '*/surface/index.html'
  → Bundled 2 modules in 4ms · server.js 20.49 KB
```

Without the external it fails compiling `src/astrolabe/surface/styles.css`
(`@import "tailwindcss" source(none)`), because the bundler follows the daemon's
dev-mode `await import(…/surface/index.html)`. The external is safe: that import
sits behind `mode === "dev" ? … : undefined` and is dead code in a release
artifact — which `server.ts:518-519` independently states, having been written
for a different reason.

**Consequence for the phase plan.** D1's "zero migration cost" holds only for
the **CLI-side** modules; astrolabe's and magpie's servers still ship as unbuilt
source and cannot import `src/kit/` until they build. So Phase 1 splits:

- **1a (now)** — the CLI-side modules, adopted by two spells that already build.
  Genuinely zero migration.
- **1b (next)** — bring those two servers into the build, then adopt the
  daemon-side modules. Cheaper than a full spell migration, because half the
  infrastructure already exists.

**Not taken:** treating `build.ts`'s comment as a closed door and scoping the
project around a CLI-only convergence. That would have forfeited five of the
eight spine concerns permanently, which is exactly what D2 rejected.

## D7 · The shared modules live at `src/kit/wire/`

**Decided:** implementer, 2026-09-08, Phase 1a, under D5's explicit deferral
("decide the directory from the modules, not before them").

Two modules landed: the SSE tail client and the CLI error contract. Read
together they are not "CLI-side helpers" — they are **the two halves of what a
caller can observe**. `tailEvents` decides what arrives on stdout, in what
order, on which stream, and with which exit code; `die`/`EXIT_FOR` decides what
a failure looks like and which number the shell sees. Change either and an agent
observes something different and the spell needs an acc re-grade. Change `cn`
and nothing observable moves.

That is exactly D5's contract-versus-utility cut, and the house had already
named the category without noticing: `printJson.ts`'s own header calls itself
"the house's one-line JSON emitter — imported by every spell that **speaks the
agent wire**." So: **`src/kit/wire/`** — the modules that define what a caller
observes. `src/kit/lib/` keeps what is left, which is the honest residual.

**Not taken:**

- **`src/kit/cli/`** — audience-based, and audience is precisely the residual
  category D5 warned about: it is how `lib/` ended up holding a backend-only
  emitter beside a surface-only helper. It is also already wrong: the tail
  client is a protocol client, and a daemon-side twin would have no home under
  it.
- **Leave them in `src/kit/lib/`** — cheapest, and it defers the question a
  second time. Rejected because Phase 2 lands the daemon-side spine, and a
  residual directory with ten modules in it is a decision nobody will make
  later.
- **Move `printJson.ts` into `wire/` in this phase** so the category is complete
  on day one. It belongs there — it is the third inhabitant by the same test —
  but its path is spelled in eight prose locations across the investigations,
  the seams doc and the archived spell-kit sprints, and this phase's scope is
  two modules. **Stated as debt, not overlooked:** `printJson` moves to
  `src/kit/wire/` when a phase can carry its references with it.

## D8 · `die` throws instead of exiting, and the tail client returns a code

**Decided:** implementer, 2026-09-08, Phase 1a. Not in the drafted signature;
found while adopting.

The convergence design already ruled that the tail client returns an exit code
rather than calling `process.exit` (its decision 2). Adopting it exposed that
`die` had the same problem for the same reason: both were places the process
could end from three frames down, and Bun's stdout is asynchronous on a pipe, so
both could truncate their own output. The two spells' `main` now funnel a thrown
`CliError` into `process.exitCode` plus a natural return — the one shape the
house has measured as safe, and the shape glamour and mind-mapper each reached
independently at their acc L0 passes.

**The cost, named — and the criterion stated correctly, because Phase 2's
playbook inherits this sentence.** A `die` that is REACHABLE from inside a `try`
whose `catch` swallows is now a silent continue rather than an exit.

⛔ **REACHABILITY, NOT CALL SITES.** The first draft of this entry said "every
call site is outside a `try` or inside a `catch`", which is a weaker claim and
misses the defect class entirely: a HELPER that dies, invoked from inside a
swallowing `catch`, has its `die` at a site that looks perfectly safe. The audit
must follow the call graph, not grep for `die(`.

Audited that way for both spells — 15 sites in astrolabe, 29 in magpie, plus the
helpers reachable from them (`cmd`, `requireSession`, `readSession`,
`ensureDaemon`). Every path either lies outside a `try` or sits inside a
`catch`, from which the throw propagates. Two of magpie's sit in a `catch` and
depend on `die` still being `never` for definite assignment; it is.

**A spell adopting this contract must do that audit**, and Phase 2's playbook
must say so in those words.

**Not taken:** _keep the exiting `die` in the kit_ — smaller diff, no audit, and
it would have put the house's only sanctioned exit-truncation hazard inside the
module every spell is about to inline.

## D9 · Phase 1b is one branch of two gated chapters, astrolabe before magpie

**Decided:** orchestrator, 2026-09-08, from measurement before the brief.

The relocation and the adoption are one branch, in two chapters, and chapter 1
must be green and demonstrated on a booted daemon before chapter 2 starts.
Measuring the subject first turned up why: `magpie/scripts/backend.ts:63`
resolves `remove.py` off `import.meta.dir`, which a bundle re-anchors into
`dist/`, and both servers' dev-mode surface import is a relative specifier that
the external flag leaves in the artifact verbatim — two runtime breakages that
no type-check and no unit test reaches. Landed together with a rewrite, neither
would be attributable.

Astrolabe goes first on size: `server.ts` + `state.ts`, against magpie's
`server.ts` + five modules + a `shared/` directory its surface also imports +
six test files. The 1a journal's rule — measure the subject before writing the
brief — is what produced this entry.

**Not taken:** _two branches_ — cleanest attribution, and the adoption branch
would then re-verify a relocation nobody had used yet; the gate inside one
branch buys the same separation without landing a daemon that builds and shares
nothing. _Magpie first_, on the grounds that the hard subject teaches more early
— rejected because its lesson arrives cheaper from astrolabe's journal.

## D10 · What moves with a server: the surface-import test

**Decided:** implementer, 2026-09-08, Phase 1b chapter 1, under the brief's
explicit deferral ("what counts as a sibling is yours to decide from the
imports").

**The rule, stated once:** a module moves to `src/<spell>/backend/` **iff
nothing under `src/<spell>/surface/` imports it.** A module both halves import
is a **two-sided contract** and stays in the deployed skill folder, where both
halves can already reach it and where it needs no build of its own.

Measured against the tree rather than assumed:

| module                                                                            | surface importers                                        | verdict             |
| --------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------- |
| `astrolabe/scripts/state.ts`                                                      | **4** (`useSession`, `board`, `ProjectCard`, `QuietRow`) | **stays**           |
| `astrolabe/scripts/server.ts`                                                     | 0                                                        | moves               |
| `magpie/shared/{types,alpha,versions}.ts`                                         | **12 files**                                             | **stays**           |
| `magpie/scripts/{server,backend,discover,persist.server,reduce,source.server}.ts` | 0                                                        | move                |
| `magpie/scripts/remove.py`                                                        | n/a — not TypeScript, not bundled                        | **stays** (see D13) |

⚠ **The brief said "roughly three" astrolabe surface files import `state.ts`. It
is four.** Small, and the direction of the error is the one that matters: the
count that would have been re-pointed was under-stated.

**Two things the rule gets right that a size-based or a "backend-only" reading
would not.** It reproduces magpie's own prose — `server.ts`'s header already
says the contract "sits in the spell's own `shared/` rather than in either
side's tree" **because it is two-sided** — so the rule is the tree's existing
reasoning made checkable rather than a new preference. And it is symmetric:
astrolabe has no `shared/` directory, but `state.ts` is the same object under a
different name, and the rule finds it without anyone having to notice the
analogy.

**What it costs, named.** The moved daemons now import their two-sided modules
by a `../../../plugins/spellbook/skills/<spell>/…` specifier, which is ugly and
reaches back into the deployed folder. That is not a new shape:
`src/magpie/ backend/cli.ts` has done exactly this since Slice 2, the bundler
inlines it, and Contract 3's criterion is satisfied because the **artifact**
carries no such import.

**Not taken:**

- **Move everything, including `state.ts` and `shared/`.** One root per spell, a
  much nicer story. Rejected on cost and on blast radius: it re-points 16
  surface import sites, four `import-boundary-wards` pins and two spells' test
  suites **inside a chapter whose entire contract is "behaviour unchanged"** —
  and a diff mixing a relocation with a surface-wide re-point is the thing D9
  gated the chapters to prevent. It also makes the surface build reach across
  into `src/<spell>/backend/`, which is a direction no ward currently has an
  opinion about. **Re-open it in a later phase, as its own change.**
- **Move only `server.ts`.** Smallest possible diff. Rejected because it leaves
  `magpie/backend/cli.ts` — already built — importing `backend.ts`,
  `discover.ts` and `reduce.ts` out of `scripts/` while `server.ts` imports them
  from `src/`, i.e. **two roots for one module set**, and it strands the
  `import.meta.dir` hazard (D13) in a file nobody was looking at.
- **A size or "is it daemon-only" judgement per module.** Rejected as
  unfalsifiable: "daemon-only" is exactly the claim the surface importers
  disprove, and a judgement call produces a different answer next phase.

## D11 · The dev-mode surface specifier is written for the ARTIFACT, and the ward pin follows it there

**Decided:** implementer, 2026-09-08, Phase 1b chapter 1. This is the brief's
measurement 3, resolved.

`src/build.ts` passes `external` for the surface-HTML glob, so
`await import("../../../../../src/<spell>/surface/index.html")` survives into
`dist/server.js` **byte-for-byte** (verified in the emitted file, both spells).
The consequence is a genuine oddity and it is now written down in three places
(the source, the build, the ward): **the five `..` are counted from
`plugins/spellbook/skills/<spell>/dist/`, not from `src/<spell>/backend/`.**
Read as an ordinary relative import of the file it is written in, it climbs out
of the repo.

It happens to be the _same_ string as before the move, because `dist/` sits at
the same depth as the `scripts/` it replaced. **That is a coincidence of depth,
not a property**, which is why it is asserted rather than trusted.

**And the ward moved with it.** `grimoire/import-boundary-wards.test.ts` ward 1a
pinned these two escapes at `<spell>/scripts/server.ts` and resolves each
specifier against its importer — the one automated check that the path is right.
`trackedSources` is `.ts`/`.tsx` only, so after the move both pins would have
been **deleted as "no longer present"** and the ward would have gone green
because it stopped looking (Contract 19, exactly). Instead ward 1a's population
now extends into the declared emitted roots — reusing `emittedSources`, which
ward 1b already had, hoisted above both — and the two pins are re-declared at
`…/dist/server.js`. **The check is stronger than the one it replaces:** it now
verifies the specifier at the address where it actually executes.

**Not taken:**

- **Write the specifier relative to the source (`../surface/index.html`) and let
  the bundler rewrite it.** It cannot: `external` means unresolved, which is the
  whole reason the daemon builds at all. Rewriting would require dropping the
  external, which is what D6 measured as impossible.
- **Compute the path at runtime from `import.meta.dir`.** A dynamic import with
  a non-literal specifier is invisible to the scanner (`import-boundary-wards`
  names this blind spot by construction) — it would trade a checkable oddity for
  an uncheckable one.
- **Delete the two ward pins and note the loss.** Honest, and it silently
  removes the only instrument that can catch a wrong path, on the one line the
  brief says nothing in CI can see.

## D12 · The relocated daemon has ONE entry, and it is the launcher

**Decided:** implementer, 2026-09-08, Phase 1b chapter 1.

`src/<spell>/backend/server.ts` exports `run()` and has **no
`if (import.meta.main)` block**. `plugins/…/<spell>/scripts/server.ts` — the
path `cli.ts` spawns, and the path the roster and the wards name — imports
`../dist/server.js` and holds the terminal `process.exit(exitCode)`.

Two consequences, both deliberate:

- **`exit-site-inventory`'s pinned rows do not move.**
  `astrolabe/scripts/ server.ts` and `magpie/scripts/server.ts`, text
  `process.exit(exitCode);`, family **E-terminal** — the same file, the same
  text, still the site where the process ends. The brief's measurement 7 said a
  daemon's terminal exit is a different case from D8's `die` and is not in scope
  to change; keeping it at its pinned address is the cheapest way to mean that.
- **A daemon cannot be booted from its source, and that is correct.** Its
  `SKILL_ROOT`/`DIST_DIR` are anchored one level above `import.meta.dir`, which
  is only true from `dist/`. Run from `src/<spell>/backend/` it would compute
  `SKILL_ROOT = src/<spell>/`, find no `dist/index.html`, silently choose DEV
  mode, and then fail the dev import from the wrong anchor. Offering that entry
  would be offering a wrong daemon.

**Not taken:** _mirror `cli.ts`, which keeps BOTH an `import.meta.main` block
and an exported `run()`._ Consistent with the sibling, and it is why the option
was considered at all. Rejected because the CLI's dual entry is **safe** (its
ancestor paths are correct from either location and its tests use it), while the
daemon's is **wrong from one of the two** — and it would add a second
`process.exit(exitCode)` row to the inventory for an entry nothing should call.

## D13 · A non-TypeScript sibling is resolved up-and-back-down, like every other path in a built backend

**Decided:** implementer, 2026-09-08, Phase 1b chapter 1 — and it is a **bug
fix, not a migration cost**. See the journal: the defect was already shipped.

`magpie/backend/backend.ts` resolves `remove.py` as
`join(import.meta.dir, "..", "scripts", "remove.py")`. `remove.py` stays in
`plugins/spellbook/skills/magpie/scripts/`: it is a runtime asset the deployed
skill executes with `python3`, it is not bundled and must not be, and
`grimoire/gate-honesty.test.ts` declares it as 145 blind lines at that exact
path.

**Not taken:**

- **Move `remove.py` into `dist/`** so `import.meta.dir` keeps working. It would
  make the bug's own workaround the design: `dist/` is rm'd and regenerated by
  every build, so a hand-copied asset there is a file the build deletes.
- **Copy `remove.py` into `dist/` as a build step.** A second copy of a shipped
  file, plus a staleness question `dist-check` cannot answer (it verifies by
  reproduction, and a copy reproduces whether or not it is right).
- **Resolve it off `SKILL_ROOT`.** Equivalent in effect; rejected only because
  `backend.ts` has no `SKILL_ROOT` and adding one puts a second definition of
  the skill root in a spell that already has two.

## D14 · The daemons' tests re-anchor on an explicit skill root, and they test the ARTIFACT

**Decided:** implementer, 2026-09-08, Phase 1b chapter 1, forced by D12.

Both spells' daemon suites spawned `./server.ts` (or `../scripts/server.ts`) and
pinned a `cwd` by counting `..` from wherever the test file happened to sit.
After the move those counts are wrong, and — because D12 gives the daemon one
entry — the source is not runnable at all. Every such path is now derived from
an explicit `SKILL_ROOT`, and every daemon spawn goes through the **launcher**.

**The consequence, stated because it changes what a green means:** these suites
now depend on a built `dist/server.js`. `bun run gate` is
`build && check && test`, so the artifact is always fresh when they run, and the
thing being asserted is the thing that ships (Contract 18's spirit, one level
down). `astrolabe/scripts/cli.test.ts` already worked this way for the CLI.

`release-serve.test.ts` changed the most: it built its fake release tree by
globbing every non-test `.ts` beside the daemon, under a scar earned when
mind-mapper's hand-maintained mirror shipped a broken release twice. That glob
now copies files whose `../../../plugins/…` specifiers cannot resolve from a
temp directory. **The scar is re-homed:** the property it protects — a new
module is in the copied tree by construction — is now true by BUNDLING rather
than by globbing, because `dist/server.js` is the whole module graph.

**Not taken:**

- **Keep an `import.meta.main` block so the source stays spawnable.** Rejected
  under D12: it offers an entry that computes the wrong `SKILL_ROOT`.
- **Adjust the `..` counts in place.** The cheapest edit and the one that rots:
  the next relocation moves them again, silently, and a test whose spawn path is
  wrong fails as "the daemon never answered".
- **Copy the daemon SOURCE into the fake release tree and run it there.**
  Rejected because it would assert a tree that does not exist — nothing ships
  `src/`, which is the whole point of Contract 4.

## D15 · The spawn-path ward is a chapter 2 deliverable

**Ruled:** Cole, 2026-09-08, on the orchestrator's offer to fold it in here or
defer it to Phase 2's playbook: _"fold it into chapter 2."_

Chapter 1 produced two defects of one class — magpie's `remove.py` resolved off
`import.meta.dir` (dead for eight days in the SHIPPED plugin, since the CLI
build at `7bb0f4a`, answering `ok:true` at exit 0 the whole time) and a bundled
daemon with no entry, because `import.meta.main` is false in a module the
launcher imports. Both are the same defect: **bundling changes what a module
knows about its own location, and every symptom is quiet and exit-zero.**

**The finding is an instrument gap, not a sequencing win.** The magpie bug
predates this phase and survived its own branch's verify pass. Nothing in this
repo tests a path that is SPAWNED rather than imported: the gate type-checks,
the wards text-scan, the unit tests import, and a `join(import.meta.dir, …)`
pointing at empty air passes all three. Only running the verb finds it.

So chapter 2 grows one deliverable: **a ward that enumerates every path-pinned
non-bundled sibling reachable from a BUILT backend — Python files, assets, spawn
targets — and asserts each resolves from the EMITTED location.** It is the
natural companion to the shared spine: five spells are queued behind this, each
with its own `import.meta` assumptions, and the same three instruments will stay
green through every one of them.

**Not taken:** _a Phase 2 playbook item_ — keeps chapter 2 at its scoped size,
and the brief's own warning is that a phase which grows is a phase nobody can
verify; rejected because a playbook line is a thing an author must remember,
which is exactly what failed here, and because the five remaining spells all
port before that playbook is written.

## D16 · Chapter 2's FIRST commit is ward 1b's emitted-root exemption

**Decided:** orchestrator, 2026-09-08, on the chapter 1 verify pass.

The verifier calibrated five mutations against the wards this chapter widened.
Four went red. The fifth — `import { serve as __s } from "bun"` inside
`dist/server.js` — stayed **green, 18 pass / 0 fail**.

`makeIsBuiltin(exact, emittedRoots)` falls through to
`emitted && BARE_BUILTINS.has(spec)`, and under Bun `node:module`'s
`builtinModules` **contains `"bun"`** (76 entries, including `bun:ffi`,
`bun:jsc`, `bun:sqlite`, `bun:test`). So inside a declared emitted root, `bun`
is exempt via `BARE_BUILTINS` regardless of `BUILTIN_EXACT`, and the
`withoutBun` differential cell — the cell this branch just edited from five
names to three — is structurally blind there.

**The 5→3 comment reads as verified and is asserted.** Its first half is true
and the verifier confirmed it: both bundles carry only `fs/os/path/util/url`
plus the one external surface specifier. Its second half — that `dist/server.js`
being in the population is the guarantee — does not carry the weight it is
given, because that cell could not see a `bun` value import if one appeared. Net
against `develop`: these daemons were hand-authored `.ts` inside ward 1b's
population, where a runtime `bun` import was visible to the differential; their
source is now outside that population and their artifact sits inside an
exemption that swallows `bun`.

Not a deployment hazard — `bun` is the runtime. It is the **"population changed
during a relocation"** shape, which is the exact failure this project exists to
end, and it must be closed **before** chapter 2 starts putting `src/kit/`
modules into these same bundles: anything the kit drags in that resolves to a
name in Bun's `builtinModules` would be exempt inside `dist/` and invisible to
both cells. Fixing it after the kit's surface area lands means fixing it against
a population that already grew.

So chapter 2 opens with it, before any shared module is adopted, and the fix is
calibrated the way the verifier calibrated the others: mutate, see red, restore.

**Not taken:** _a chapter 1 addendum_ — arguably where it belongs, since this
branch caused it; rejected because chapter 1 is verified and closed, and
reopening a verified chapter to edit a ward is how a clean verdict goes stale.
_Write it down honestly and move on_, which the verifier offered as the
alternative — rejected because the next five spells all relocate into that same
exemption.

## D17 · The daemon-side spine is six modules in `src/kit/wire/`, and what it refused is part of the ruling

**Decided:** implementer, 2026-09-08, Phase 1b chapter 2, under the brief's
presumption that `src/kit/wire/` is the home and the burden is on the
implementer to argue otherwise. It was not argued otherwise: D7's test — "the
modules that define what a caller observes" — covers every one of these.
`sseResponse` decides what a tail client receives; `resolveMode` decides which
of two surfaces a caller is served; `shouldIdleClose` decides whether a held
connection survives. None of them is a utility.

| module            | exports                                                  |
| ----------------- | -------------------------------------------------------- |
| `serveDist.ts`    | `resolveMode` · `contentTypeFor` · `serveFromDist`       |
| `eventLog.ts`     | `createEventLog`                                         |
| `sse.ts`          | `sseResponse` · `SseClients`                             |
| `housekeeping.ts` | `shouldIdleClose` · `startHousekeeping` · `drainAndStop` |
| `discovery.ts`    | `writeFileAtomic` · `unlinkIfMatches`                    |
| `heartbeat.ts`    | `idleTimeoutSec` · `heartbeatMs` · `tailIdleMs`          |

**Checked against these two spells rather than against the census's counts, as
the brief demanded.** Every module above is used by BOTH servers. Two things the
census listed did not come: `emitTransient` (glamour's, and neither of these two
has presence frames in its replay log) and the discovery WRITER (D3 — the two
conventions stay, only the primitives are shared).

**Three refusals, each of which is a decision:**

- **The URL-to-filename mapping stays in each router.** `serveFromDist` takes a
  filename, not a request path. The census marked two of the eight `serveDist`
  divergences DELIBERATE and both live in that half — digestify substitutes into
  the entry document in memory, grapevine serves its surface at `/watch`. A
  signature wide enough for those stops being a file server and becomes a
  router, and the two spells it would serve are not the two adopting.
- **Bounty's shutdown watchdog did not come.** It is the corpus's only
  unconditional-termination guarantee and it belongs to bounty's SIGNAL path,
  where nothing bounds what teardown waits on. Neither adopting daemon registers
  a signal handler, and their teardown is bounded by `drainAndStop`'s own two
  numbers. Importing it would have put the house's only unconditional
  `process.exit` inside a module every spell is about to bundle, one phase after
  D8 took exactly that hazard out of `die`. The reasoning is written into
  `drainAndStop`'s header so the spell that DOES have a signal path adds it as
  an option rather than re-deriving it.
- **`printJson` did not move into `wire/`.** D7 named it as debt and the brief
  offered this phase the chance to pay it. This phase's diff already spans two
  daemons, two CLIs, six new modules and two wards; adding eight prose
  re-pointings to that is how a phase stops being verifiable. **Still debt, and
  the sentence about it is unchanged.**

**Not taken:**

- **`src/kit/daemon/`**, a directory named for the audience. Rejected for the
  reason D7 rejected `src/kit/cli/`: audience is the residual category that put
  a backend-only emitter beside a surface-only helper in `lib/`. It is also
  already wrong — `heartbeat.ts` is imported by both halves, so a daemon-scoped
  directory would have a CLI's constant in it on day one.
- **One `daemon.ts` module rather than six.** Fewer files, one import line.
  Rejected because the six have genuinely different audiences: a spell adopting
  the tail client needs `heartbeat.ts` and none of the rest, and a spell with no
  SSE at all still wants `writeFileAtomic`. A single module makes every adopter
  take all of it.
- **Keeping `shouldIdleClose` exported from each server** so its existing cells
  did not move. Rejected: it would have asserted a re-export, and the shared
  predicate now carries a case (magpie's) that astrolabe's copy never had.

## D18 · The heartbeat crosses the seam through a per-spell leaf module, not through the kit alone

**Decided:** implementer, 2026-09-08, Phase 1b chapter 2. This is the brief's
first named deliverable and the shape it takes was not given.

The kit holds the DERIVATIONS (`idleTimeoutSec`, `heartbeatMs`'s clamp to half
the idle timeout, `tailIdleMs`'s three missed beats) and no spell's numbers.
Each spell holds its VALUES in `src/<spell>/backend/heartbeat.ts` — a
leaf-shaped module that imports the kit and nothing else — and both the daemon
and the CLI import that.

**Why a per-spell file at all.** The values differ and the env names differ
(astrolabe tunes `ASTROLABE_HEARTBEAT_MS`; magpie tunes nothing). Putting the
derivations in the kit and calling them from both halves would have left the env
name and the fallback hand-mirrored in two files — the same duplication one
level down, and harder to see.

**Why it is not exported from `server.ts`.** That is the thing that could not
happen: a CLI importing the daemon drags the whole server graph into
`dist/cli.js`, which is why both files carried a comment asking the next author
to remember instead. The new module is the seam BECAUSE it is a leaf.

**Not taken:** _an env var read by both halves_ — no new module, and it makes
the invariant a runtime coincidence rather than a derivation, with nothing to
fail when one half is launched without it. _Constants in the kit, one pair per
spell_ — the kit would then know the roster, which is exactly the coupling that
makes a kit stop being adoptable.

## D19 · Astrolabe gets the epoch; the STALE-WATERMARK REPLAY is what makes it reachable

**Decided:** implementer, 2026-09-08, Phase 1b chapter 2, after driving it.

**The brief's model of this deliverable was incomplete, and the tree said so.**
It reads: the client already carries `epochOf`/`onEpochChange`, so "give the
daemon an epoch and the gap closes with no client change". Measured: it does
not. The client detects an epoch change on a frame it RECEIVES, and the bug is
that no frame is received — a tail resuming at `since=4` against a restarted
daemon whose `ready` is id 1 gets nothing, because every copy filters
`id > since`. The tail sits connected and silent until the new daemon has
emitted as many events as the old one did.

So the repair is two-sided and the daemon side is the load-bearing half:
`createEventLog.subscribe` treats `since > cursor` as a cursor from a PRIOR
PROCESS and replays whole. The epoch is what stops the tail then re-requesting
that stale cursor on every subsequent reconnect.

**Driven, fail-first, on two live daemons** (journal has the transcript): the
chapter-1 bundle answers `/events?since=4` with ZERO bytes over three seconds
while holding a `ready` it will happily serve at `since=0`; the chapter-2 daemon
answers the same request with the `ready`. Under a real `tail`, a hard `kill -9`
and a respawn produced `{"type":"epoch.changed",…}` followed by the new daemon's
`ready`.

**Magpie deliberately has NO epoch**, though the module offers one for free. A
magpie session is identified by `session_id` and a restart is a different
session, so a resuming tail is already talking to a different daemon by name;
and "epoch for the other daemons" is out of this phase's scope. Free-riding it
in because the module made it cheap is how a scoped phase stops being one.

**Not taken:** _emit an epoch frame at connect_ instead of the replay rule. It
would deliver the epoch, but the client resets its cursor to 0 without
reconnecting, so the events between 1 and the stale watermark are lost for that
connection — a worse failure than the silence, because it looks like it worked.
_Have the client send `since=0` on every reconnect_ — no daemon change, and it
re-replays the whole window on every network blip.

## D20 · Two wire-observable changes, named rather than smuggled

**Decided:** implementer, 2026-09-08, Phase 1b chapter 2. A convergence that
changes what a caller sees must say which bytes moved.

1. **`.html` is served as `text/html; charset=utf-8`.** The census found this to
   be the ONLY divergence in the content-type table across all eight daemons —
   three had it, five did not, graded `stale` with zero design content. Kept
   because it is correct: a document served with no charset is decoded by the
   browser's guess. One test cell asserted `text/html` by `toContain`, so
   nothing needed changing; the change is real all the same.
2. **The SSE stream opens with a `: connected` comment.** mind-mapper's, and it
   flushes the response headers — some clients, Bun's own `fetch()` included,
   buffer until the first body byte, so a genuinely quiet stream leaves the
   caller's `fetch()` unresolved. **It broke a cell**, and the cell was reading
   the first LINE of the stream rather than the first FRAME; every house tail
   client already drops `:` lines. The cell now reads like the clients do.

**Not taken:** _keep `text/html` bare and keep the stream silent until the first
frame_, i.e. converge on the majority rather than on the better copy. Rejected
under the brief's own instruction — convergence is toward the best sibling, not
a merge of equals — and because the majority here is a count, not an argument.

## D21 · The spawn-path ward's boundary is the PLUGIN, and what it cannot assert is enumerated

**Decided:** implementer, 2026-09-08, Phase 1b chapter 2, executing D15.

The ward resolves anchor arithmetic (`join(import.meta.dir, …)` and every named
anchor derived from it) in the EMITTED `.js`, then asserts the file is there.
Population from `src/build.ts`'s own `buildableSpells()`, per D15's ⛔.

**The tree corrected the first draft twice.**

- The boundary was `plugins/…/skills/<spell>/`. The scanner immediately found a
  pin one level ABOVE it that both CLIs make — `.claude-plugin/plugin.json`,
  read for the version they report — which a skill-scoped boundary would have
  exempted while it is a shipped sibling by every criterion the ward has.
  Contract 3's boundary is the plugin, so the ward's is too.
- A pin that leaves the plugin cannot be asserted from this repo at all:
  `SURFACE_CWD` is `src/<spell>/`, which exists HERE and does not exist at the
  destination. Asserting it would assert the opposite of Contract 4. Those are
  **enumerated and pinned as a set** rather than filtered away, so a new escape
  is loud — ward 1a's discipline applied to a path instead of to a specifier.

**What it cannot see is in its own header**, not in this log: concatenated
paths, paths through a non-anchor variable, and paths assembled across a
function boundary. It is the instrument for the ANCHOR-ARITHMETIC class, which
is the class bundling breaks and the class both of chapter 1's defects were in.

**Not taken:** _assert every pin, inside the plugin or not_ — it would have gone
red on `SURFACE_CWD` in any tree that ships without `src/`, i.e. it would have
been a ward that fails at the destination it exists to protect. _Parse the
bundle with a real AST_ — strictly better and it is a different project; the
regex evaluator is calibrated on a synthetic tree in-cell AND was driven against
the real artifact by re-breaking `remove.py`, which is the standard this repo
applies to its own scanners. _Scan the SOURCE instead of the artifact_ — it
would have been green on `remove.py` for eight days, because in the source the
path was correct and it was BUNDLING that moved the anchor.

## D22 · `grow`/`shrink` join the kit-prose ward, and the way they were found is the finding

**Decided:** implementer, 2026-09-08, Phase 1b chapter 2 — the ward's own
prescribed repair, taken.

A sentence in a new kit module ("five daemons GROW an array for the life of the
process") emitted `.grow { flex-grow: 1 }` into the stylesheets of four
unrelated spells — bounty, digestify, grapevine and imago. `kit-prose-ward`
stayed green because `grow` was not in `BARE_UTILITIES`. **What caught it was
`dist-check`'s reproduction arm**, i.e. downstream, by luck of the artifact
being committed — which is verbatim the failure the ward's own header warns
about and says it exists to prevent.

The list's header says it is not claimed exhaustive and that the repair is to
add the word. Added, with the account. A second pre-existing `grow` was standing
in `src/kit/wire/tailEvents.test.ts` from Phase 1a and is reworded.

**Not taken:** _derive the vocabulary instead of listing it_ — considered and
rejected in the ward's own header for a reason that still holds (the dangerous
word is the one no surface uses). _Reword only, and leave the list_ — it would
have left the next author to rediscover the same word through a committed
artifact.

## D23 · The restart gap is NARROWED, not closed — and `>=` is the wrong fix

**Found:** chapter 2 verify pass, 2026-09-08, driven. **Amends D19, which reads
as "closed" and is stronger than the code.**

`subscribe` replays whole only when `since > seq` **strictly**. So the case that
stays open is equality, and equality is the ordinary state of a quiet standing
observatory:

- daemon 1 boots, emits `ready` (id 1); a tail attaches, cursor is now **1**
- `kill -9`, respawn; the new daemon's cursor is also **1**
- the tail reconnects at `since=1`; `1 > 1` is false, so `ready` is filtered and
  the tail sits **connected and silent** — verbatim the symptom D19 exists to
  close. Probed directly: `GET /events?since=1` → 15 bytes (`: connected\n\n`);
  `?since=0` → the `ready`.

It self-heals on the first real event (that frame carries the new epoch →
`epoch.changed` → cursor reset), and `develop` was silent after **every**
restart, so this is a partial fix and not a regression. It is recorded because
D19 claims more than it delivers and a future reader would trust it.

⛔ **The obvious one-line repair is wrong and must not be applied.** Changing
`since > seq` to `since >= seq` closes this case by breaking the common one: a
HEALTHY tail reconnecting at the tip sends `since == seq` every time, and would
then be handed the entire buffer again on every reconnect — duplicating every
event the caller has already seen. The verifier proposed it as one option and
deliberately did not apply it; measuring the reconnect path is what shows why.

**The correct close is epoch-aware, not cursor-aware**: the client sends the
epoch it last saw, and the daemon replays whole whenever that epoch is absent or
does not match its own. The client already tracks the epoch (`epochOf` /
`onEpochChange`, Phase 1a); what is missing is the query parameter and the
daemon-side comparison. **It is deliberately not done here** — it is a change to
the shared client that all seven spells inherit, arriving after this phase's
verification, and the other daemons do not stamp an epoch yet. **It is the first
input to the phase that gives them one**, where it can be designed against all
seven rather than retrofitted to one.

**Not taken:** _apply `>=` and land_ — closes the reported case and opens a
worse one. _Hold the branch until the epoch parameter is designed_ — the branch
is strictly better than `develop` on this axis today, and holding a verified
merge for an improvement is how a good landing goes stale.

## D24 · Two out-of-range inputs change meaning, and are accepted as such

**Found:** chapter 2 verify pass, 2026-09-08. **D20 named two wire changes;
these are a third and fourth, both outside the documented range.**

- **`magpie --timeout 0`.** Develop: `(now - last)/1000 >= 0` is true on the
  first tick, so the daemon closes immediately. Branch: `shouldIdleClose`
  returns false for `timeoutMs <= 0`, so it **never** idle-closes.
- **`ASTROLABE_IDLE_TIMEOUT=-5`.** Develop clamps to 1 s; `intOr` now rejects
  non-positives, so it falls back to the 255 s default.

Both are accepted rather than restored. The old behaviours were accidental
consequences of an arithmetic comparison, not intended semantics — "close the
daemon instantly" is not a plausible reading of `--timeout 0`, and a 1-second
clamp is not a plausible reading of a negative timeout. Defaults are 1800 s and
255 s, so nothing in documented use moves.

**Not taken:** _restore develop's arithmetic exactly_ — the strictest reading of
"behaviour unchanged", and it would have put a `<= 0` special case back into a
shared module every spell is about to adopt, to preserve two behaviours no
caller wants. Changing shared code after the verify pass to reproduce an
accident is the worse trade.

## D25 · A3's carried items, discharged explicitly

**Closed:** orchestrator, 2026-09-08. The brief said "carry them; do not fix
them silently"; the verifier correctly reported that nothing recorded whether
they had been carried at all.

- **Stale addresses** in `grimoire/import-boundary-wards.test.ts` (now `:123`,
  `:691`, `:1210`) still cite `magpie/scripts/backend.ts` and `.../discover.ts`,
  which moved in chapter 1. **Left as prose drift, filed here**; they are
  comments, not pins, and the pins themselves are green.
- **`ARTIFACT_FILES` narrowness** — the `release-serve` guarantee covers the
  module graph, not the asset graph. **Discharged by the spawn-path ward**,
  which is now the honest home for it.
- **D10's two-sided duplication** — `state.ts` and `magpie/shared/types.ts` ship
  as source and are inlined into three artifacts each; staleness is caught only
  by `dist-check` ARM 2. **Still true, still stable, still worth knowing**
  before a later phase adds more to those bundles.

## D26 · glamour's `shared/` stays; the six `scripts/` modules move

**Decided:** implementer, 2026-09-08, Phase 2 chapter 1, under D10's rule
applied to a third spell.

Measured against the tree rather than assumed: **17 surface import sites**, all
into `shared/` — 16 of `types.ts` (`App.tsx` plus ten components plus `derive`,
`derive.test`, `fileIntake`, `useSession`) and 1 of `imageOptimize.ts`
(`fileIntake`). Zero surface files import anything under `scripts/`. So
`cli.ts`, `server.ts`, `reduce.ts`, `styles.server.ts`, `persist.server.ts` and
`imageOptimize.server.ts` move to `src/glamour/backend/`; `shared/` stays where
both halves can already reach it.

**The rule also decided a test that the rule does not obviously cover.**
`tests/imageOptimize.test.ts` imports BOTH `scripts/imageOptimize.server.ts` and
`shared/imageOptimize.ts`, so its imports point both ways. It moved, because **a
test follows its SUBJECT, not its imports** — the subject is the `.server.ts`.
`tests/types.test.ts`, whose subject is `shared/types.ts`, is the one test file
that stayed behind.

**Not taken:** _move `shared/` too, giving glamour one root._ Nicer story, and
it re-points 17 surface sites inside a chapter whose entire contract is
"behaviour unchanged" — the same reasoning D10 already recorded for magpie's
twelve. It is re-openable as its own change, for all three spells at once.

## D27 · The spawn-path ward's ANCHOR PATTERN is widened, and a COVERAGE cell is added

**Decided:** implementer, 2026-09-08, Phase 2 chapter 1, on the brief's explicit
instruction to report the ward's silence as a finding about the ward.

The ward was **green over a real defect**: `dist/cli.js` spawning
`dist/server.ts`, a file that does not exist. Cause, measured: `ANCHOR_URL`
required a BARE `fileURLToPath`, glamour writes `Bun.fileURLToPath`, so
`SCRIPT_DIR` was never registered and all four pins computed from it were
dropped. The ward printed eight pins, none of them glamour's, and passed 5/0.
Its "a pin that leaves the skill folder is ENUMERATED" cell was silently wrong
at the same time and for the same reason.

Three changes, and only the first is the bug fix:

1. An optional member-expression qualifier before `dirname` and `fileURLToPath`.
2. ⭐ **A COVERAGE cell.** Every emitted `cli.js`/`server.js` that DECLARES an
   anchor must yield ≥1 pin. This is the general instrument: it fails on the
   next unrecognised spelling without anyone having to think of it in advance.
3. `emittedJs` skips a tracked-but-absent file instead of throwing ENOENT from
   three cells mid-port.

**⛔ The finding under the finding, and it amends Phase 1b's closing
paragraph.** 1b ended "population and coverage are different measurements —
**print both**", and printing is what it built. Printing is not enough: a green
ward's console output is not read. **Coverage must be ASSERTED.** Phase 1b's own
text is the strongest evidence for this: it correctly predicted the failure
mode, in writing, one phase before it happened, and the instrument it prescribed
did not stop it.

**Not taken:**

- _Rewrite the CLI to use a bare `fileURLToPath` so the existing pattern
  matches._ Cheapest, and it makes the SPELL conform to the INSTRUMENT — the
  ward would still be blind to the next spelling, and five spells are queued.
- _Parse the emitted JS with a real parser instead of regexes._ Genuinely
  better, and out of scope for a chapter whose contract is "behaviour
  unchanged"; the ward's own header already declares the regex blind spots. The
  coverage cell is what makes a future blind spot loud, which is the property a
  parser would have bought.
- _Report it and leave it broken_, per the brief's letter ("that is a finding
  about the ward"). Rejected because chapter 1's premise is that the instruments
  are honest before chapter 2 moves anything, and a knowingly blind ward is
  worse than no ward.

## D28 · `DECLARED_EMITTED_ROOTS` gets a derived completeness cell

**Decided:** implementer, 2026-09-08, Phase 2 chapter 1.

`import-boundary-wards` derives every population from the tree except this one
hand-written array of root paths, which BOTH ward 1a and ward 1b read to decide
which emitted files they open at all. An omission is not an over-broad
exemption; it is **unseeing** — the spell's `dist/*.js` leaves both populations
and both cells go green because they stopped looking. Identical in kind to
`INTERNAL_ENTRY_POINTS`, which 1b flagged as silent-in-both-directions.

glamour is added, and a new cell derives the REQUIRED set from the tree the way
`src/build.ts` derives what to build — `src/<spell>/backend/{cli,server}.ts`
exists ⇒ `<spell>/dist` must be declared — and fails naming any spell missing
from the list.

**Not taken:** _derive the list itself and delete the declaration._ It is the
right end state and it changes what two wards examine inside the chapter that
relocates a spell, which is the one chapter that must not also move an
instrument's population. The cell delivers the safety now and leaves the
deletion as a clean, separately-verifiable change.

## D29 · glamour's daemon integration suite forces `release` rather than spawning

**Decided:** implementer, 2026-09-08, Phase 2 chapter 1, forced by D12.

The suite imports `startDaemon` and drives it in-process, thirty cells deep
against one shared instance. After the relocation `SKILL_ROOT` computes to
`src/glamour/`, `resolveMode()` answers DEV, and the dev surface import — whose
five `..` are counted from `dist/` — climbs out of the repo. Every cell failed
in `beforeAll`. That is D12 arriving as an error message: **a daemon booted from
its source is a wrong daemon.**

`SPELLBOOK_SURFACE_MODE=release` around the boot says "mode is not what this
file tests". `release-serve.test.ts` spawns the real launcher and is where mode
resolution, dev serving and release serving are asserted — so nothing is
unasserted, it is asserted in the suite that can see it.

**⛔ And the first form of this repair was a cross-suite defect.** A bare
assignment in `beforeAll` is process-global; `bun test` runs a directory in one
process; `cli-open-envelope.test.ts` spawns a CLI whose premise is that mode is
AUTO-DETECTED, detected release instead, skipped the guard and hung. It is now
set and restored in a `try/finally`, AND the spawning suite clears the variable
out of its child's environment — belt and braces, because the two suites are
only coupled by a runner detail that could change.

**Not taken:** _convert the suite to spawn the launcher, as magpie's did._ The
faithful answer and it is a rewrite of 430 lines of in-process HTTP driving
whose subject is the reducer and the routes, not the process. Magpie's suite
already spawned a daemon per cell, so its conversion was an address change;
glamour's would be a different test.

## D30 · The surface artifact depends on WHICH SPELLS share the build process

**Found:** implementer, 2026-09-08, Phase 2 chapter 1, driven. Not a decision so
much as a measurement the roll must carry.

`bun run src/build.ts glamour` and `bun run build` emit **different bytes for
glamour's surface from identical source**, deterministically and repeatably:
`index-mccrznc4.js` / `index-me0sn06x.css` for a subset build (glamour alone, or
glamour + astrolabe in either order), `index-39c5b79f.js` / `index-ek8hd2gz.css`
for the whole roster. The differences are real content — Tailwind palette values
at a different rounding (`#b75000` vs `#bb4d00`) and a different emitted form of
Bun's own `__commonJS`/`__copyProps` helpers.

`dist-check` ARM 2 runs `bun run build` with no arguments, so **the artifact the
house verifies is the whole-roster build** and the committed tree is
self-consistent. What is not safe is a per-spell build during a port: it dirties
`dist/` with no source change and every downstream instrument that compares the
index to the disk then reports something else.

⚠ **This produced a FALSE FINDING before it produced a true one.** On the first
per-spell rebuild I recorded "glamour's committed dist is stale at HEAD" and
verified it by stashing the work and rebuilding at HEAD — **which confirmed the
false conclusion, because the control repeated the suspect step.** The
whole-roster rebuild restored the committed bytes exactly. The rule is now in
the playbook in both halves: rebuild the roster, and a control that repeats the
suspect step is not a control.

**Not taken:** _investigate and fix the non-determinism here._ It is a real
question about `bun-plugin-tailwind`'s shared state across `Bun.build` calls in
one process, it is house-wide rather than glamour's, and a phase that grows is a
phase nobody can verify. Recorded for its own investigation.

## D31 · `ErrExtra` gains `server` — the shared contract widens to fit glamour

**Decided:** implementer, 2026-09-08, Phase 2 chapter 2, on the brief's
instruction that a wrong boundary is a finding about the module.

glamour's failure envelope carries `error.server` — the refusing daemon's body
verbatim — and its contract suite asserts the round trip for HTTP 400, 404
and 409. The kit's `ErrExtra` was `{ hint?, choices? }` because **astrolabe and
magpie both discard the body** (magpie: `die(\`state failed (HTTP ${status})\`,
"internal")`keeps the number and loses the reason). Seven of the eight spells front a daemon, so keeping the upstream's own words is the general shape and the two-spell boundary was the narrow one.`server`
is emitted LAST so an already-shipping envelope's key order does not move.

**⛔ The rule this is an instance of:** a module extracted from two consumers
encodes **what those two agree on**, and agreement is not evidence of design. It
took a third consumer to tell the difference.

**Not taken:**

- **Keep glamour's own `writeEnvelope` and import only `die`/`CliError`.**
  Smallest diff, zero risk to the wire — and it leaves a fourth copy of the
  envelope in the tree, which is the thing this project exists to end. It would
  also have hidden the finding: nobody would have learned that the kit cannot
  express a daemon refusal.
- **Drop `error.server` from glamour to match the kit.** Rejected outright: it
  is a wire-observable regression, it is asserted by three contract cells, and
  it would be the spell bending around the module — precisely what the brief
  forbade.
- **A generic `details?: unknown`.** Renames a field that already ships, for
  tidiness, and loses the one property that makes it worth having — that a
  caller can trust it is what the other side actually said.

## D32 · `SseClients` holds `{close, send}`, not a bare closer

**Decided:** implementer, 2026-09-08, Phase 2 chapter 2.

glamour streams presence — `{type:"connected"}` / `{type:"disconnected"}` — to
the AGENT's SSE tail, unlogged and with no `id`, so a reconnecting agent neither
re-sees every past connect nor advances its cursor past one. `sse.ts`'s registry
held bare closers, so there was no way to write to a live stream that did not go
through the log.

Astrolabe and magpie announce presence over their browser WEBSOCKET, which is
why the boundary looked right for both. The registry entry is now
`{ close(): void; send(chunk: string): void }`, and `send` routes through the
same closed-check and teardown funnel as every other write — so a `send` after
teardown is a no-op rather than a throw, and a daemon announcing presence cannot
crash on a departed subscriber. `drainAndStop` was the only other consumer;
neither adopting spell dereferences the elements.

**Not taken:**

- **Keep a parallel `Set<ReadableStreamDefaultController>` in glamour's
  daemon.** The obvious local fix, and it re-creates VERBATIM the drift this
  registry exists to remove — the copies kept a second set of heartbeat timers
  beside the controllers and swept it separately, which is the defect `sse.ts`'s
  own header describes. A second parallel set would also be invisible to
  `subscriberCount`.
- **Put `announce`/`emitTransient` on `EventLog` instead.** The log is where
  fan-out lives, so it reads well — but a transient is not a `Frame<T>` (it has
  no `id`, by design), so every listener would have to accept a union and every
  consumer would have to discriminate. The registry is where "act on one live
  stream" already lives.
- **A `sseResponse` hook that hands the caller a raw `send`.** Equivalent power,
  and the caller then has to keep its own collection of them — the parallel set
  again, one indirection later.

## D33 · glamour's tail returns an exit code, so the COMMAND TABLE carries one

**Decided:** implementer, 2026-09-08, Phase 2 chapter 2.

`tailEvents` RETURNS an exit code rather than calling `process.exit` from inside
its loop (D8's sibling ruling, and the whole of the P0f drain scar). glamour
dispatches through a `COMMANDS` table whose `run` returned `Promise<void>`, so
there was nowhere for that code to go. `run` is now
`Promise<number | undefined> | number | undefined`, and dispatch reads
`typeof code === "number" ? code : 0`.

`undefined` means 0 — "the verb completed and has no opinion" — so every row but
`tail` is untouched and only the verb that owns a code has to say so.

**Not taken:** _make `cmdTail` set `process.exitCode` itself._ One line, no
signature change, and it puts a second place the exit code is decided into a CLI
whose entire funnel exists so there is exactly one. _Special-case `tail` in
`dispatch` before the table walk._ It works, and it re-introduces the second
source of truth the command table was built to remove — help, the schema, the
arity check and the dispatcher all walk that one structure.

## D34 · glamour's daemon integration suite forces release; the CONDITIONAL swallow is filed, not fixed

**Decided:** implementer, 2026-09-08, Phase 2 chapter 2, out of D8's audit.

The audit came back clean — 12 `die` sites, 25 further invocation edges, 37
audited positions, **zero inside a `try`** — but it named one CONDITIONAL:
`postCmd`'s ECONNRESET catch tests `message.includes("ECONNRESET")` on an
untyped error and answers `{"ok":true,"sent":"close"}` at exit 0. Its only
die-reachable call, `requireSession`, sits three lines ABOVE the `try`, so no
`CliError` can enter it today.

**Filed, not applied.** The one-line ward is
`if (err instanceof CliError) throw err;` as the catch's first statement. It is
a behaviour change in a chapter whose contract is adoption, and it is exactly
the kind of "small obvious fix" that makes a phase unverifiable. It is written
into the journal and the source comment so it is a decision rather than an
oversight.

**Not taken:** _apply it now, it is one line._ Rejected on the phase's own rule
— and because the honest version of the change also wants a cell, and a cell for
a currently-unreachable path has to mint its own reachability, which is a design
question rather than a line.

## D35 · Three wire-observable changes, named rather than smuggled

**Recorded:** implementer, 2026-09-08, Phase 2 chapter 2.

1. **`text/html` → `text/html; charset=utf-8`** on the release surface — the
   kit's content-type map, which resolved the census's one divergence toward the
   correct copy. glamour is the third spell to inherit it.
2. **The SSE stream opens with a `: connected` comment.** It flushes the
   response headers so a quiet stream does not leave a `fetch()` unresolved.
   Every house tail client drops `:` lines; what it broke was two of glamour's
   own cells, which read LINE 0 of the stream and handed `JSON.parse` a comment.
   Both now take the first `data:` line.
3. **The teardown grace is 150 ms, not glamour's 50.** The number all eight
   daemons converged on independently, and the thing that makes a `closed` frame
   an observation rather than a hope — which matters here specifically, because
   `closed` is the frame glamour's own `tail` ends on.

**Not taken:** _preserve glamour's 50 ms by passing `graceMs`._ The option
exists, and using it would keep one spell on a number the other seven measured
their way off. _Keep `text/html` bare for byte-compatibility._ It is the wrong
answer, stated as such in the module.

## D36 · The coverage cell's gate becomes the INGREDIENTS of anchoring — because a backstop computed from the predicate it backstops is not a backstop

**Decided:** implementer, 2026-09-08, Phase 2 repair chapter, out of the verify
pass driving D27's claim.

**D27 claimed its coverage cell "fails on the next unrecognised spelling without
anyone having to think of it in advance". The claim was false, and driving it is
what showed that.** The cell gated on `declaresAnchor`, computed as
`ANCHOR_DIR.test(line) || ANCHOR_URL.test(line)` — **the same two regexes the
cell exists to backstop.** A spelling neither regex reads therefore scored
`declaresAnchor=false`, which made the file **exempt** rather than loud. The
cell could only fire on a file whose anchor the ward already understood, which
is the one case it was not needed for.

**Five spellings were driven** — each planted in glamour's real `dist/cli.js`
beside a `SERVER_SCRIPT` pointing at a nonexistent `dist/server.ts`, the exact
shipped defect of Phase 2 chapter 1 — and against D27's predicate **all five
passed 6 pass / 0 fail**:

| spelling                                                                                     | why it slipped                                                                                    |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `var __fileName = Bun.fileURLToPath(import.meta.url); var SCRIPT_DIR = dirname(__fileName);` | two-step; what esbuild/Bun emit for a `__filename` shim                                           |
| `var SCRIPT_DIR = import.meta.dirname;`                                                      | a real Bun/Node API `ANCHOR_DIR` does not name                                                    |
| `var SCRIPT_DIR = path.posix.dirname(node_url.fileURLToPath(import.meta.url));`              | TWO qualifier segments; `QUALIFIER` allows one                                                    |
| `var SCRIPT_DIR = dirname(fileURLToPath(new URL(import.meta.url)));`                         | an interposed `new URL(...)` inside the matched pair                                              |
| `var SCRIPT_DIR = dirname(__filename);`                                                      | the CJS pair — found by hunting a fifth AFTER the repair, and it broke the repair's first version |

**The repair: gate on the INGREDIENTS, at a level the anchor patterns cannot
reach past.** A module cannot ask where it is without naming one of
`import.meta.url`, `import.meta.dir`, `import.meta.dirname`, `fileURLToPath`
(under any qualifier), `__dirname`/`__filename`, or `Bun.main`. The cell now
requires, of every emitted `cli.js`/`server.js`:

1. **every ingredient-bearing line is READ** — recognised as an anchor, or
   yielding a pin of its own — and an unread one reds **naming the line**, which
   is what the next agent needs in order to teach the pattern the spelling;
2. **a file carrying any ingredient yields ≥1 pin** (D27's condition, kept).

A line that merely BINDS the helper (`import { fileURLToPath } from "url";`,
Bun's own preamble in five of six artifacts) anchors nothing and is excluded. A
backend that legitimately anchors nothing carries no ingredient, is exempt, and
stays exempt — asserted.

**All five spellings now red on the coverage cell**, each printing
`UNREAD ANCHOR SPELLING` with the line; the clean tree is 7 pass / 0 fail. The
mutation is no longer only a hand-drive: a synthetic calibration cell pins all
five plus the inert case, so the property cannot rot the way D27's did.

**The declared remaining hole, said out loud:**
`var SCRIPT_DIR = dirname(process.argv[1]);` still passes the coverage cell. It
is deliberately not an ingredient — a CLI bundle reads `process.argv` for
ordinary arg parsing, so naming it would red every artifact for nothing.
Anchoring off the entry path is separately wrong in a bundle a launcher imports,
which is B3's subject.

**Not taken:**

- _Add the four spellings to `ANCHOR_URL`/`ANCHOR_DIR`._ It is the obvious fix
  and it is the same mistake a fourth time: it buys the four that were thought
  of and leaves the fifth exempt. The fifth was found in twenty minutes.
- _Parse the emitted JS with a real parser._ Still genuinely better, still out
  of scope, and now with a stronger argument against urgency: the ingredient
  gate makes the regexes' blind spots LOUD, which is the property the parser was
  wanted for.
- _Require a readable anchor rather than accounting for every ingredient line._
  Weaker: a file with one readable anchor and one unread spelling beside it
  would pass, and the `__filename` shim is exactly that shape.
- _Report it and leave D27 standing, since the ward is green on the roster
  today._ Rejected on the same ground D27 rejected it: five spells port against
  this instrument next, and the whole point of the cell is the spell it has
  never seen.

## D37 · Building does NOT drag acc conformance in front of a spell

**Closed:** orchestrator, 2026-09-08. **Open since Phase 0**, where the proposal
listed it as a dependency to price rather than a surprise to absorb mid-phase:
_"confirm whether building drags acc conformance in front of the four spells
that have no acc.config.json (bounty, digestify, grapevine, imago)."_

**Measured: it does not.** Nothing in `grimoire/`, `scripts/` or `src/` requires
an `acc.config.json` to exist. The only two references in the tree are a
fresh-agent record from 2026-08-26 and glamour's own `cli-contract.test.ts` — a
spell-local test, not a ward. Four spells have a config (astrolabe, glamour,
magpie, mind-mapper) and four do not; the build is indifferent to which.

**Consequence for the roll.** Imago, bounty, digestify and grapevine port
without acquiring an acc grade, and their ports are not gated on one. Where a
spell DOES have a config, its grade is an acceptance criterion — glamour's
CONFORMANT L0 was re-run and held in Phase 2 — because a port that regrades what
an agent observes has changed behaviour.

**Not taken:** _add `acc.config.json` to imago as part of its port_ — it is a
day's work of its own, it is a different kind of change (a conformance grade,
not a build), and bundling it would make the first playbook-driven port the one
port that does not follow the playbook.

## D38 · imago's failure contract CHANGES at the port, because adopting `errors.ts` is not a de-duplication for a CLI that never spoke the envelope

**Decided:** implementer, 2026-09-08, Phase 3 chapter 2, on the playbook's
instruction to adopt all eight `src/kit/wire/` modules.

Imago's `die` wrote `imago: <msg>` to stderr as prose and exited **2**. The
kit's `die` raises a `CliError`, `main` reports ONE JSON envelope on stderr, and
the exit code comes from the taxonomy. **Every one of imago's 21 raise sites
changes its stderr bytes, and most change their exit code.** Driven:

| invocation                   | before                                      | after                                                  |
| ---------------------------- | ------------------------------------------- | ------------------------------------------------------ |
| `info` (no session)          | `imago: no running…` · exit 2               | `kind:"not_found"` envelope + hint · exit 5            |
| `state` (no session)         | prose · exit 2                              | `kind:"not_found"` · exit 5                            |
| `say` (no text)              | prose · exit 2                              | `kind:"usage"` · exit 2                                |
| `--nope`                     | prose · exit 2                              | `kind:"usage"` · exit 2                                |
| a 400 from the daemon        | prose, body discarded                       | `kind:"usage"`, the daemon's body under `error.server` |
| `state` / `say`, DEAD daemon | ⛔ raw Bun `TypeError` + stack · **exit 1** | `kind:"internal"` envelope · exit 1                    |

⛔ **CORRECTION, 2026-09-09 — THIS ENTRY SAID "2 FOR EVERY FAILURE" AND THAT WAS
FALSE, falsified by driving develop's CLI rather than by re-reading it.** The
old contract had **two shapes, not one.** `die` was one of them; the other is
that `api()` calls `fetch` with no handler at all, so a verb that reaches the
daemon with a **stale session pointer** never gets near `die`. Driven on
`develop` (`e88ae5e`) with a pointer naming a closed port: `state` and `say`
both print Bun's own source excerpt,
`TypeError: Unable to connect. Is the computer able to access the url?`,
`code: "ConnectionRefused"` and a two-frame async stack — and exit **1**, not 2.
(`info` never fetches; it prints the stale pointer and exits **0**.) So the
pre-port contract was "prose at 2 where the CLI raised deliberately, an uncaught
runtime crash at 1 where it did not."

**The claim's force survives the correction, and is if anything larger.** The
adoption replaced a _prose-and-mostly-2_ contract with the house taxonomy, and
the newly-named path is the one that improves most: the same invocation now
answers **one machine-readable envelope** — `kind:"internal"`, `exit_code:1`,
`retryable:false`, the command under `meta` — where it used to answer a stack
trace with the daemon's source lines in it. The **exit code there is unchanged
at 1**; what changed is that a caller can now route on it. Both halves driven
2026-09-09 on `feat/imago-backend-port`.

⛔ **THE REASON THIS NEEDED DECIDING AT ALL, AND IT IS A FINDING ABOUT THE
PLAYBOOK.** Phase B's B8 lists `errors` beside seven genuinely internal modules
and says nothing about it. It could not have noticed: **glamour, the spell Phase
B was written from, was already CONFORMANT L0** and had reached the envelope
shape independently, so its adoption had no observable delta. **Imago is the
first adopter for whom it does** — and per D37 imago has no `acc.config.json`,
so there is no grade to re-run and nothing in the gate would have said a word.

⚠ **And note what that means for D37, which this entry AMENDS rather than
contradicts.** D37's measurement — building does not drag conformance in front
of a spell — is true and was re-confirmed. But **the PORT drags a piece of
conformance in anyway, through B8**: the failure contract, which is the largest
observable surface an acc grade covers. A spell can come out of this port
speaking the L0 envelope without ever having been graded. Bounty, digestify and
grapevine are in the same position.

**Not taken:**

- **Keep imago's prose `die` and adopt only the throwing shape.** It preserves
  the wire and takes the drained-exit fix, which is the half that is strictly a
  bug. Rejected because it forks the module on its first real test: `errors.ts`
  IS the envelope and the taxonomy — a `die` that throws but prints prose is a
  fifth copy of the thing `wire/` exists to have one of, and the next spell
  would face the same choice with a precedent for splitting.
- **Adopt, and file the wire change as a defect to fix later.** Dishonest: the
  change ships in this commit either way; filing it would only mean not saying
  so.
- **Acquire an `acc.config.json` for imago so the change is graded.** D37's own
  not-taken option, for D37's reason — it is a day's work of a different kind,
  and it would make the first playbook-driven port the one port that does not
  follow the playbook.

## D39 · Imago stamps NO epoch, and L6 is NARROWED rather than closed

**Decided:** implementer, 2026-09-08, Phase 3 chapter 2. **Recorded because B8
does not name this as a decision at all, and it has to be made by every
adopter** — `createEventLog` takes `{ epoch }`, mind-mapper stamps one, and the
census's L6 is about its absence.

The criterion, which existed only as a comment inside
`src/glamour/backend/ server.ts` and is hereby written where an adopter will
find it: **a SESSION-scoped daemon stamps no epoch; a SINGLETON daemon is the
case that needs one.** A session is identified by `session_id`, a restart is a
DIFFERENT session, and a resuming tail is therefore already talking to a
different daemon by name. Imago is session-scoped, like glamour and magpie;
astrolabe, mind-mapper and grapevine are the other shape.

So L6 is **narrowed, not closed**, and saying which matters: `subscribe`
treating `since > cursor` as "that cursor came from another process, replay
whole" is what a resuming tail actually gets, and D23's equality gap stands
unchanged. The epoch query parameter that would close it is deliberately out of
scope here (D23), where it can be designed against all seven daemons.

**Not taken:** _stamp one anyway, since the module offers it_ — it would put an
epoch on the wire that no client reads, and D23 is explicit that the close is
epoch-aware on BOTH sides or it is not a close.

## D40 · The teardown ORDER is left divergent, and filed

**Decided:** implementer, 2026-09-08, Phase 3 chapter 2.

`drainAndStop` bounds the drain, but the steps around it stay hand-written, and
the two adopting session daemons now order them differently: glamour unlinks its
discovery pointer BEFORE emitting `closed` and draining; imago unlinks AFTER.
The observable difference is whether a CLI verb issued during the 150 ms grace
period can still find the session — under imago's order it can.

Left as imago had it. **Closing this means RULING the order across all seven
daemons**, which is a spine decision and not a port's to make, and imago's order
is not obviously the wrong one. Filed here so the next census finds a decision
rather than a discrepancy.

**Not taken:** _match glamour_ — it would silently pick a winner between two
undiscussed orders, on the authority of whichever spell ported first.

## D41 · Bun 1.4.0, declared — the pin and the build agree by construction

**Ruled:** Cole, 2026-09-09 — _"move to bun 1.4.0 to match the installed
version."_ Option 3 of
[the backlog item](../../backlog/2026-09-08-bun-pin-disagrees-with-the-bun-that-builds.md),
at Cole's version.

Before: `.bun-version` **1.4.0**, PATH bun **1.4.0**, and the bun that actually
built every shipped artifact **1.3.14** — arriving as `bun-plugin-tailwind`'s
peer, because bun was not a declared dependency at all. `bun run build` is a
package script, so it resolved `node_modules/.bin/bun`; a bare
`bun run src/build.ts` resolved PATH. Two bundlers, and the committed bytes
belonged to the one nobody had chosen.

**bun is now a direct devDependency at `1.4.0`.** All three agree. Cole ruled
the version; declaring it is what stops the class recurring, since the failure
was not "the wrong version" but "the version is a consequence of someone else's
peer range."

**The blast radius, measured rather than estimated:** all 8 spells, 48 artifact
changes — every surface chunk rehashed (both the `.js` and the `.css`) and all
six backend bundles rewritten. Gate **1964 pass / 0 fail** unpiped, and notably
**174 s against 267 s** on 1.3.14.

**Sequencing mattered and is worth recording.** The bump was queued behind the
imago merge on purpose: `bun install` swaps the bundler under any agent
mid-port, so a port's later chapters would emit 1.4.0 bytes over 1.3.14 bytes
from its earlier ones and its gate would describe neither tree. **A toolchain
change is not safe to land beside in-flight work that builds.**

**Not taken:** _move `.bun-version` down to 1.3.14_ — matches reality, rewrites
nothing, and enshrines a version chosen by a plugin's peer range. _Bump
`node_modules` without declaring bun_ — satisfies the ruling and leaves the
drift mechanism in place, so the next `bun install` on a fresh clone could
resolve differently again.

## D42 · Instruments read the TREE, not the index — and the rule under all three instances

**Decided:** implementer, 2026-09-09, `fix/instruments-read-the-index`.

Two instruments derived a population from `git ls-files` and then reported about
a spell whose emitted artifact was on the **disk** and not yet in the index as
if there were nothing to check. Both were driven before the repair, both
directions.

**Instance 1 — `grimoire/spawn-path-ward.test.ts`.** `emittedJs()` read
`git ls-files`. A corrupted pin
(`join(SCRIPT_DIR, "..", "NOWHERE", "server.ts")`) planted in an
on-disk-but-untracked `bounty/dist/cli.js` produced **not one new failure — 7
pass / 0 fail** — while the population line said
`17 emitted file(s) across 8 spell(s): astrolabe, bounty, …`. The spell was
NAMED and got **no coverage row at all** — not `pins=0`, no row. A missing row
reads as "nothing to cover"; it meant **"not looked at"**.

**Instance 2 — `scripts/dist-check.ts` ARM 1.** Its predicate was "≥1
**tracked** file in `dist/`". With imago's two backend artifacts unstaged
(`git rm --cached`), it printed `imago 3 tracked` and **PASSED on its surface
chunks alone**. Derived denominator, uncovered numerator.

**Instance 3, found by the sweep — `grimoire/import-boundary-wards.test.ts:291`,
`emittedSources()`.** An untracked `astrolabe/dist/probe-unstaged.js` carrying
`import "sharp"` — a bare non-builtin dependency, the precise subject of ward 1b
— passed the whole file **19 / 0**. Same subject class, same enumerator, same
silence.

**Why it mattered now:** all four remaining ports (bounty, digestify, grapevine,
mind-mapper) first-emit their backend artifacts, so all four pass through this
window.

### What was NOT broken, and was deliberately not "fixed" into a false alarm

**Nothing could actually LAND unguarded.** `dist-check` ARM 2 uses
`git status --porcelain` on purpose and lists an unstaged emitted artifact as
`??` → dirty → red, and the `.gitignore` un-ignore lines exist for all eight
spells. build → gate → commit cannot go green-then-commit. **The defect was that
the instrument was SILENT about a spell it had already named.**

### The shape chosen

**Read the DISK where the question is about the artifact; keep the index where
the question is about shipping; and never let either be silent about the
other.**

- **`emittedFiles()` (spawn-path ward) now reads the disk** and labels each file
  `staged` / `NOT STAGED`. The ward's question is "does the anchor arithmetic in
  the artifact the build just produced resolve?", and that artifact is on the
  disk whether or not anyone has run `git add`. Staging is `dist-check`'s
  question. The reverse divergence (tracked, absent from disk — a renamed hashed
  chunk) is now **printed as `INDEX-ONLY … not looked at`** instead of silently
  skipped.
- **`emittedSources()` (import-boundary wards) reads the UNION** — a tracked
  file the disk has lost is still a fact about what ships (ward 1a's subject),
  so it stays in the population and is filtered only at the point of reading.
- **`dist-check` ARM 1 measures BOTH numbers** (`3 tracked / 5 on disk`) and
  gains a **fatal ARM 1b**: every **backend** artifact on disk must be tracked.

**The false-positive question, answered rather than assumed.** "Read the disk"
invites stale build leftovers. It cannot accumulate them: `src/build.ts` `rm`s
each `dist/` before every build and `bun run gate` builds before it tests. A
leftover from a foreign checkout examined by a bare `bun test` produces a RED
naming a path — loud, and one `bun run build` from resolved.

**The fatal/non-fatal split is a real discriminator, not a compromise.** A
backend artifact has a **stable** emitted name (`[dir]/[name].[ext]`); a surface
chunk carries a content hash and is **renamed** by every content change. So an
untracked `index-<hash>.js` is ordinary work in progress — failing on it would
red the local gate on every surface edit, which is the same reason ARM 2 is
CI-only (Cole, 2026-09-01) — while an untracked `cli.js`/`server.js` **cannot**
mean that: a rebuild of a tracked one leaves it MODIFIED, not untracked. It
means the spell's backend has never been staged, which is the defect itself. The
non-fatal half is still **named** in the output, so no green can read as
"everything on the disk was examined".

### Calibration, both directions

| drive                                                              | before                                                 | after                                                                 |
| ------------------------------------------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------- |
| corrupted pin in untracked `bounty/dist/cli.js`                    | spawn-path ward **7 pass / 0 fail**, no row for bounty | **1 fail**, `NOT STAGED … pins=1` row + the pin named                 |
| same, `dist-check --no-build`                                      | `bounty 3 tracked` **✅ PASS, exit 0**                 | **⛔ FAIL exit 1**, artifact named with the `git add` remedy          |
| imago's `cli.js`+`server.js` `git rm --cached`                     | `imago 3 tracked` **✅ PASS**                          | **⛔ FAIL**, both named; `dist-roster-ward` ARM 1b red                |
| untracked `astrolabe/dist/probe-unstaged.js` with `import "sharp"` | import-boundary **19 / 0**                             | **2 fail**, `NOT STAGED` listed and the bare specifier named          |
| everything staged (clean tree)                                     | green                                                  | **green** — gate 1969 / 0 unpiped, `dist-check` all three arms exit 0 |

Three synthetic-repo controls were added so the enumerators cannot quietly
return to the index: one per instrument, each going **through the predicate**
against a repo the cell built (the ruling `trackedBuildInputs`'s control
earned), each shown discriminating — a staged file, a disk-only file, an
index-only file, and an empty measurement in the same run.

### The sweep — four sites judged DIFFERENT, and why

`grimoire/import-boundary-wards.test.ts` derives four more populations from
`git ls-files`. Each was driven; each is silent; **only one was fixed.**

- **`:291` `emittedSources` — SAME defect. Fixed** (instance 3 above).
- **`:166` `trackedSources` and `:1257` `backendSrc` — DIFFERENT.** Driven: an
  untracked `src/imago/backend/probe-unstaged.ts` carrying a cross-spell
  relative import, a re-export and `import "sharp"` passed **19 / 0**. The
  silence is real, but the subject is a **hand-authored source file the author
  has not added yet** — `git status` nags about it, the un-ignore trap does not
  apply, and "what ships" for source is defined by the tracked file list
  (Contract 20), so switching these to the disk would change the wards' subject
  and pull editor scratch into the population. The artifact case is different in
  kind: the divergence is created by a **machine the instrument itself runs**
  (`bun run gate` builds before it tests), so the instrument is _guaranteed_ to
  execute in the divergent state.
- **`:485` (launcher roster) and `:1028` (`spellNames`) — DIFFERENT.** Both
  sides of those comparisons are derived from the index, so an unstaged launcher
  or an unstaged skill folder leaves **both** at once: nothing is
  named-then-silent, which is the specific defect here. They are the weaker
  cousin — a population that can go short without contradicting itself — and are
  recorded rather than changed.

### The rule under all three instances

The project has now paid for this three times:

1. **A derived population is not coverage** (Phase 1b) — arriving in the
   denominator is not the same as being measured.
2. **A backstop computed from the same predicate it backstops is not a
   backstop** (Phase 2 / D36) — a spelling the predicate cannot read becomes
   _exempt_ instead of _loud_.
3. **A population read from the index is not a population read from the tree**
   (here) — the set git has is not the set the build wrote.

**The single rule underneath: an instrument must measure the thing it is asked
about, in the place where that thing actually lives — and where it cannot, it
must SAY SO in the same breath it names the subject. Every one of the three was
a measurement taken on a PROXY for the subject — a roster instead of coverage, a
predicate instead of the ingredient, an index instead of a disk — and each proxy
failed in the one direction none of them could report: SILENCE. So the operative
form is: a subject an instrument NAMES and does not EXAMINE must produce a row
that says "not looked at". Absence of a finding must never be spelled the same
way as absence of a subject.**

**Not taken:** _make every unstaged `dist/` file fatal_ — correct-looking, and
it reds the local gate on every surface edit, which is precisely the false alarm
the ARM 2 ruling already rejected; the stable-name/hashed-name asymmetry is what
lets the fatal clause be narrow and still catch the real case. _Leave the
enumerators on the index and merely PRINT the disk difference_ — the spawn-path
ward's silence would have become a warning nobody's exit code reads, and the
corrupted pin would still have passed; printing was already tried in Phase 1b
and D36 records what it bought. _Swap `emittedSources` to the disk outright_
rather than unioning — it would drop a tracked-but-deleted artifact out of ward
1a's shipping question, trading one silence for another.

## D43 · A backend entry is a `src/<spell>/backend/X.ts` with a LAUNCHER — the entry set is derived, not named

**Ruled:** Cole, 2026-09-09, on the Phase 4 pre-work measurement. Implemented
the same day on `chore/entries-derive-from-launchers`, as a refactor that
changes no artifact.

`src/build.ts` had two hard-coded entries — `backendEntryFor` =
`src/<spell>/backend/cli.ts`, `serverEntryFor` = `src/<spell>/backend/server.ts`
— built by two near-duplicate `Bun.build` calls. Enumerating the whole roster
before writing bounty's brief showed the assumption is wrong for **three of the
four remaining ports, in three different ways**:

| spell                                          | caller-facing entries                  | what `build.ts` did                             |
| ---------------------------------------------- | -------------------------------------- | ----------------------------------------------- |
| astrolabe, glamour, imago, magpie, mind-mapper | `cli.ts` + `server.ts`                 | correct                                         |
| **bounty**                                     | `cli.ts` + `server.ts` + **`join.ts`** | **missed `join.ts`** (SKILL.md names it twice)  |
| **digestify**                                  | **`review.ts` ONLY**                   | **built NOTHING — there is no `cli.ts`**        |
| **grapevine**                                  | `cli.ts` + **`daemon.ts`**             | **missed the daemon — there is no `server.ts`** |

**The rule: a backend entry is `src/<spell>/backend/X.ts` for which a launcher
`plugins/spellbook/skills/<spell>/scripts/X.ts` exists.** The launcher is
already the deployed contract — a fixed path, named in SKILL.md, enumerated by
`grimoire/lib/entry-points.ts`, pinned by `exit-site-inventory` and
`terminator-invariant`. So the entry set is a **fact about the tree** rather
than a list anyone maintains: the same principle `buildableSpells()` already
follows, and the same principle D36 and D42 (and its two siblings) came from
violating. Non-entry modules — `reduce.ts`, `state.ts`, `heartbeat.ts`, every
`*.server.ts`, every test — are excluded for free, with no naming convention and
no exclusion list.

It also collapses `buildBackend` and `buildServer` into one loop, which is where
the duplication that made a third entry unthinkable came from. **The loop still
issues one `Bun.build` PER ENTRY** — never one call with several entrypoints,
which would hoist shared modules into a hashed chunk and rewrite the other
entries' artifacts (Contract 18 verifies by reproduction).

**`--external '*/surface/index.html'` is now passed for every entry, not only
daemons.** D6's measurement is unchanged and was re-homed onto the merged
function rather than deleted: without it the bundler follows a daemon's
dev-branch `await import(".../surface/index.html")` into the surface graph and
dies compiling `@import "tailwindcss" source(none)`; with it the ONE specifier
survives byte-for-byte and resolves at runtime relative to `dist/`. For an entry
that never imports the surface HTML the flag has no subject and is inert — which
is what the acceptance criterion below measured rather than assumed.

### The acceptance criterion: same bytes, different derivation

**Proved, not argued.** Full roster rebuild through `bun run build`, then a
`git diff` and `git status --porcelain` restricted to the deployed dist roots:
**empty**. `bun run gate` 1975 pass / 0 fail unpiped, exit 0 (it rebuilds first,
so that is the no-op proved a second time). `bun scripts/dist-check.ts` exit 0,
all three arms, `32 tracked / 32 on disk` across 8 spells, ARM 2
`dirty paths 0`.

**The derivation prints for all eight spells:** astrolabe, glamour, imago,
magpie `[cli, server]`; bounty, digestify, grapevine, mind-mapper `[]`. **The
three unported spells are left EXACTLY as they are today** — they have no
`src/<spell>/backend/` at all, so they derive no entries and remain
not-buildable-as-backend until their port. No launcher was created for them.
`buildableSpells()` still returns all 8 (they have surfaces), so `dist-check`'s
and `spawn-path-ward`'s denominators are unchanged.

### The pairing ward, and what the tree contradicted

`grimoire/launcher-pairing-ward.test.ts` is new, because **the whole scheme now
rests on a pairing nothing checked**. Both populations are derived and neither
is computed from the other: the launcher side reads every shipped `scripts/*.ts`
for a `../dist/X.js` **import specifier**; the artifact side reads the emitted
`dist/` off the **DISK** (D42) and subtracts the surface's own reference closure
from `index.html`. Deriving the artifact side as "`cli.js` and `server.js`"
would have re-committed the exact hard-coding this decision removes; deriving it
as "a hashed name is a surface chunk" is a name test in a behaviour costume.

**D43 introduces a failure mode that did not exist before it, and cell C is for
that one.** `src/<spell>/backend/X.ts` plus ANY `scripts/X.ts` makes `X` an
entry — including an UNPORTED spell's real `scripts/cli.ts`, which is a full CLI
and not a launcher. mind-mapper, bounty, digestify and grapevine all ship such
files today, so all four sit one misplaced file away from a `dist/cli.js` that
nothing imports. Driven: creating `src/mind-mapper/backend/cli.ts` reds cell C
with _"build.ts derives entry "cli" from mind-mapper/scripts/cli.ts, but that
file does NOT import ../dist/cli.js — the emitted artifact would be
unreachable"_.

**Calibration, both directions** (real repo unless noted; every mutation
restored):

| drive                                                                  | before | after                                                        |
| ---------------------------------------------------------------------- | ------ | ------------------------------------------------------------ |
| clean tree                                                             | —      | **6 pass / 0 fail**, a row for all 8 spells                  |
| `rm astrolabe/dist/server.js` (launcher, no artifact)                  | —      | **2 fail** — cell A names the missing path, cell C the entry |
| `mv astrolabe/scripts/server.ts` away (artifact, no launcher)          | —      | **1 fail** — cell B: _"emitted and NOTHING imports it"_      |
| launcher re-pointed at `../dist/serverX.js`                            | —      | **3 fail** — A, B and C, C naming both directions            |
| `src/mind-mapper/backend/cli.ts` added (half-relocated, D43's own)     | —      | **1 fail** — cell C, before anything is even built           |
| synthetic root: paired · launcher-only · artifact-only · nothing-built | —      | the CONTROL cell, each world discriminated in one run        |

### ⛔ The instrument defect the ward itself committed, and was driven out of

**The first matcher took any quoted `../dist/X.js` anywhere in the file — and a
launcher is "a comment block and two lines" (playbook B2), where the comment
block names its own artifact.** Re-pointing astrolabe's launcher at
`../dist/serverX.js` therefore reported BOTH specifiers, and **cell C — the arm
written for D43's own failure mode — stayed green on the strength of a
comment.** Anchoring the match on the `from`/`import`/`require` form is the
repair; backticks are excluded from the delimiter set because prose quotes with
them and `biome` never emits them for a specifier. This is playbook Gotcha 12
("the ward reads prose") arriving for a third time, in the ward written to
enforce a rule about reading the tree.

### What the tree contradicted in the measurement table

**Nothing in the entry table** — it reproduced exactly. One correction to how
the table reads: it describes **caller-facing entries**, which for the three
unported spells live at `scripts/X.ts` as real sources, NOT at
`src/<spell>/backend/X.ts`. So the table is a statement about what those ports
must produce, not about what the tree holds today, and the generalisation
correctly builds nothing for them.

**One live blind spot found — filed for bounty's port, then PULLED FORWARD into
this branch** (Cole, same day: the instrument that guards a port must not be
repaired _by_ that port, competing with a 1,713-line daemon relocation).
`grimoire/spawn-path-ward.test.ts`'s `isBackendArtifact` was
`abs.endsWith("/cli.js") || abs.endsWith("/server.js")` — the same two
hard-coded names, in the instrument that checks anchor arithmetic. Exactly
correct today (the derived set is `cli` + `server` for all four built spells),
and **silently blind on bounty's `join.js`, digestify's `review.js` and
grapevine's `daemon.js`** the day those land. **It is repaired here — see D44.**

**Not taken:** _hard-code a third name `join.ts`_ — cheapest, and wrong twice
over before the roll ends (digestify has no `cli.ts`, grapevine no `server.ts`).
_A per-spell entry list in `build.ts`_ — explicit, and it is a hand-kept list,
which is the thing that goes blind on exactly the spell that arrives next. _A
naming convention (`*.entry.ts`)_ — derived, but it renames five spells' files
and every SKILL.md path that spawns them. _Derive from SKILL.md's spawn lines
instead of the launcher_ — closer to the human contract, and it makes the build
depend on parsing prose, which is Gotcha 12's whole subject.

## D44 · The surface/backend split is ONE shared derivation, and the spawn-path ward consumes it

**Ruled:** Cole, 2026-09-09, pulling D43's deferred blind spot forward into the
same pre-work branch. Implemented on `chore/entries-derive-from-launchers`, as a
refactor that changes no artifact and no ward's verdict on a clean tree.

`grimoire/launcher-pairing-ward.test.ts` already computed the honest split —
backend artifacts are `dist/*.js` minus the SURFACE's reference closure from the
emitted `index.html` — and `grimoire/spawn-path-ward.test.ts` answered the same
question with a hand-kept list of two names. **The derivation is now written
once, in `grimoire/lib/dist-artifacts.ts`, beside `entry-points.ts`**, and both
wards consume it. The ⛔ reasoning for the split (D36: deriving it as "`cli.js`
and `server.js`" re-commits the hard-coding D43 removed; deriving it as "a
hashed name is a surface chunk" is a name test in a behaviour costume) travelled
to the module rather than staying stranded in one caller.

**D42 is enforced by the return TYPE, not by each caller's memory.** `surface`
and `backend` are `string[] | null`, `null` meaning NOT LOOKED AT — the pairing
ward's `null`-not-`[]` discipline, hoisted from the launcher-reader to the
artifact-reader. `present: false` (no `dist/` at all) yields `null`; a `dist/`
with no `index.html` is LOOKED AT and its empty surface closure is the right
answer. `isBackendArtifact()` returns `boolean | null` for the same reason, and
the spawn-path ward collects any `null` into a list it asserts empty rather than
coercing it to `false` — unreachable by construction today, and the silence it
would be the day it is reachable is exactly this decision's subject.

### ⛔ What the extraction contradicted in D43's own description of the defect

**"Silently blind" was half right, and the half it got wrong is the more
dangerous half.** Driven on the real tree, with an untracked
`bounty/dist/join.js` — the shape bounty's port really produces:

| planted `bounty/dist/join.js`                                                   | ward BEFORE         | ward AFTER                                      |
| ------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------- |
| readable anchor (`dirname(fileURLToPath(...))`) + pin at `../NOWHERE/server.ts` | **1 fail**          | 1 fail (+ a coverage row that did not exist)    |
| **unreadable anchor (`import.meta.dirname`) + the same bad pin**                | **8 pass / 0 fail** | **1 fail** — `join.js:2 UNREAD ANCHOR SPELLING` |

The "every shipped pin RESOLVES" cell walks `emittedJs()` — every emitted `.js`,
not just the backend ones — so a `join.js` whose anchor the ward CAN read was
already covered by it. The name list gated only the COVERAGE cell, which is the
cell that catches an anchor spelling the ward cannot read. So the blind spot was
narrower AND worse than filed: it was blind precisely on the case where the ward
computes no pins, which is the case where a missing coverage row is
indistinguishable from a clean file. That is D42's silence living inside the
cell written to end it, and it took planting the artifact to see it — reading
the predicate suggested the wrong half.

**Calibration, both directions** (real repo unless noted; every mutation
restored):

| drive                                                                   | verdict                                                     |
| ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| clean tree, both wards                                                  | **15 pass / 0 fail** (9 spawn-path, 6 pairing)              |
| `bounty/dist/join.js`, unreadable anchor + bad pin (untracked)          | spawn-path **1 fail**, naming the line; was 0 before        |
| `bounty/dist/cli.js`, corrupted pin, untracked (D42's own drive re-run) | spawn-path **1 fail**, pairing **1 fail** (orphan artifact) |
| synthetic root: surface closure vs `join.js`/`review.js`/`daemon.js`    | the new CALIBRATION cell — all three classified as backend  |

**Acceptance, as measured:** full-roster `bun run build`, then `git diff` /
`git status --porcelain` over the deployed dist roots — **empty**. Gate **1976
pass / 0 fail** unpiped, exit 0 (1975 + the new calibration cell).
`bun scripts/dist-check.ts` exit 0, three arms, `32 tracked / 32 on disk`, ARM 2
`dirty paths 0`.

**Not taken:** _leave it to bounty's port_ — D43's original filing, and it makes
the port repair the instrument that guards the port. _Teach the spawn-path ward
its own copy of the closure walk_ — two derivations of one fact, which is the
two-denominators defect `entry-points.ts` exists because of. _Have the
spawn-path ward read `backendEntryNames()` from `src/build.ts` instead_ — it
derives from the SOURCE tree, so it cannot see an artifact the build no longer
emits but `dist/` still holds, and it would make a check of the build's
derivation a restatement of it (D36).

## D45 · bounty's failure contract CHANGES at the port — and B8's uncaught-`fetch` prediction is falsified

**Decided:** implementer, 2026-09-09, `feat/bounty-backend-port` chapter 2.

D38 is the worked example and this is its second instance: adopting
`src/kit/wire/errors.ts` re-spells every failure a CLI can produce, and for a
spell that did not already speak the envelope it is a **caller-visible change**,
not a de-duplication.

**Measured by RUNNING the failing invocations, before and after** — never
characterised from `die` alone, which is the discipline D38 earned:

| invocation                                    | before            | after                            |
| --------------------------------------------- | ----------------- | -------------------------------- |
| `badverb`                                     | prose, **exit 2** | envelope `usage`, **exit 2**     |
| `add` (no title)                              | prose, **exit 2** | envelope `usage`, **exit 2**     |
| `update` (no id)                              | prose, **exit 2** | envelope `usage`, **exit 2**     |
| `block t1` (no `--on`)                        | prose, **exit 2** | envelope `usage`, **exit 2**     |
| `state --session <nonexistent>`               | prose, **exit 2** | envelope `not_found`, **exit 5** |
| `state` with a stale pointer at a closed port | prose, **exit 2** | envelope `not_found`, **exit 5** |
| `message hello`, same stale pointer           | prose, **exit 2** | envelope `not_found`, **exit 5** |

Before: `bounty: <msg>` on stderr, stdout empty, **2 for everything**. After:
one JSON document on stderr, stdout still empty, and the taxonomy — so a caller
can tell "that board is gone" from "you typed it wrong". SKILL.md's agent-facing
notes now state the codes and warn that a script testing `exit == 2` for "no
session" must test `5`. Where the daemon itself refused, its reply rides
`error.server` verbatim (the field D31 widened for glamour).

### ⛔ What the tree contradicted

**B8 says the uncaught-`fetch` shape "is common to every spell whose CLI talks
to a session daemon". It does not exist in bounty.** imago's `api()` fetches
with no handler, so a stale pointer crashes with a raw Bun `TypeError`
(`code: "ConnectionRefused"`) at exit 1. bounty's `resolveSession` **probes
liveness before it ever fetches**, so the same stale pointer raises deliberately
through `die` — driven on two verbs, both `not_found`. The generalisation held
for four spells and failed at the fifth; it is narrowed here rather than
deleted, because the shape is still what an unguarded `api()` produces.

**Not taken:** _keep the local `die` and only adopt the daemon-side modules_ —
the CLI would then be the one half of the spell not on the spine, and `errors`
is the module whose absence a caller can actually observe. _Adopt `errors` but
map every kind to 2_ — preserves the contract byte-for-byte and throws away the
only thing the adoption is for. _Treat "no running session" as `usage`_ —
defensible (the caller could pass `--session`), and it collapses the distinction
the taxonomy exists to make: there is no board, which is what `not_found` means.

## D46 · The shutdown watchdog stays at bounty — the kit's pre-commitment is FALSIFIED, and its real window was never the claimed one

**Decided:** implementer, 2026-09-09, driven. This was the port's central design
question, assigned in the brief.

`kit/wire/housekeeping.ts` named bounty's watchdog as a deliberate ABSENCE
(D17's "what it refused is part of the ruling") and pre-committed to a
resolution: _"when a spell with a signal path adopts this, the watchdog arrives
as an option on these arguments and the reasoning is already written down."_
bounty is that spell. **The option was not added, and the prediction is recorded
as falsified in the kit's header rather than quietly dropped.**

### Why the option is the wrong shape — the WINDOW, not the placement

A `watchdogMs` on `drainAndStop` would arm at **drain** time. bounty's arms at
**signal** time, and the stretch between them is the entire reason it exists:
`await done`, an fs append to the daemon log, the housekeeping stop, a FULL
snapshot write that can rotate and copy a backup of a large board, a `closed`
frame and a broadcast. `drainAndStop`'s own body is already bounded by its two
numbers (150 ms grace + a 200 ms stop race). So a watchdog scoped to it would
guard the one stretch that cannot hang and abandon the stretch that can.

### ⛔ And driving it found that the watchdog did not cover ITS OWN claimed window

`clearTimeout(shutdownWatchdog)` sat four lines into a fifteen-line teardown,
under a comment reading "`clearTimeout` sits at the end of the teardown". Driven
with a 2 s watchdog, a hang planted in a COPY of the shipped artifact, SIGTERM,
and the death timed:

| hang point            | before (armed / disarmed)   | after (armed / disarmed)   |
| --------------------- | --------------------------- | -------------------------- |
| `await done`          | 143 @2002ms / RUNNING @10s  | 143 @2002ms / RUNNING @10s |
| the final snapshot    | RUNNING @10s / RUNNING @10s | 143 @2004ms / RUNNING @10s |
| inside `drainAndStop` | RUNNING @10s / RUNNING @10s | 143 @2003ms / RUNNING @10s |

Two rows where **armed and disarmed are indistinguishable** is the measurement.
The clear moved to the end (`fix(bounty)`, its own commit); the stated reason
for clearing early — "the REF'd timer must stop holding the event loop or the
natural drain never happens" — does not hold, because there is no natural drain:
`main` returns and the LAUNCHER calls `process.exit(exitCode)`, and a ref'd
timer cannot delay an explicit exit.

**So the pre-commitment was wrong twice over**: the option would have covered a
stretch the watchdog never reached, while still abandoning the longest unbounded
step — it would have READ as adoption and BEEN a narrowing.

### The transferable rule, written into the kit's header

_The question is never "does this module have a place to put a watchdog" but
"does the watchdog's window coincide with this module's"._ Where a spell's
teardown has unbounded work BEFORE the drain, the watchdog belongs at the spell,
around all of it. If a spell ever appears whose signal path enters
`drainAndStop` immediately, add the option then — and it must take an `onExpire`
callback rather than exiting, so the `process.exit` stays outside a module every
spell bundles (D8's direction).

**Not taken:** _add `watchdogMs` to `DrainOptions`_ — the pre-commitment, and
the measurement above is why. _Add `armShutdownWatchdog()` as a separate kit
export taking `onExpire`_ — genuinely tempting: it shares the two scars (REF'd
deliberately, because an unref'd timer cannot rescue a hang; cleared at the END,
not optionally) without sharing the `process.exit`. Refused for now because it
has exactly ONE consumer and the thing worth sharing is six lines of
`setTimeout` plus two paragraphs of prose — the prose now lives in the kit's
header, which is where the next adopter will read it, and the code can follow
the second spell that needs it. _Leave the watchdog un-ruled because bounty
"already had it"_ — the brief's question was what happens to it under adoption,
and not asking is how the clear-placement defect would have survived a fifth
reading.

## D47 · Three wire-observable changes at bounty's adoption, named rather than smuggled

> ⚠ **AMENDED 2026-09-09 (the repair chapter): THERE ARE FOUR, AND THE TITLE
> UNDERCOUNTED.** A verify pass found a fourth on bounty's own wire —
> `GET /events` now opens with `: connected\n\n` before any frame, because
> `sse.ts` writes an opening SSE COMMENT to flush the response headers (some
> clients, Bun's own `fetch()` among them, buffer until the first body byte, so
> a quiet stream would otherwise leave the caller's `fetch()` unresolved).
> bounty's own loop wrote no preamble. It is a comment line: every house tail
> client — and the spec — drops `:` lines, `cli.ts tail` included, and nothing
> in the suite or the surface reads it. **But "a caller cannot see it" and "the
> bytes did not change" are different claims**, and a section titled "named
> rather than smuggled" that lists three of four is making the second while
> meaning the first. A fifth arrives with D51: `/cmd`'s refusal replies now
> carry a `kind` beside `applied` and `error` — additive, and read by the CLI to
> pick the exit code. Counted here so the count is the measurement rather than
> the memory of one.

**Decided:** implementer, 2026-09-09. D20 and D35's shape, third instance.

1. **Presence leaves the replay log (census L7).** `connected` / `disconnected`
   went through `emitEvent`, so they were buffered and a tail resuming at
   `--since 0` replayed the whole browser-presence history of the session — and
   each replayed frame ADVANCED the agent's cursor, so presence churn pushed
   real events out of a bounded window. They now go to live tails only, through
   `sse.ts`'s `client.send` (the widening Phase 2 made for glamour; bounty is
   its second consumer and needed no further kit change). **The caller-visible
   delta: they no longer carry an `id`**, because an unlogged frame has no
   cursor position. SKILL.md's event table says so. Nothing in the surface or
   the suite read that `id`; the browser learns presence over its own WebSocket.
2. **`--timeout 0` means NEVER, not "close immediately".** bounty's local
   `shouldIdleClose` lacked astrolabe's `timeoutMs <= 0` guard — the one thing
   that came back the OTHER way when bounty met its own converged code. Driven:
   a board opened with `--timeout 0`, unwatched, is still alive at +1.5 s and +3
   s. Nothing documents 0 as a value and nothing in the suite drove it; the old
   reading was the accident of a `>=` comparison.
3. **`tail` returns instead of exiting.** Adopting `tailEvents` took bounty's
   CLI to ZERO live `process.exit` sites (the fifth CLI, after magpie,
   mind-mapper, glamour and imago). The exit code is unchanged (0 on `closed`);
   what changed is that a `closed` frame the scope filter REJECTED is still
   emitted, which the old loop achieved by guarding the exit outside the filter
   and which is now `terminalEmitsFiltered: true`.

## D48 · bounty stamps NO epoch; L6 is NARROWED, not closed

**Decided:** implementer, 2026-09-09, applying D39's criterion.

**A SESSION-scoped daemon stamps no epoch; a SINGLETON is the case that needs
one.** bounty is session-scoped: a board is identified by `session_id`, a
restart is a different session with a different id, and a resuming tail is
talking to a different daemon BY NAME rather than by watermark. So L6's
ambiguity (after a restart `seq` restarts at 0 and a resuming client cannot
distinguish a stale watermark from a fresh one) cannot arise through bounty's
own discovery.

**The residue, named, because "narrowed" without a residue is "closed" in
disguise:** a caller that carries a cursor across a restart BY HAND — reusing
`--since N` against a board reopened with the same `--session-key`, which
derives the same id deliberately (#69) — still cannot tell the two logs apart.
Smaller than L6: it needs a caller doing something deliberate, not a daemon
restarting underneath a tail.

## D49 · `dist-check` ARM 1b read two file NAMES — the third surviving copy of D43's hard-coding

**Decided:** implementer, 2026-09-09, landed as its own commit before chapter 2.

`scripts/dist-check.ts`'s `isBackendArtifact` was
`endsWith("/cli.js") || endsWith("/server.js")` — the names D43 removed from
`src/build.ts` and D44 removed from `spawn-path-ward.test.ts`, alive inside the
arm D42 built for the first-emit window.

**Found by driving it.** `git rm --cached` on bounty's freshly emitted
`dist/join.js` — the exact shape this port produces — gave **exit 0**, the
artifact demoted into the NON-FATAL "expected mid-edit" list beside rebuilt
surface chunks. digestify's `review.js` and grapevine's `daemon.js` were behind
it. Reading the predicate would have suggested the same conclusion D43 drew
about the spawn-path ward and, as with D44, planting the artifact is what showed
the real shape.

The split is now imported from `grimoire/lib/dist-artifacts.ts`; `null` (NOT
LOOKED AT) throws rather than being coerced to `false`. `dist-roster-ward`'s
control gained a third entry name and a staged `index.html` — the old control
spelled only the two names the clause knew, and a synthetic `dist/` with no
entry page is a spell with no surface, where every `.js` is correctly backend
and the discrimination does not exist.

**Not taken:** _leave it to digestify's port_ — the same argument D44 rejected:
the instrument that guards a port must not be repaired by that port. It is
repaired here because bounty is the port that MADE it observable, and the fix is
20 lines rather than a competing concern. _Teach dist-check its own closure
walk_ — two derivations of one fact.

## D50 · The `bun` exemption is RE-ARGUED, not re-declared — its population reached zero at bounty

**Decided:** implementer, 2026-09-09.

`import-boundary-wards`' ward 1b carried a cell asserting that removing `bun`
from `BUILTIN_EXACT` reddens the ward on a named list of files, and its comment
said in as many words: _"bounty is the last holder, and this floor now rests on
ONE file: when bounty ports, this cell has no population and the exemption it
guards must be RE-ARGUED rather than silently kept."_ bounty's
`import type { ServerWebSocket } from "bun"` is type-only, the fifth departure
by that mechanism, so the bundler erased it and the measurement is now
**empty**.

**The argument, which no longer rests on the roster:**

1. **`bun` is not a dependency, and that is the ward's actual subject.** The
   ward asks whether the shipped execution path reaches for something a caller
   must INSTALL. The bare specifier `"bun"` is the runtime's own module, present
   wherever `bun` is. An empty population is not evidence against the exemption
   and was never evidence for it.
2. **The disjointness clause is a different clause.** `bun:sqlite` and every
   `bun:`-prefixed specifier is exempted by `BUILTIN_PREFIX` (asserted directly
   in the synthetic cell). Deleting `bun` from `BUILTIN_EXACT` narrows the ward
   by exactly one specifier.
3. **The population is not closed.** Three spells still ship daemons as SOURCE.
   The day one writes this dependency where the bundler does not erase it — or
   any spell needs a VALUE import of Bun's API — the row returns.

**The liveness proof MOVES rather than dying with the population.** It now rests
entirely on D16's synthetic cell, which EVALUATES the exemption against a
population the file constructs. Driven: with `BUILTIN_EXACT` emptied, the suite
still reds (1 fail, in the scoping cell) on a tree where no spell writes the
import at all. And the empty measurement is spelled as **looked at and empty**
(D42) — the cell asserts a non-zero denominator FIRST, so deleting
`DECLARED_EMITTED_ROOTS` would make it redder, not greener.

**Not taken:** _delete the exemption_ — correct-looking with an empty
population, and wrong: it would red the day any spell ships a value `bun`
import, over a specifier that needs no installing. _Keep the cell asserting an
empty array with no denominator check_ — the D42 defect, in the file that has
now paid for it twice.

## D51 · The failure contract is completed at the cooperative refusals — and the TAXONOMY travels on the wire

**Decided:** implementer, 2026-09-09, `feat/bounty-backend-port`, the repair
chapter. D45 is the ruling this finishes; found by an independent verify pass
that drove it.

D45 adopted `kit/wire/errors.ts` and moved seven failing invocations onto the
taxonomy. **It did not move the refusal bounty produces most often.**
`ackOrFail` and the `add` / `claim` / `block` / `unblock` / `remove` arms still
wrote prose to stderr, put a legacy `{"ok":false,"applied":false,…}` document on
**stdout**, and returned **1** — which the very taxonomy that chapter adopted
defines as _the spell broke_. So a cooperative refusal, the case where the spell
worked perfectly and the board said no, was coded as an internal fault. And
`conflict` (6) was advertised in SKILL.md and **emitted nowhere**: zero
`die(…, "conflict")` sites in the whole spell.

**Driven, on a booted daemon, every converted path, before and after:**

| invocation                                 | before                             | after                       |
| ------------------------------------------ | ---------------------------------- | --------------------------- |
| `add` a duplicate `--id`                   | 1 · prose + `{ok:false}` on stdout | **6** `conflict`            |
| `claim` an other-owned task                | 1 · prose on stderr                | **6** `conflict`            |
| `block` that forms a cycle                 | 1 · prose on stderr                | **6** `conflict`            |
| `block --on <ghost id>`                    | 1 · prose on stderr                | **5** `not_found`           |
| `update` / `remove` / `unblock` a ghost id | 1 · prose on stderr                | **5** `not_found`           |
| `ackOrFail` (`init`, `close`)              | 1 · prose + `{ok:false}` on stdout | **6**, or the daemon's kind |

Stdout is empty on all of them; the daemon's own reply rides `error.server`
verbatim (D31's field), which is where `applied:false` now lives.

`ackOrFail`'s branch is not reachable through any real verb today — the daemon
answers `message` / `init` / `close` with `applied:true` — so it was driven
against a **stand-in daemon that refuses everything**, in both the kind-present
and kind-absent directions. A contract change that cannot be reached by a verb
is still a contract change; refusing to drive it because it is inconvenient is
how the pre-port shape survived a chapter.

### ⛔ The taxonomy is decided at the DAEMON, because the CLI cannot see it

`ApplyResult` gains `kind`. From the CLI a claim conflict and a ghost id arrive
identically — `applied:false` plus a sentence — and `block` alone answers with
BOTH kinds depending on which guard fired. Classifying at the CLI therefore
means matching on the sentence, which is glamour's ECONNRESET shape (D34) and
rots the day someone rewords a human-facing string. `kind` is the contract;
`message` is presentation; the module says so in its own header.

An absent `kind` degrades to **`conflict`**, not to `internal` and not to 2: it
is the genus of every refusal that reaches the funnel, so a daemon build that
predates the field answers with the right family and one wrong species rather
than a lie about whose fault the failure is.

### The one refusal deliberately NOT converted, and why

**`open`'s attach refusal** (`--title`/`--timeout`/`--restore` against a board
already running) keeps exit `2` and keeps printing the live board's discovery
JSON — `url`, `port`, `session_id`, `restoreSkipped` — on **stdout**. The house
taxonomy has a `kind` for it; what it has no room for is a refusal that CARRIES
DATA. The payload is the answer to the caller's next question ("then where is my
board"), and `ErrExtra` has `hint`, `choices` and `server` — where `server` is
reserved, in as many words, for the upstream's body verbatim. Converting would
delete coordinates a caller needs; smuggling them into `server` would break the
one guarantee that field exists to make. It is named in SKILL.md as the single
exception, recognisable by `restoreSkipped.requested`.

**Not taken:** _widen `ErrExtra` with a payload field_ — a fifth consumer's
boundary problem is a finding about the module (Phase 2's rule), and this one is
not that: a failure carrying a data payload is a second contract wearing the
first one's envelope, and it would land in every spell that bundles `errors.ts`
to serve one call site. _Convert `open` and drop the payload_ — trades a real
caller affordance for uniformity. _Classify the refusals in the CLI by their
prose_ — D34, deliberately not repeated. _Map every refusal to `conflict`_ —
simpler, and it collapses "there is no such task" into "a precondition failed",
which is the distinction `not_found` exists to make. _Leave `applied:false` on
stdout beside the envelope_ — the two-channel shape the old comment defended;
the exit code already tells a refusal from a benign silence, and a caller that
must parse two formats to use one tool is worst served on the failure path.

## D52 · `join.ts` adopts the envelope for STARTUP failures — and session ENDINGS keep their own numbers

**Decided:** implementer, 2026-09-09, the repair chapter, driven both sides.

`join.ts` never adopted `errors.ts` at all. Its failures — no discovery file, an
unknown `--id`, an unreachable `--url`, a bad flag, a connect refusal — all
exited **2** with bare `error: <prose>` on stderr. So the **two caller-facing
entries of ONE spell disagreed about what a failure looks like**, and nothing in
the records said so: SKILL.md tells an agent to spawn both, and an agent that
does had to parse two formats to use one tool.

| invocation                      | before              | after                           |
| ------------------------------- | ------------------- | ------------------------------- |
| `--nope` (a bad flag)           | 2 · prose           | **2** `usage`, enveloped        |
| no discovery file               | 2 · prose           | **5** `not_found`               |
| `--id` with no session file     | 2 · prose           | **5** `not_found`               |
| `--id` / `--url` at a dead port | 2 · TWO prose lines | **5** `not_found`, ONE document |

The connect-refused path used to print `join: ws error: …` AND the failure line;
that diagnostic is now silenced before the handshake, because "ONE JSON document
on stderr" is the contract and a prose line above it is a second document.

**What does NOT convert, ruled rather than overlooked: the ending family.** A
clean disconnect is 0 and a mid-session socket error is 2, both reported by the
terminal `disconnected` frame on stdout. Those are OUTCOMES, the same family as
the host daemon's own 0 / 124, which the taxonomy does not govern either — not
refusals of a caller's command. ⚠ **The named residue:** `2` now means both
`usage` and "ended by error". They are distinguishable by the CHANNEL — an
ending always writes the `disconnected` frame and never an envelope; a startup
failure is the reverse — and not by the number. SKILL.md's join table says so.

**Not taken:** _convert the ending too, remapping the error ending to `internal`
(1)_ — tempting for uniformity, and it was refused because the ending could not
be DRIVEN here (killing the host fires `close`, not `error`), and changing an
exit code that nothing in the suite reaches on the strength of a reading is the
opposite of what this chapter is for. _Leave `join.ts` alone and record the
divergence_ — the brief's alternative, and it loses: the divergence is not a
considered design, it is a module one entry adopted and the other did not.
_Adopt only for the discovery failures_ — a bad flag is the most ordinary
failure an entry has, and leaving one prose path keeps the two-formats problem.

## D53 · The shutdown watchdog arms at the RESOLVE, so all four teardown entries are covered

**Decided:** implementer, 2026-09-09, driven. This narrows D46, which is
otherwise unchanged — the watchdog still stays at bounty, unshared.

D46 established WHERE the watchdog belongs and left a claim standing that the
code had never earned. `server.ts` has **four** `resolveDone` sites — the signal
handler, the `close` verb, the browser's "Close board" over the WebSocket, and
`onIdleClose` — and all four run the same fifteen-line teardown. **Only the
signal one armed the watchdog**, from inside `requestShutdown`, while the
comment above it said "this makes the ending unconditional" and D46 called it
"the only unconditional termination guarantee in the corpus". It was the
guarantee of one entry in four.

⚠ **And the unguarded idle path is exactly the orphan-daemon class the 23-minute
hang came from**: a board nobody is watching, ending by its own timer, with
nobody present to notice that it did not end. The entry where a hang costs the
most was the one a signal handler could never reach.

**Driven** — hang planted between `drainAndStop` and `cleanupDiscovery` in a
COPY of the shipped artifact, `BOUNTY_SHUTDOWN_WATCHDOG_MS=2000`, with a no-hang
control that dies in ~150 ms on every entry:

| entry            | before        | after        |
| ---------------- | ------------- | ------------ |
| signal (SIGTERM) | 143 @2002 ms  | 143 @2002 ms |
| `close` verb     | RUNNING @10 s | 143 @2003 ms |
| WS `"user"`      | RUNNING @10 s | 143 @2004 ms |
| idle timeout     | RUNNING @10 s | 124 @2004 ms |

The arming moved INTO `resolveDone` rather than being pasted at the four call
sites: a fifth entry added later then inherits the guarantee instead of needing
someone to remember it, which is precisely the failure being repaired. The
`settled` latch already made the resolve once-only, so the timer arms once. The
forced exit reports the RESOLVING code, so an idle-timeout hang still dies 124
rather than borrowing a signal's number — and as a side effect the two
byte-identical `process.exit(code)` sites in `exit-site-inventory`'s map are now
distinguishable, an ambiguity that map documented and could not fix.

A source-scanning ward pins it (the property is an ABSENCE — no entry without a
guarantee — and observing it needs a planted hang, which is a calibration drive
and not a suite cell): exactly one arming site, inside the resolver, above
`requestShutdown`, with all four entries present.

**Not taken:** _arm at each of the four call sites_ — correct today and it is
the shape that produced the defect; the fifth entry is the one that would be
missed. _Narrow the words instead of the code_ — the brief's explicit
alternative, and it fails on the idle path: there is no reason an idle close
should be allowed to hang, so the sentence was right and the code was wrong.
_Move the arming into `drainAndStop`_ — D46, still falsified: the window would
start after the unbounded work.

## D54 · Two instruments D42 built, both violating D42 — a silent green and a title that outlived its cell

**Decided:** implementer, 2026-09-09, both driven both ways.

**`dist-check` ARM 1b printed nothing when it passed.** On a clean tree the
output went from ARM 1's `✅ PASS` straight to ARM 2 — so "1b ran and found
nothing" and "1b never ran" were the same bytes, which is the exact silence D42
was written about, inside the arm D42 added. It now prints a header and a
`looked at` line on the pass. ⚠ **The denominator is the DISK, not the untracked
set**: `0 untracked` is the number a broken enumerator prints, so the line leads
with the population that must be non-zero for the comparison to mean anything.
Driven: clean tree (PASS, with the line), and an untracked backend artifact
planted in bounty's `dist/` (still FATAL, exit 1).

**`import-boundary-wards`' cell titled _"the `bun` exemption is LIVE — this cell
FAILS if BUILTIN_EXACT loses it"_ now passes when `BUILTIN_EXACT` loses it.**
D50 moved the liveness proof to the synthetic cell when the population reached
zero at bounty's port; the title kept the claim. Driven with `BUILTIN_EXACT`
emptied: **this cell green, the synthetic scoping cell red** — so the guarantee
still holds and this cell is no longer what holds it. Renamed to what it
asserts, with the record of what it used to claim. A title making a claim its
cell no longer makes is the vacuity this file's own header records convicting
someone of once, and it is worse than a missing cell: a reader who greps for the
guarantee finds a green cell that names it and does not test it.

**Not taken:** _delete the renamed cell_ — its roster measurement is real
(looked at, non-zero denominator, empty result) and it is where a returning
`bun` import would show up. _Restore the liveness claim by re-pointing the cell
at the synthetic population_ — that is the synthetic cell, and two derivations
of one fact is the defect `entry-points.ts` exists because of. _Leave both and
file them_ — they are one-line repairs in the instruments that judge every
remaining port.

## D55 · Phase B dispatches on PROPERTIES OF AN ENTRY, not on the names `cli` and `server`

**Decided 2026-09-09, in pre-work for digestify. Nothing was ported.**

D43 corrected Phase B's arithmetic — the entry set is derived from launchers,
not fixed at two — and **left the body of the phase keyed on a `cli`/`server`
pair.** An independent verify pass read Phase B cold, as digestify's porting
agent, and found four steps that produce a wrong result if followed literally by
a spell with ONE entry called `review.ts`. Two of the four go wrong silently.

**The ruling: a name is a guess at a property, and Phase B now asks for the
property directly.** Four questions, answered per entry before B1, and every
step below dispatches on an answer rather than on a filename:

1. **What arithmetic does the entry carry?** — governs B3's `import.meta.main`
   permission, B4, B5.
2. **Does it serve a substituted or re-addressed payload?** — governs B8's
   `serveFromDist` row.
3. **Does the spell have a second half?** — governs B8's `heartbeat.ts` seam.
4. **Long-running or single-shot?** — governs which of B8's eight module rows
   have a subject at all, and the epoch ruling.

**Why a name was never the property.** The five spells that went first each had
a `cli.ts` that computed nothing from its own location and a `server.ts` that
computed everything from its own location, so "CLI" and "daemon" predicted the
arithmetic perfectly — for those five. Digestify's `review.ts` is a **CLI by
stdout contract** (one JSON object an agent parses), a **server by lifecycle**
(`Bun.serve`, blocks until a human submits), and a **daemon by arithmetic**
(`SKILL_ROOT = join(SCRIPT_DIR, "..")`). One entry, three answers. Bounty had
already produced the same split once — `join.ts` is a CLI by stdout that ships
the DAEMON launcher shape — and **a non-obvious pairing twice out of two is the
argument that the correlation was an accident of the first five.**

**The four repairs, each re-homed rather than replaced:**

| step   | was keyed on                                     | now keyed on                                                                                                                                                         |
| ------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B3** | "the CLI may keep both entries"                  | may keep `import.meta.main` **iff every path it computes from its own location resolves from `src/<spell>/backend/`**                                                |
| **B5** | re-pin ward 1a at `…/dist/server.js` (a literal) | re-pin at **`…/dist/<entry>.js`**, derived from the file that carries the specifier — with digestify's row spelled out                                               |
| **B7** | `exit-site-inventory` "reds once per chapter"    | **grep the lists first**; a list with no row for your spell is NO SUBJECT and is reported as such                                                                    |
| **B8** | eight modules, "all of `src/kit/wire/`"          | a subject test per row; four have none for a single-shot spell, and the `serveFromDist` row carries the router/refusal boundary the kit's own header already records |

**Not taken:** _a "single-entry spells" appendix_ — an exception in a footnote
is read by whoever already knows to look for it, and the porting agent who
needed it is by definition the one who does not; it also leaves the four wrong
steps wrong in the body. _Rewrite the phase generically and drop the
`cli`/`server` worked examples_ — every one of those examples is a scar somebody
paid for, and a generalised rule with no instance behind it is the shape this
project has watched rot twice; the names are kept as the worked case and demoted
from being the key. _Hand digestify's agent a per-spell brief that patches the
four steps_ — that is a fifth copy of the correction, and D43's whole lesson was
that the hard-coding survives in copies nobody knows about.

## D56 · An ABSENCE gets written down — in the playbook, not only in the instruments

**Decided 2026-09-09, alongside D55.**

D42 ruled it for instruments: _a subject an instrument names and does not
examine must produce a row saying "not looked at"; absence of a finding must
never be spelled the same way as absence of a subject._ **The digestify pre-work
found the same defect in the PLAYBOOK, three times in one phase**, and the
playbook is read by an agent, which is exactly the reader D42 protects.

- **B7** listed `exit-site-inventory` as an expected red "once per chapter".
  Digestify has **zero rows** there — `review.ts` has no `process.exit` at all.
  An agent handed an expected red that cannot occur either hunts for it or
  manufactures the rows.
- **B8** named eight kit modules under "all of `src/kit/wire/`". Four have **no
  subject** in a single-shot spell (`eventLog`, `sse`, `tailEvents`,
  `discovery`), and a module adopted without a subject is dead code or an
  invented feature.
- **B8's epoch ruling** offered session-scoped or singleton. Digestify has **no
  event log**, so the question does not arise — and a port that simply omits the
  epoch line is indistinguishable from one that forgot it.

**The rule, now in the phase and in its checklist: a step that cannot apply must
say so out loud, in the port's own report, in the same breath as the steps that
did.** "Digestify has zero `exit-site-inventory` rows, and that is correct" is
the shape. The cost of the discipline is three sentences; the cost of skipping
it is a reader who cannot tell a clean absence from an oversight, which is the
same cost D42 measured at three instruments.

**Not taken:** _let the port's report imply it by omission_ — that is precisely
the spelling D42 forbids. _Add a ward that checks the port's prose_ — the
subject is a human-written report and Gotcha 12 already records what happens
when a ward reads prose. _Say it once at the top of Phase B rather than at each
step_ — an agent working a step reads the step; the three instances are three
different questions and each is answered where it is asked.

## D57 · The predicted symptom was SAFER than the measured one — a diagnostic computed from a broken anchor lies confidently

**Measured 2026-09-09.** Phase B's B3 predicted, and digestify's verify report
repeated, that keeping `import.meta.main` on `review.ts` would make it
**"silently pick dev, exit 0, and read as a surface bug"**. Driven, by copying
`review.ts` to `src/digestify/backend/review.ts` and running it from two cwds,
that prediction is **false in the direction that matters**:

- from the repo root → **exit 2, loud**, naming the operator's **cwd** and
  telling them to go to `/Users/colereed/src/digestify` — a directory that does
  not exist, computed by running the broken `SKILL_ROOT` through
  `DEV_SURFACE_CWD`'s four `..`;
- from `src/digestify` (a cwd whose `bunfig.toml` DOES load the Tailwind plugin)
  → **exit 2, loud**, blaming a missing surface source that is present and
  correct.

**Both are loud. Both blame the wrong thing, consistently, in a direction that
reads like a real answer.** The generalisation, which is the part worth keeping:
**a spell that invested in good diagnostics has MORE ways to misattribute an
anchoring defect, not fewer** — every message a location-anchored entry prints
about its own environment is computed from the anchor, so a wrong anchor
produces a coherent, specific, wrong story. **Do not accept a diagnostic as
evidence about the anchor**; resolve the paths yourself, from the address the
file will actually sit at.

**Not taken:** _leave B3's "silently" in place, since the conclusion (delete the
block) is unchanged_ — the conclusion is the same and the SEARCH is not: an
agent told to look for silence, meeting a confident exit 2 about its cwd, will
conclude B3 does not apply and go fix its cwd. _Record it only in the pre-work
doc_ — the misdirection happens at the step, so the correction belongs at the
step, with the pre-work doc holding the transcript.

## D58 · digestify's failures adopt the envelope; its OUTCOMES keep their numbers — and three codes move

**Decided:** implementer, 2026-09-09, Phase 5 chapter 2, driven at all eight
sites.

digestify had **no `die` and no error class**, which is not the same as having
no error contract. It raised by `process.stderr.write("error: …"); return 2;` at
**eight** sites — counted by following the returns, because a grep for `die(`
finds nothing and reports "no error contract to change" for a spell whose exit
codes SKILL.md publishes in a table with a per-code sentence for the agent.

**The two populations, ruled separately, which is D52 arriving at the spell it
was written for.**

| population           | codes         | channel                                        | ruling                                       |
| -------------------- | ------------- | ---------------------------------------------- | -------------------------------------------- |
| **failures**         | 1 · 2 · 5 · 6 | ONE JSON envelope on **stderr**, stdout empty  | **adopt `errors.ts`** — kind, envelope, code |
| **session outcomes** | 0 · 124 · 130 | an observation line on **stdout**, no envelope | **outside the taxonomy, numbers unchanged**  |

A timeout and a closed tab are not refusals of a caller's command: they are what
happened to the review, they are RETURNED from `main` and never raised, and
SKILL.md gives the agent a different sentence to say to the human for each.
Adopting the taxonomy over them would re-spell the two states this spell exists
to distinguish. ⚠ **The channel is the discriminator, not the number** — the
same named residue `join.ts` carries.

**What moved, driven through the real launcher:**

| invocation                       | before          | after                                   |
| -------------------------------- | --------------- | --------------------------------------- |
| a bad flag                       | 2 · prose       | **2** `usage`, enveloped                |
| a bad `--theme`                  | 2 · prose       | **2** `usage` + `choices` as DATA       |
| a malformed `::: question` fence | 2 · prose       | **2** `usage`                           |
| nothing to review                | 2 · prose       | **2** `usage` + `hint`                  |
| `--reference` at a missing path  | 2 · prose       | **5** `not_found`                       |
| dev boot from the wrong cwd      | 2 · 10 lines    | **2** `usage`, all ten lines in `hint`  |
| dev boot with no surface source  | 2 · prose       | **5** `not_found`                       |
| the server could not bind        | 2 · a JSON line | **6** `conflict`, and that line is GONE |

The `{"event":"bind_error"}` line is deleted rather than kept beside the
envelope: "ONE JSON document on stderr" is the contract and a second JSON line
above it is a second document — `join.ts`'s repair, for the same reason.

**And the ruling has a destination outside the code, which Phase B does not
say.** `5` and `6` are new caller-visible numbers, so **SKILL.md's exit table
carries them**, with the two populations named and the envelope shown. Nothing
in the gate would have reported it (digestify has no acc grade, D37), and
nothing in Phase B names SKILL.md as the place a code change lands.

**Not taken:** _force every kind to `usage` so all failures stay at 2_ — that
adopts the envelope's shape and discards its content; `kind` is the contract,
and calling a missing file a usage error is a lie an agent routes on. _Convert
124/130 as well, for uniformity_ — refused for D52's reason and one more: they
are the spell's whole product. _Leave the two dev refusals as prose because
their diagnostics are multi-line_ — `hint` exists for exactly that, and a spell
that keeps one prose path keeps the two-formats problem for its caller.

## D59 · `--timeout 0` used to mean "immediately" and now means "never" — the kit gave something back

**Decided:** implementer, 2026-09-09, Phase 5 chapter 2, driven both sides.

`shouldIdleClose` carries astrolabe's `timeoutMs <= 0` guard — the
standing-observatory default, where a `>= 0` comparison would close the daemon
on its first tick. digestify's own watcher was
`(now - heartbeatAt)/1000 >= timeout`, so **`--timeout 0` ended the review 124
on the first 50 ms tick**: a review nobody could ever read. Adopting the module
changes that one input to mean **never time out**; `/submit` and `/cancel` still
end the session, and the cell that pins it ends the session through `/cancel`
rather than waiting for a timeout that will never come.

**This is bounty's third category — RECEIVED, not GAINED or DE-DUPLICATED — and
it is the one nobody looks for**, because the whole phase is written as though
the kit is the destination. Framed as "adopt and gain", a behaviour change lands
unnamed.

**Not taken:** _preserve the old meaning by passing `timeout * 1000 || -1`_ — it
keeps a value nobody wants (a review that dies before it renders) and puts a
second idle policy back into a spell that just adopted the house's. _Reject
`--timeout 0` as a usage error_ — a new refusal is a bigger caller-visible
change than a new meaning, and "never" is the useful reading of zero.

## D60 · Phase B's first single-entry consumer — six places it was still not enough

**Recorded:** implementer, 2026-09-09, at the end of Phase 5.

Phase B was rewritten the day before this port to dispatch on four properties
instead of on the names `cli`/`server` (D55), and digestify is its first
consumer. **The rewrite held**: B3's arithmetic ruling, B5's derived pin
destination, B7's zero-row discipline and B8's no-subject table each produced
the right answer, and D57's warning stopped the anchor being diagnosed from its
own error message. Six gaps remain, each hit before it was solved, and all six
are amended in ONE pass:

1. **B6 tells a moved test to re-derive from an explicit `SKILL_ROOT` and never
   says the skill root is now in ANOTHER TREE.** No count of `..` reaches it.
   The house form already existed in this spell's own `dev-styled.test.ts` — a
   `.anthill/config.json` marker walk, under a comment recording that a
   hand-counted climb died at spawn when a non-author placed the file.
2. **B4's "do not stage artifacts as a ward workaround" and B10's "`dist-check`
   exit 0" read as a contradiction**, and the reconciliation lives only in D42's
   prose. `dist-check` ARM 1b FAILS on a first-emit artifact until it is staged,
   because ARM 1b's question IS shipping. Stage it for the COMMIT; never to make
   a ward green.
3. **B10's checklist says "driven on a booted daemon", and for a single-shot
   spell a boot proves nothing.** Digestify exists for a human to read a page
   and submit once; a daemon nobody submits to exercises neither the
   substitution nor the exit.
4. **B8's `housekeeping` row rules on `shouldIdleClose` and `drainAndStop` and
   never mentions `startHousekeeping`**, which is what an "adopt the module"
   reading takes. It owns the PAIR of standing timers; a one-timer spell needs a
   ruling, not a silence.
5. **B8 never names SKILL.md as the destination of an error-contract ruling.**
   It says correctly that nothing in the gate will tell you; the thing that
   tells the CALLER is the spell's published exit table, and three spells have
   now changed codes without a step naming it.
6. **B8 tells the port to DRIVE the defence the kit does not carry, and stops
   there.** A drive does not survive the session. Where the kit deletes a
   defence the spell keeps, the kept defence needs a CELL — digestify's is
   `GET /index.html` must not answer the unsubstituted document.

**Not taken:** _file the six as backlog items_ — the reader who needs them is
the next porting agent inside the step, which is where imago's and bounty's
went. _Amend as each was hit_ — six commits into a document two other ports are
reading; one pass, at the end, with the port's evidence behind it.

## D61 · The refusal was a blacklist that knew ONE name, and the port put a second file in the directory it guards

**Decided:** implementer, 2026-09-09, Phase 5 repair chapter, driven before and
after. **Found by an independent verify pass, not by the author.**

D60's sixth gap ends "the kept defence needs a CELL — digestify's is
`GET /index.html` must not answer the unsubstituted document", and that cell was
written, driven and shipped. It was still not enough, and the reason is a
property of the SHAPE of the defence rather than of its coverage: **the refusal
was `rel === "index.html"` — a blacklist — and a blacklist refuses the file it
was told about and serves every neighbour.**

Two neighbours were reachable, and **the first one this port created itself, in
the exact defence class it made its headline**:

| drive                                                        | before (`20e3135`)                                                                                                             | after                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| `GET /review.js`                                             | **200**, **122,389 bytes**, `text/javascript`, sha256 `6ed9d235…` — **byte-identical to `dist/review.js`**, the backend bundle | **404**, 21-byte JSON |
| `GET /INDEX.HTML`                                            | **200**, 1,180 bytes, `application/octet-stream`, `__TITLE__` and `__PAYLOAD__` still in it                                    | **404**               |
| `GET /Index.html`                                            | **200**, `text/html; charset=utf-8`, unsubstituted                                                                             | **404**               |
| `GET /index.HTML`, `GET /iNdEx.HtMl`                         | **200**, unsubstituted                                                                                                         | **404**               |
| `GET /REVIEW.JS`                                             | **200**, the bundle again                                                                                                      | **404**               |
| `GET /index-dfcfc4w0.js`, `GET /index-ty4gdnpw.css`, `GET /` | 200                                                                                                                            | **200, unchanged**    |

`GET /review.js` **does not exist on `develop`** — Phase 5 is what put an
implementation inside the directory the daemon serves. The case variants are
**pre-existing on `develop`**, and they are a second lesson: the refusal was
case-SENSITIVE and APFS is case-INSENSITIVE, so four spellings missed one `===`
and reached the same inode. Three of the four also came back as
`application/octet-stream`, because the content-type map's extension lookup is
case-sensitive too — a leak whose own header says something is wrong, to nobody.

**Ruled: ONE change, a WHITELIST, derived from what the built `index.html`
LINKS.** Not a second blacklist entry, because a second blacklist entry is the
same instrument that just failed twice. Membership is an exact match against the
emitted name, which is what makes the refusal **case-insensitive by
construction**: every case variant of every name — servable or not — misses the
set. Four cells hold it, each calibrated by mutation (the two new refusal cells
were red against the pre-fix artifact; the inventory cell was calibrated by
dropping `review.js` from its refused list).

⚠ **The shipped architecture document asserted the false half.** It said the
by-name refusal is what keeps the unsubstituted document from escaping; that
sentence was true of `/index.html` and false of four spellings of it. Corrected
in the same chapter.

**Not taken:** _add `review.js` to the refusal_ — the smallest change, and it
leaves the next file added to `dist/` served by default; the blacklist is the
defect, not its contents. _Lowercase the comparison_ — closes the case leak and
not the bundle leak, and a `toLowerCase()` refusal still says "everything is
served unless I remembered it". _Move the whitelist into
`src/kit/wire/serveDist.ts`_ — tempting, because **the same exposure exists at
bounty today** (its `dist/` holds `cli.js`, `server.js` and `join.js` beside the
surface, all served by the house caller), but the kit's stated boundary is "the
caller decides WHICH file", the repair chapter's subject is digestify, and a
roster-wide serve change with no cells at the other seven spells is a bigger
blast radius than the defect. Filed as C5 instead. _Whitelist by SHAPE
(`index-<hash>.js`)_ — wrong the first time the bundler emits a split chunk or a
font. _Enumerate the names by hand_ — wrong at the next build, since the names
carry content hashes.

## D62 · The exit table NARROWS; the numeric-flag conversion is filed, not made

**Decided:** implementer, 2026-09-09, Phase 5 repair chapter, all four sites
driven.

SKILL.md's new exit-code section claimed `1`, `2`, `5` and `6` "each write
exactly one JSON envelope to stderr", and its own row for `1` contradicted the
paragraph directly above it. `review.ts`'s header had it right. Driven:
`--file <a directory>` → **exit 1, raw Bun stack, `EISDIR`, no envelope**;
`--file` on a `chmod 000` file → **exit 1, `EACCES`, no envelope**. Corrected: 1
is the one failure code with no envelope, and that is deliberate — the stack is
the thing worth having when the throw was not anticipated.

Two more table defects, both driven:

- **Row 5 named only `--file`/`--reference`** and omitted the second `not_found`
  site, a forced dev boot that cannot find the surface source. Added.
- **Row 6 says "could not bind", and `conflict` also catches flags a caller
  repairs by RETYPING**: `--port notanumber` → `port=NaN` → exit 6, and a
  nonsense `--host` → exit 6. Both come back through the same bind refusal, with
  the reason in the envelope's `hint`.

**Ruled: the TABLE narrows.** Row 6 stops claiming to be only about a busy port
and says what it is, and points the caller at `hint`, which is the field that
separates a mistyped flag from a port someone else holds. **The conversion to
`usage` (2) is FILED, not made** — as C6, and deliberately as ONE item covering
both numeric flags, because `--timeout abc` is the identical defect at the
identical distance from the parse (D63) and half a conversion is worse than
none: it would ship a spell where one mistyped number is a usage error and the
other is silence.

**Not taken:** _convert `--port` here and leave `--host` at conflict_ — the
ruling is right (a non-integer port is decidable without touching the network; a
hostname that does not resolve is indistinguishable at the bind from a port in
use, and the daemon must not claim to know which) but it is an exit-code change
to a shipped contract, landing in the same chapter that repairs a security
defect, in a document the same chapter is already rewriting. _Convert all three
numeric flags now_ — same reason, plus it wants its own cells and its own
SKILL.md revision. _Leave the table as it was and call the paragraph a typo_ —
the paragraph is what an agent reads to decide whether to `JSON.parse` stderr.

## D63 · `--timeout 0` was never the received change — ANY non-positive value was, and `NaN` is a third case nobody ruled

**Recorded:** implementer, 2026-09-09, Phase 5 repair chapter, driven.

D59, the journal and SKILL.md all name `0`. Driven: **`--timeout=-1` behaves
identically** — `shouldIdleClose`'s guard is `timeoutMs <= 0`, so the received
change is "any non-positive value means NEVER", and `0` is one member of it.
SKILL.md's flag line said only "failsafe timeout (default 1800)" and did not
mention the new meaning at all. Both corrected.

⚠ **One nuance the record must not smooth over:** `--timeout -1` with a SPACE
never reaches the guard — `parseArgs` calls it ambiguous and dies `usage` at 2.
Only `--timeout=-1` gets there. The behaviour is the guard's; the reachability
is the parser's, and a reader who tries the obvious spelling sees the wrong
answer.

**And a third case, which is not a decision anyone made:** `--timeout abc` →
`parseFloat` → `NaN`. `NaN <= 0` is **false**, so the guard does not catch it,
and `idleMs >= NaN` is false forever — **a review that never times out, with no
diagnostic on either side of the port.** Ruled: **that is a usage error** — the
caller repairs it by retyping, which is the taxonomy's own discriminator — and
**filed rather than fixed**, as C6, with `--port notanumber` (D62). Documented
in SKILL.md as current behaviour in the meantime, because a caller who is told
`1800` is the default and is not told `abc` means never will find out by
waiting.

**Not taken:** _fix the NaN here as a one-line `Number.isNaN` guard_ — it is one
line, and it is also a new refusal of an input the spell accepts today, which is
the caller-visible change D59 explicitly weighed against a new meaning; it goes
with `--port`'s, ruled together, celled together. _Say "0 or negative" in
SKILL.md and stop_ — leaves `abc` silent, which is the member of the set a
caller actually types by accident.

## D64 · `pins=6` was true when it was written and false when it shipped — a de-duplication moved a pin into the ward's blind spot

**Recorded:** implementer, 2026-09-09, Phase 5 repair chapter, driven at three
commits.

Three shipped documents say the spawn-path ward reports
`digestify/dist/review.js … anchor-read=yes pins=6`. At `20e3135` — the commit
they shipped in — **the ward reports `pins=5`.**

Driven, by putting each commit's artifact under the live ward:

| commit                                        | literal `join(DIST_DIR, "index.html")` in the artifact | ward   |
| --------------------------------------------- | ------------------------------------------------------ | ------ |
| `110a3611` (the relocation)                   | 2                                                      | pins=6 |
| `67f74097` (the kit adoption)                 | 1                                                      | pins=5 |
| `20e3135` (the records — where the 6 shipped) | 1                                                      | pins=5 |
| this chapter                                  | 2                                                      | pins=6 |

**WHY it moved, which is the transferable part: a DE-DUPLICATION reduced ward
coverage.** `resolveMode` was inlined in `review.ts` and its body spelled
`join(DIST_DIR, "index.html")` literally. Adopting `src/kit/wire/serveDist.ts`
replaced that body with `resolveModeIn(DIST_DIR)` — the same read, at the same
path, through a function PARAMETER. The ward counts pins it can read as literals
in the emitted text; a path assembled inside a callee from an argument is
**inside its declared blind spot**. So the number fell by one while nothing
about the spell's path behaviour changed, and no instrument reddened, because a
coverage COUNT going down is not a failure.

⚠ **And the count came back to 6 in this chapter, for a different reason** — the
whitelist reads the entry document and spells `join(DIST_DIR, "index.html")`
literally again. The same number, from a new site. **That is the finding, not a
coincidence:** `pins=N` measures literal spellings the ward can resolve, not
pins the spell has, and it moves when code is TIDIED as readily as when paths
change. Registered as C4's second half.

**Not taken:** _edit the three documents to say `pins=6` and move on_ — the
number is right again today and the sentence would still be wrong about what was
measured. _Widen the ward to follow arguments into callees_ — that is
interprocedural analysis of an emitted bundle, and D42 already ruled the ward's
blind spot declared rather than closed; what was missing is that a
DE-DUPLICATION can push a pin into it silently, which is now C4's text.
