# Phase 7 — mind-mapper: the source spell, last

**Created:** 2026-09-09 · **Mode:** thin — Phase B is your path.
**Predecessor:** Phase 6 (grapevine), landed `f287ac3`; pre-work `209967a`.
**This is the last port.**

---

## Read first

**Phase B, rewritten for you** — it assumed the kit was the destination, and
`sse.ts:9` and `eventLog.ts:7` both say _"converged TOWARD mind-mapper's…"_.
`phase-7-prework.md` measured that and added the fifth verdict.

Then `decision-log.md` D1–D84 — **D68 (widening ruled out), D79–D84 (the
LOSSY-COPY verdict and its test), D42, D56, D65** bind you — plus
`phase-6-journal.md`, `src/kit/wire/*.ts`, `.anthill/dev/seams.md` Contracts 3,
4, 5, 18.

## What makes this port different from the six before it

**You are porting the spell the kit was copied FROM.** Five B8 rows say "NO
SUBJECT" about the source of the design. The mechanism was nobody's mistake — D1
proved the spine on the two spells that already built, and astrolabe and magpie
are downstream forks of this line — but the consequence is yours to resolve:
**the source was never in the room.**

**The fifth verdict, LOSSY-COPY, is ruled per PROPERTY, not per module** (D79).
`eventLog` is a loss on the epoch and a genuine gain on three other things.
Disposition per property: **RESTORE / KEEP-LOCAL / FILE.**

⛔ **A restoration is distinguished from a widening by two numbers that must
BOTH be zero** (D80): does any other adopter need a source edit, and does any
byte of its **wire** differ. **Measure the wire, never artifact bytes** —
comment-only kit edits re-emit 11 artifacts across 7 spells, so artifact churn
proves nothing. (A pleasant corollary: grapevine's `server.js` was absent from
those 11 because it refused those modules — a structural refusal is observable
as an artifact that does not move.)

## What is measured — confirm, do not re-derive

- **`scripts/` is 55 files / 16,306 lines** — 23 non-test modules (7,234) and
  **32 test files (9,072)**. Two entries. An `acc.config.json`. **No SKILL.md,
  and that is intentional and RULED** (Cole, `47238d7`) — Phase B now has a
  hatch for it, and `flag-invariant`'s framing of it as pending is a second
  instrument of an older vintage.
- **`errors` is NOT a byte-exact de-duplication — the kit is WEAKER.**
  `reportCliError` returns `null` where mind-mapper triages three usage classes,
  so a naive adoption **regresses them to a stack-trace crash.** This is a
  LOSSY-COPY row, not a de-duplication.
- **`eventLog` forces a wire rename** — the cursor `seq`→`id`. The flatten is
  NOT forced; all five adopters flatten by idiom. The envelope is on the wire in
  167 surface lines and 158 under `scripts/`, plus every JSONL line `tail`
  writes into an agent's pipe. **A wire rename is a first-class cost with a
  required output** in the rewritten B8 — produce it.
- **Two real losses, already triaged:** the pre-replay open frame (a RESTORE
  candidate — **drive the prediction**) and the mandatory epoch, which **needs
  no kit change**, because making the kit's `epoch` required would reverse
  D39/D48/D70.
- **`ALL_EVENT_KINDS` is not a loss** — `createEventLog<T>` is generic and the
  vocabulary was never kit material.
- **`tail.test.ts` is the port's ORACLE**, not a re-point and not a rewrite: it
  imports nothing and spawns the CLI against a scripted fake SSE server. **Green
  before chapter 2, swap the loop, green after.** ⛔ Followed literally, B8's
  derive rule **fails one cell and makes a second pass vacuously** — its
  watchdog knobs are `MIND_MAPPER_TAIL_IDLE_MS` / `MIND_MAPPER_TAIL_RETRY_MS`,
  and D75/D76 are the shape to follow (resolve at the seam, floor in the kit).
- **The daemon is a library with an entry point** — `server.ts:1708` re-exports
  internals that `sse-keepalive.test.ts:7` imports. B6's "test the artifact"
  rule does not model that.
- **Everything moves:** the surface imports **zero** backend modules.
- **`server.ts:1685`** is the "no idle timeout in V1" line (not 1683).

## Scope

Mind-mapper's whole backend into `src/mind-mapper/backend/`, two launchers, two
committed artifacts, and the kit modules that survive their verdict — with
LOSSY-COPY dispositions driven, not asserted. **acc must still pass** (it has a
config; regrading it is a regression).

**Out of scope:** the surface; the epoch query parameter (D23).

## Done means

- Two artifacts built and committed; `dist-check` exit 0 all arms; the pairing
  ward green with mind-mapper's row; the spawn-path ward showing both artifacts
  **examined, not absent** — and note **B4 lists mind-mapper as covered today
  while it has NO anchor row**, which is B4's own failure mode sitting green.
- **`GET /cli.js` and `GET /server.js` refused, driven**, artifacts proven on
  disk first (D65's shape).
- **`tail.test.ts` green on both sides of the adoption**, unmodified.
- **acc re-run from the skill directory, still passing.**
- Every LOSSY-COPY property disposed with its two numbers measured.
- Gate green **unpiped**; records: `decision-log.md` D85+, `phase-7-journal.md`,
  a session doc, a **Phase B amendment pass**, a **caveats row**, and register
  entries for anything live.
- ⛔ **And the roll's own closing items:**
  `grimoire/daemon-lifecycle-ward.test.ts` asks for its own deletion once the
  backends share a spine (register F2) — **decide and act, with the reason
  recorded.** The source-shipping population reaches **zero** at this port,
  which retires the stated reason for a `BUILTIN_EXACT` row and makes stale
  roster prose at `import-boundary-wards.test.ts:1082` and `src/build.ts:121`
  wrong.

## Conventions that bite

`bunx biome check --write` on changed `.ts/.tsx` before every commit · gate
UNPIPED (`bun run gate > /tmp/g.log 2>&1; echo $?`) · **build ONLY through
`bun run build`** · rebuild and commit `dist/` in the same chapter as its source
(Contract 18) · story chapters · every daemon gets its own home under the
session scratchpad and is torn down · ⛔ **nothing you create may land in the
repo root** (`find . -maxdepth 1 -type d -empty` before you finish) · **never
kill pids 23127 or 66902**, and several grapevine/mind-mapper processes predate
today — leave them · ⛔ **never stage, stash, commit, edit, or `git checkout --`
`skills-lock.json` or `.claude/skills/shadcn/`** · do not push, do not merge ·
trailers `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` and
`Claude-Session: https://claude.ai/code/session_01BiZGj5ZTDSZi1mB8YtuRcx`.
