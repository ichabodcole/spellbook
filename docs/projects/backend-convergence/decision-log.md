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
