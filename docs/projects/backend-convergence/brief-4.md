# Phase 4 — bounty: three entries, and the spell the spine was copied FROM

**Created:** 2026-09-09 · **Author:** Claude Code (orchestrator) · **Mode:**
thin — [Phase B](../../playbooks/porting-a-spell-playbook.md) is your path.
**Predecessor:** Phase 3 (imago), landed `8576590`; pre-work landed `753c655`.

---

## Read first

`docs/playbooks/porting-a-spell-playbook.md` **Phase B** — amended twice since
it was written: once by imago's port (seven gaps), once by the pre-work (the
entry set is derived; "two entries" is gone). `decision-log.md` **D1–D44**;
**D42/D43/D44 are new and they change how you write any instrument.**
`phase-3-journal.md` for how the last port actually went.
`.anthill/dev/seams.md` Contracts 3, 4, 5, 18.

## Why bounty is different from the three ports before it

**1 · It is the first spell with THREE entries** — `cli.ts` (1,506), `server.ts`
(1,713), **`join.ts`** (331). The pre-work made the build derive its entry set
from launchers precisely so this port is possible; you are its first real
consumer. `join.ts` is a caller-facing entry an agent spawns directly
(`SKILL.md` names it twice) — a WebSocket participant bridging stdin/stdout, not
a helper.

**2 · `grimoire/launcher-pairing-ward.test.ts` exists now and its cell C is
about YOU.** `backend/X.ts` plus any `scripts/X.ts` makes X an entry — and
bounty ships a real `scripts/cli.ts` that is a CLI, not a launcher. **A
half-relocated backend emits a `dist/cli.js` nothing imports**, and a
three-entry port passes through that state twice. Expect the ward to red
mid-port; that is it working.

**3 · Bounty is where half the spine came FROM.** The censuses converged
`startHousekeeping` toward bounty's idle logic and named bounty's shutdown
watchdog as the best sibling. So adoption here is partly bounty meeting its own
code — **and the one thing deliberately NOT shared is bounty's watchdog**: it is
a named absence in `drainAndStop`'s header because importing it would put the
house's only unconditional `process.exit` inside a module every spell inlines.
**What happens to that watchdog when bounty adopts `drainAndStop` is this port's
central design question.** Decide it, drive it, and record it — the answer
belongs in the kit's header either way.

## What I measured — confirm, do not re-derive

- **The predicted defect is real and live.** `scripts/cli.ts:60` is
  `const SERVER_SCRIPT = join(SCRIPT_DIR, "server.ts")` — glamour's exact bug,
  which from `dist/` resolves to a file that does not exist. **Phase B's B4
  predicted this before bounty was touched.** Fix it as part of the port and say
  what the spawn-path ward does about it, before and after.
- **`scripts/cli.ts:72`** pins `SURFACE_CWD` five levels up to `src/bounty`
  (Contract 5's cwd pin). `dist/` and `scripts/` sit at the same depth, so it
  should survive — **assert it rather than reasoning about it**, and check every
  other `import.meta`-anchored pin the same way (B4).
- **`shared/{predicates,types}.ts` is imported by the surface** (4 sites), so
  D10 says it stays. `predicates.ts` is the R7 seam — each predicate defined
  once, imported by both sides. Do not disturb that seam.
- **`scripts/server.test.ts` is 4,847 lines** — the largest test file in the
  repo — and must follow its subject.
- **`assets/`** holds a favicon, a wordmark and two mascot images. Non-TS
  runtime siblings are the `remove.py` class; establish who resolves them and
  from where.
- **The `bun` exemption:** `import-boundary-wards.test.ts` recorded bounty as
  the last hand-authored holder of a runtime `bun` import. Its population now
  looks synthetic — **verify what actually happens when bounty's source leaves
  `plugins/`, and if the exemption's population empties, it must be RE-ARGUED,
  not re-declared.**

## Scope

Bounty's whole backend into `src/bounty/backend/`, three launchers, three
committed artifacts, all eight `src/kit/wire/` modules adopted. Bounty is the
**fifth** consumer — a boundary that is wrong for it is a finding about the
module (Phase 2 widened two; imago needed none).

**Out of scope:** every other spell; the surface; the epoch query parameter
(D23); an acc config (D37); choosing one discovery convention (D3).

## Done means

- Three artifacts built and committed; `dist-check` exit 0 (all arms, including
  the new ARM 1b); **`launcher-pairing-ward` green with a row for bounty**.
- **Dev and release both driven on a booted daemon, and `join.ts` driven for
  real** — a host and a joining participant, connected, exchanging at least one
  task mutation each way. `join.ts` is the entry no previous port had; it is not
  proven by the gate.
- The `SERVER_SCRIPT` defect closed, with the ward's verdict shown both ways.
- Bounty's census defects closed **by adoption**, each named with its module.
- The watchdog question decided, driven and recorded.
- Gate green **unpiped**; records (`decision-log.md` D45+, `phase-4-journal.md`,
  a session doc) **and a Phase B amendment pass** for whatever it still lacks.

## Conventions that bite

`bunx biome check --write` on changed `.ts/.tsx` before every commit · gate
UNPIPED (`bun run gate > /tmp/g.log 2>&1; echo $?`) · **build ONLY through
`bun run build`** · rebuild and commit `dist/` in the same chapter as its source
(Contract 18) · story chapters · every daemon gets its own home under the
session scratchpad and is torn down · **never kill pids 23127 or 66902** · ⛔
**never stage, stash, commit, edit, or `git checkout --` `skills-lock.json` or
`.claude/skills/shadcn/` — an earlier agent did and destroyed the user's
uncommitted work. `git status` showing them modified/untracked is CORRECT** · do
not push, do not merge · trailers
`Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` and
`Claude-Session: https://claude.ai/code/session_01BiZGj5ZTDSZi1mB8YtuRcx`.
