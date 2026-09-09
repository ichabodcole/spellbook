# Phase 1b — the two daemons come into the build, then adopt the spine

**Created:** 2026-09-08 · **Author:** Claude Code (orchestrator) · **Mode:**
brief, not a plan. **Predecessor:** [Phase 1a](./brief.md), landed `894e249`.

Read [the proposal](./proposal.md), [the decision log](./decision-log.md) (D1–D8
— **D6 defines this phase** and **D8 is a contract you inherit**), and
[the Phase 1a journal](./phase-1-journal.md) in full. The two censuses
([spine](../../investigations/2026-09-08-daemon-spine-census.md),
[tail](../../investigations/2026-09-08-tail-reader-convergence.md)) carry the
drafted signatures and the defect tables L1–L7 / B1–B8.

---

## The mission

D2 ruled that **the whole backend builds**, not the CLI entry. Astrolabe and
magpie today build `cli.ts` and ship `server.ts` as unbuilt source beside it, so
their daemons cannot import `src/kit/` and five of the eight spine concerns are
unreachable. This phase makes them reachable and then uses them.

**Two chapters, in this order, on one branch — and the order is a gate, not a
preference:**

- **Chapter 1 — relocate and build.** Both servers move to
  `src/<spell>/backend/`, emit `dist/server.js`, and keep a launcher at
  `scripts/server.ts`. **Behaviour must be unchanged and demonstrated so**, on a
  booted daemon, in both dev and release mode, before chapter 2 begins.
- **Chapter 2 — adopt the daemon-side spine.** The shared modules, extracted
  from the best sibling and adopted by both servers.

⛔ **Do not interleave them.** A relocation and a rewrite landing together is a
diff where nothing can be attributed, and chapter 1 is exactly the chapter whose
journal Phase 2's playbook inherits.

---

## What I measured before writing this — do not re-derive it

**1 · The launcher pattern transfers verbatim, and that is what makes the move
cheap.** Both CLIs spawn `join(SCRIPT_DIR, "..", "scripts", "server.ts")`
(`src/astrolabe/backend/cli.ts:53`, `src/magpie/backend/cli.ts:63`), and
`grimoire/lib/entry-points.ts:188` and
`grimoire/exit-site-inventory.test.ts:153` name that path too. Keep a real
`scripts/server.ts` there — a launcher importing `../dist/server.js` — and the
spawn line, the roster and the wards need no change.
`plugins/spellbook/skills/astrolabe/scripts/cli.ts` is the exemplar and its
comment block explains every constraint; copy its reasoning, not its prose.

**2 · `SKILL_ROOT`/`DIST_DIR` survive the move by accident, and you must confirm
it rather than trust this line.** Both servers compute
`SKILL_ROOT = join(SCRIPT_DIR, "..")` and `DIST_DIR = join(SKILL_ROOT, "dist")`.
From `dist/server.js` those still resolve to the skill root and to `dist/` — the
CLI's own "up and back down is correct from BOTH locations" trick, arrived at
here for free. **Assert it in a test; do not reason about it.**

**3 · The dev import is the real trap.** Both servers do
`await import("../../../../../src/<spell>/surface/index.html")` behind
`mode === "dev" ? … : undefined` (astrolabe `server.ts:525`, magpie `:721`).
D6's measured flag `--external '*/surface/index.html'` leaves that specifier in
the emitted bundle **verbatim**, and it will then resolve relative to
`plugins/<…>/dist/`, not relative to the source. The relocation moves the anchor
a second time. **This must be proven by booting a dev daemon and seeing the
surface served with HMR — not by a type-check, and not by release mode, which
never executes the line.**

**4 · `import.meta.dir` is load-bearing in magpie and WILL break.**
`plugins/spellbook/skills/magpie/scripts/backend.ts:63` resolves
`REMOVE_PY = join(import.meta.dir, "remove.py")`. Bundled into `dist/server.js`,
`import.meta.dir` becomes the dist directory and `remove.py` — a Python file
that is not bundled and must not be — stays in `scripts/`. Rembg extraction dies
at runtime, in a path no type-check and no unit test reaches. **Find every
`import.meta.dir` and every path-pinned sibling in both backends before you move
anything, and say in the journal what you found.** This is the measurement that
resized the phase; assume it is not the only one of its kind.

**5 · The surfaces import types out of the shipped skill folder — backwards.**
Three astrolabe surface files import from
`plugins/…/astrolabe/scripts/state.ts`; roughly a dozen magpie surface files
import from `plugins/…/magpie/shared/`. Relocating a module re-points every one
of them, and `grimoire/import-boundary-wards.test.ts` has explicit rulings on
this direction (`:292`, `:731`, `:1130`, prose at `:121`, `:268`, `:1009`).

**6 · Magpie is the larger subject by a wide margin.** `server.ts` (40 KB) plus
`backend.ts`, `discover.ts`, `persist.server.ts`, `reduce.ts`,
`source.server.ts`, plus `shared/{alpha,types,versions}.ts`, plus six test files
under `tests/` including a daemon integration test. Astrolabe is `server.ts` (30
KB) plus `state.ts`. **Do astrolabe first**; it is the smaller, and its journal
tells you what magpie will cost.

**7 · Both servers end with `process.exit(exitCode)`** (astrolabe `:714`, magpie
`:993`), and astrolabe's is a pinned row in `exit-site-inventory`. D8 made `die`
throw for the CLI; a daemon's terminal exit is a **different** case and is not
in scope to change. If you touch it, say why.

---

## Scope

### Chapter 1 — relocate and build

- `src/build.ts` learns the server entry. Its `buildBackend` docstring says
  _"CLIs ONLY … Do not add server.ts."_ **That sentence is now false and must be
  rewritten, not deleted** — it records a measurement (a server drags the
  surface graph) that is still true without the external flag. Amend it to say
  what changed and cite D6.
- Both servers move to `src/<spell>/backend/`, with their non-shipped siblings.
  **What counts as a sibling is yours to decide from the imports**, and the
  decision goes in the log: magpie's `shared/` is imported by its surface too,
  so it may not want to move at all.
- Launchers at `scripts/server.ts`. Emitted `dist/server.js` committed.
- Tests follow their subjects. `dist-check` and the dist roster grow the new
  entries; `dist-roster-ward` stays green.
- **Dev mode and release mode both demonstrated on a booted daemon**, per
  measurement 3.

### Chapter 2 — adopt the daemon-side spine

From the spine census, **only the modules both servers actually use** — check,
do not assume the census's counts apply to these two:

`resolveMode(distDir)` · `contentTypeFor(ext)` · `serveFromDist(distDir, rel)`
(the file half only; URL→filename mapping stays in each router) ·
`createEventLog<T>()` · `sseResponse()` · `startHousekeeping()` — with
`subscriberCount` **required**, which is what closes L1 · `drainAndStop()` ·
`writeFileAtomic` / `unlinkIfMatches`.

**Convergence is toward the best sibling, not a merge of equals** (mind-mapper's
`sseResponse` and event bus; bounty's idle logic and shutdown watchdog). Read
those two even though they are not adopting here.

Plus the two deliverables Phase 1a handed forward by name:

- **The heartbeat constant.** `idleMs` is currently DERIVED in each CLI by
  hand-mirroring its own daemon's heartbeat expression, and both files say so.
  One exported daemon-side constant, imported by both halves, is exactly what
  the shared spine is for. **This is the phase's cleanest proof that the seam is
  real** — it is a value that could not previously cross.
- **Astrolabe's event log stamps an epoch.** Phase 1a made the epoch gap
  observable for the first time (B1's repair is what made it reachable): after a
  restart the tail resumes at `since=<last seen>` against a daemon whose ids
  restart at 1, so the new daemon's `ready` is never delivered. The client
  already carries `epochOf`/`onEpochChange`. **Give the daemon an epoch and the
  gap closes with no client change** — and drive the restart to prove it.

### Out of scope

The other six spells. Every surface. The micro-utilities. Choosing one discovery
convention (D3). Epoch for the other daemons. Re-pointing
`mind-mapper/scripts/tail.test.ts` — still read-only, still the acceptance
criteria for a later phase.

---

## Layout

D7 put the observable-contract modules at `src/kit/wire/`. The daemon-side
modules are the **other** side of the same wire — `sseResponse` decides what a
tail client receives — so `src/kit/wire/` is the presumptive home and the burden
is on you to argue otherwise. **`printJson` still owes a move into `wire/`** (D7
named it as debt); if this phase can carry its eight prose references, pay it
and say so. If not, leave it and do not mention it again.

**The kit is a leaf.** Nothing under `src/kit/` may import out of `src/kit/` —
grimoire's ward 2, and what makes the kit safe to inline into any bundle.

---

## Done means

- Both servers build; `dist/server.js` committed for each; `dist-check` exit 0
  and the roster ward green.
- **A dev daemon and a release daemon booted and driven for each spell**, with
  what you drove written down. Measurement 3 and measurement 4 are the two that
  will not fail in CI.
- The daemon-side modules exist, both servers use them, kit-is-a-leaf green.
- **The heartbeat constant crosses the seam**, and the hand-mirroring comments
  in both CLIs are deleted, not left lying.
- **Astrolabe's epoch closes the restart gap, driven** — restart the daemon
  under a live tail and see the new daemon's `ready`.
- L1 is closed by construction (`subscriberCount` required).
- Gate green **unpiped**, exit read from a file.
- Records: `decision-log.md` appended (D9+), `phase-1b-journal.md`,
  `sessions/2026-09-08-the-daemons-build.md`.

## Conventions that bite

`bunx biome check --write` on changed `.ts/.tsx` before every commit · gate
UNPIPED (`bun run gate > /tmp/g.log 2>&1; echo $?`) · story chapters · every
daemon you start gets its own home under the session scratchpad and is torn down
· **never kill pids 23127 or 66902** · **never stage, stash, commit or edit
`skills-lock.json` or `.claude/skills/shadcn/`** · **do not push, do not merge**
· trailers `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
and `Claude-Session: https://claude.ai/code/session_01BiZGj5ZTDSZi1mB8YtuRcx`.

## ⛔ The scars must be re-homed, not deleted

Same rule as 1a, and it now applies to daemon-side prose: bounty's
`shouldIdleClose` rationale, mind-mapper's measured Bun 1.3.14 finding, the
`resolveMode` comment about a hashed `index.html` making release mode invisible,
and magpie's note that `dist/` existing is not the discriminator. **A
convergence that loses the scars re-earns them.**
