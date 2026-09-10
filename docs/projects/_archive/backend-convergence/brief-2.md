# Phase 2 — the migration pathfinder: glamour's whole backend

**Created:** 2026-09-08 · **Author:** Claude Code (orchestrator) · **Mode:**
brief, not a plan. **Predecessor:** Phase 1b, landed `6af53f2`.

Read [the proposal](./proposal.md), [the decision log](./decision-log.md)
(**D1–D25** — D2, D7, D8, D12, D15, D23 all bind you),
[brief-1b](./brief-1b.md), and both Phase 1 journals. Then read
[the porting playbook](../../playbooks/porting-a-spell-playbook.md), because
**this phase adds a chapter to it.**

---

## The mission

Phase 1 proved the shared spine on two spells that **already built**. Glamour
does not. It is the first spell to take its **whole backend** — CLI and daemon —
from source-shipped into `src/glamour/backend/`, emit both artifacts, keep
launchers, and adopt the kit. **Everything after this phase is this phase
repeated**, which is why the journal matters more than the diff: imago, bounty,
digestify, grapevine and mind-mapper all follow this path, and they follow it
from what you write down.

Glamour is the subject on Cole's standing reasoning: it has an
`acc.config.json`, it is mid-sized, it is a fork of the imago line so the
pattern transfers, and he is not currently using it — the blast radius of
getting it wrong is small.

## What I measured — do not re-derive it

- **The backend is 2,436 lines across six files:** `cli.ts` (1,221), `server.ts`
  (724), `reduce.ts` (268), `styles.server.ts` (121), `persist.server.ts` (73),
  `imageOptimize.server.ts` (29). Plus `shared/` (`types.ts`,
  `imageOptimize.ts`) and **ten** test files under `tests/`.
- **The surface is already ported** (`src/glamour/surface/`) and **imports the
  skill folder 17 times.** Relocating a module re-points every one.
- **BOTH entries use `if (import.meta.main)`** — `cli.ts:1210` and
  `server.ts:692`. That is D12's defect exactly: false in a bundle the launcher
  imports, so the block never runs and the process exits 0 having done nothing.
  It cost chapter 1 real time; you get it for free.
- **The 250 ms reconnect storm is right there.** `cli.ts:623` sets `delay = 250`
  and `:667` resets it — the census's B5, in the open. `tailEvents` retires it
  on adoption, and Phase 1a found a second door into the same failure (the reset
  belongs at the first byte, not at a successful open).
- **`acc.config.json` is `{"defaultOutput":"json"}`** and glamour is
  **CONFORMANT L0** as of 2026-09-03. **That is an acceptance criterion**: the
  port must not regrade it. Re-run acc from the skill directory and say so.

## Scope

**One spell, whole backend, both artifacts.** Chapter it the way 1b did and let
the gate pass between chapters:

1. **Relocate and build.** `src/glamour/backend/{cli,server,…}.ts`, launchers at
   `scripts/cli.ts` and `scripts/server.ts` (copy astrolabe's launcher
   reasoning, not its prose), `dist/cli.js` + `dist/server.js` committed, tests
   follow their subjects, dist roster and `dist-check` grow the entries. **What
   moves and what stays is yours to decide from the imports** — 1b's D10 ruled
   "a module moves iff no surface file imports it", and glamour's `shared/` is
   imported by its surface, so expect the same answer and record it either way.
2. **Adopt the kit.** All of `src/kit/wire/`: `tailEvents` + the error contract
   (Phase 1a) and `serveDist`, `eventLog`, `sse`, `housekeeping`, `discovery`,
   `heartbeat` (Phase 1b). Glamour is the **first consumer that is not one of
   the two the modules were designed against** — where a boundary is wrong, that
   is a finding about the module, not about glamour. Say so rather than bending
   the spell.

**Out of scope:** every other spell; the surface; the epoch query parameter (D23
— it is designed against all seven tails in a later phase, not retrofitted
here); choosing one discovery convention (D3).

## The three inherited hazards, named so they cost nothing twice

1. **`import.meta.main` in both entries** — export `run()`, launcher calls it.
2. **Path-pinned siblings.** `grimoire/spawn-path-ward.test.ts` now exists and
   **will fail you** if a pin does not resolve from the emitted location. It is
   the ward Cole ruled in after `magpie extract` shipped dead for eight days.
   **This phase is the first real test of it against a spell it has never seen**
   — if it stays silent through a port that introduces a bad pin, that is a
   finding about the ward.
3. **The dev-mode surface import** is a relative specifier the external flag
   leaves in the artifact verbatim; the relocation moves its anchor. **Prove dev
   AND release on a booted daemon**, per 1b.

## D8's audit is not optional, and glamour is the biggest subject yet

`die` throws rather than exits (D8). A `die` **reachable** from inside a `try`
whose `catch` swallows becomes a silent continue. ⛔ **REACHABILITY, NOT CALL
SITES** — a helper that dies, invoked from inside a swallowing `catch`, has its
`die` at a site that looks perfectly safe. Astrolabe was 15 sites, magpie 29.
**Glamour's CLI is 1,221 lines; audit the call graph and report the count.**

## What proves this phase worked

- Both artifacts build and are committed; `dist-check` exit 0; roster green.
- **Dev and release both driven on a booted daemon**, both halves.
- **acc re-run from the skill directory, still CONFORMANT L0.**
- **B5 dead by construction** — the 250 ms storm cannot be re-expressed, because
  the loop is gone. Drive a reconnect and show the backoff growing.
- Glamour's own live defects from the censuses are closed by adoption, not by
  hand. Name each one and say which module closed it.
- Gate green **unpiped**, exit read from a file.

## ⛔ The deliverable that is not code

**A new phase in `docs/playbooks/porting-a-spell-playbook.md`**, written from
your journal, in the voice of the existing Phases R and S. Five spells port
after this one. The playbook must carry, at minimum: the launcher pattern and
why the path is load-bearing; `import.meta.main`; the path-pinned-sibling class
and the ward that catches it; the reverse surface-import re-point; D8's
reachability audit; and the `idleMs`-derived-from-your-own-heartbeat rule from
Phase 1a. **Failures are worth more than successes here** — a playbook written
only from what worked teaches nobody the shape of the trap.

## Conventions that bite

`bunx biome check --write` on changed `.ts/.tsx` before every commit · gate
UNPIPED (`bun run gate > /tmp/g.log 2>&1; echo $?`) · rebuild and commit `dist/`
in the same chapter as its source (Contract 18) · story chapters · every daemon
gets its own home under the session scratchpad and is torn down · **never kill
pids 23127 or 66902** · **never stage, stash, commit or edit `skills-lock.json`
or `.claude/skills/shadcn/`** · **do not push, do not merge** · trailers
`Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` and
`Claude-Session: https://claude.ai/code/session_01BiZGj5ZTDSZi1mB8YtuRcx`.

## Records

`decision-log.md` (D26+, with options not taken) · `phase-2-journal.md` ·
`sessions/2026-09-08-glamour-takes-the-path.md` · **and the playbook phase.**
