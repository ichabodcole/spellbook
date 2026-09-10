# Phase 6 — grapevine: the spell the spine must refuse

**Created:** 2026-09-09 · **Mode:** thin — Phase B is your path.
**Predecessor:** Phase 5 (digestify), landed `d8cbaff`; pre-work `884b59c`.

---

## Read first

**Phase B, amended twice for you.** `phase-6-prework.md` measured grapevine and
added what it needs: the **REJECT-STRUCTURAL** verdict (D68), the launcher
discriminator keyed on _does `main()` return while the process must keep living_
(D69), and the epoch rule keyed on _are ids recovered across a restart_ (D70).
The entry block now asks **seven** questions, worked on grapevine.

Then `decision-log.md` D1–D70 (**D42, D56, D65, D68, D69, D70** bind you),
`phase-5-journal.md`, `src/kit/wire/*.ts`, `.anthill/dev/seams.md` Contracts 3,
4, 5, 18.

## Why grapevine is the hard one

**It is the first spell the shared spine must partly REFUSE**, and the refusal
is the deliverable. From the proposal, before any port ran: _"grapevine's event
bus cannot be served — its replay reads a durable `.jsonl` off disk and its
subscriber records carry presence metadata. Named and left out."_ The pre-work
confirmed it and priced it.

⛔ **Widening the kit is ruled OUT as the default repair** (D68). A widening
lands in every spell that bundles the module — six artifacts across five spells
— and `sse.ts`'s own header says what a wide signature becomes. **If you reach
for a widening, that is the moment to stop and report instead.**

## What is measured — confirm, do not re-derive

- **`cli.ts` 2,476 lines · `daemon.ts` 1,467 · `cli.test.ts` 2,608** (the second
  largest suite in the repo) · `release-serve.test.ts` 229. The surface reaches
  into the skill folder **once**.
- **D69 · the launcher.** `main()` resolves the instant `Bun.serve` binds — the
  event loop holds the daemon up, not the promise. B2's terminal shape **returns
  to the shell at exit 0 milliseconds after binding**, driven both ways in the
  pre-work. Exit codes live at in-body `process.exit` calls.
- ⛔ **Three defect classes share one error string.** `cli.ts`'s _"daemon failed
  to start within 3s"_ is B4's signature, is D69's symptom, **and** `cli.ts:348`
  attributes it to a third cause in its own comment. **Grapevine genuinely has
  the B4 defect too** — `DAEMON_SCRIPT = join(SCRIPT_DIR, "daemon.ts")`,
  glamour's flat-sibling spawn — so fixing that will NOT clear the message.
  Expect to distinguish three causes behind one sentence.
- **D70 · no epoch.** `loadChannel()` derives `next_id` as a high-water mark
  over the durable `.jsonl`, so ids survive a restart. Stamping an epoch **and**
  adopting `tailEvents` makes every `roll` replay every message of every tailed
  channel into an agent's pipe.
- **The kit rows, already ruled:** `eventLog` and `sse` are
  **REJECT-STRUCTURAL** (one capped in-memory array vs N durable per-channel
  logs; `Set<{close,send}>` vs a `Map` whose metadata **six** routes read).
  `housekeeping` is **SPLIT** — `shouldIdleClose`/`startHousekeeping` NO
  SUBJECT, `drainAndStop` PARTIAL (its stop-race _is_ grapevine's
  `Promise.race`). **`serveDist` is RECEIVED, not a keep** — the kit gained the
  whitelist in `2c61cde5`, and this phase is exactly what makes it load-bearing:
  it puts `daemon.js` and `cli.js` into the served directory.
- **Question 3 answers YES** — the heartbeat seam is real here, the first time
  in three ports. The daemon beats on a literal `3000` against
  `idleTimeout: 255`.
- **`daemon.ts` holds the roster's one `src/`-naming specifier** — a dev-only
  dynamic import, five `..`, pinned by `import-boundary-wards.test.ts`. B5's
  re-point has a ward reading it.

## Scope

Grapevine's backend into `src/grapevine/backend/`, two launchers (`cli.ts`,
`daemon.ts` — **the daemon's is NOT the terminal shape**), two committed
artifacts, and the kit modules that survive their verdict. Grapevine is the
**seventh** consumer.

**Out of scope:** mind-mapper; the surface; the epoch parameter (D23); an acc
config (D37).

## Done means

- Two artifacts built and committed; `dist-check` exit 0 all arms;
  `launcher-pairing-ward` green with a row for grapevine; `spawn-path-ward`
  showing both artifacts **examined, not absent**.
- **`GET /daemon.js` and `GET /cli.js` refused, driven** — with the artifacts
  proven on disk first (D65's cell shape).
- **A daemon that stays up**, driven through the real launcher, and the
  three-causes-one-string knot untangled with each cause named.
- **Every REJECT-STRUCTURAL written in BOTH places** (D68): a journal row
  carrying the kit's type, the spell's type, **the reader that makes them
  incompatible**, and the widening not-done with its blast radius — plus a line
  in the kit module's own header naming grapevine and the reason.
- Gate green **unpiped**; records: `decision-log.md` D71+, `phase-6-journal.md`,
  a session doc, a **Phase B amendment pass**, a **caveats row**, and any live
  inconsistency filed in `conformance-register.md`. _(That register moved on
  2026-09-10 to `docs/architecture/house-conformance-register.md`; D92. This
  brief is left as it was given.)_

## Conventions that bite

`bunx biome check --write` on changed `.ts/.tsx` before every commit · gate
UNPIPED (`bun run gate > /tmp/g.log 2>&1; echo $?`) · **build ONLY through
`bun run build`** · rebuild and commit `dist/` in the same chapter as its source
(Contract 18) · story chapters · every daemon gets its own home under the
session scratchpad and is torn down · ⛔ **nothing you create may land in the
repo root — ten empty directories were left there today by earlier runs and no
instrument could see them (`git status` does not track empty dirs)** · **never
kill pids 23127 or 66902** · ⛔ **never stage, stash, commit, edit, or
`git checkout --` `skills-lock.json` or `.claude/skills/shadcn/`** · do not
push, do not merge · trailers
`Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` and
`Claude-Session: https://claude.ai/code/session_01BiZGj5ZTDSZi1mB8YtuRcx`.
