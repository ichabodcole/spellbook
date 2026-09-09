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
