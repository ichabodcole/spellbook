# Phase 5 pre-work — Phase B is keyed on a `cli`/`server` pair, and digestify has neither

**Measured 2026-09-09, before writing digestify's brief. No spell was ported.**

**Why a new document rather than an append to `phase-4-prework.md`.** That doc
is bounty's pre-work and its subject is `src/build.ts` — the entry-derivation
ruling (D43). This one's subject is the PLAYBOOK, and its port is digestify's.
Two subjects, two ports, two documents; appending would have made the D43
account harder to find and would have implied this work was bounty's.

## The finding

D43 corrected Phase B's arithmetic — "two entries, `cli.ts` and `server.ts`" →
the entry set is derived from launchers — and **left the body of the phase keyed
on the pair.** An independent verify pass read Phase B cold, as digestify's
porting agent, and ruled it not safe to hand over: four steps produce a wrong
result if followed literally, two of them silently.

Digestify's shape: **one caller-facing entry**,
`plugins/spellbook/skills/digestify/scripts/review.ts`. No `cli.ts`, no
`server.ts`. Single-shot rather than standing.

## What was measured, and what it showed

### 1 · B3's arithmetic — CONFIRMED, and the predicted symptom FALSIFIED

`review.ts:40-42` carries the daemon `SKILL_ROOT` arithmetic:

```ts
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = join(SCRIPT_DIR, "..");
const DIST_DIR = join(SKILL_ROOT, "dist");
```

B2 labels `review.ts` a CLI (its stdout is one JSON object an agent parses), and
B3 then said _"the CLI may keep both — its ancestor paths are correct from
either address."_ For digestify that premise is false: from
`src/digestify/backend/` the arithmetic yields `src/digestify/dist`, which has
no `index.html`, so `resolveMode()` returns `dev`.

**Driven** — copied to `src/digestify/backend/review.ts`, run from two cwds,
file removed afterwards:

| cwd             | result                                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| repo root       | **exit 2**, `cannot start in dev mode from this directory`, `needed: … /Users/colereed/src/digestify` — **a path outside the repo** |
| `src/digestify` | **exit 2**, `the surface source is missing`, `Cannot find module '../../../../../src/digestify/surface/index.html'`                 |

**The defect is confirmed; the reported symptom is not.** It was reported (by
the playbook and by the verify pass) as a silent exit 0 reading as a surface
bug. It is a LOUD exit 2 that **misattributes**: the first blames the operator's
cwd for a Contract 1 anchoring defect and names a nonexistent directory —
because the error message is computed by running the broken `SKILL_ROOT` through
`DEV_SURFACE_CWD`'s four `..`. **A diagnostic computed from a broken anchor lies
confidently.** Recorded as **D57**; that is the more dangerous half, because an
agent told to look for silence will meet a specific exit 2 about its cwd and
conclude B3 does not apply.

### 2 · B5's pin destination — CONFIRMED

Ward 1a's live row for digestify:

```
file:     plugins/spellbook/skills/digestify/scripts/review.ts
spec:     ../../../../../src/digestify/surface/index.html
resolved: src/digestify/surface/index.html
```

B5 named the re-pin destination as the literal `…/dist/server.js`. Digestify's
is `…/dist/review.js`. A literal follow pins a file that does not exist and the
ward goes green **because it stopped looking** — Contract 19, the exact failure
the step exists to prevent. A step reproducing its own scar while warning about
it is the worst kind of literal.

**Also measured:** the depth coincidence B5 warns about **does hold** here —
`scripts/review.ts` and `dist/review.js` are both one level under the skill
root, so the five `..` are right at both addresses. And there is a **second**
string of the same shape that ward 1a cannot see because it is COMPUTED:
`DEV_SURFACE_CWD = join(SKILL_ROOT, "..", "..", "..", "..", "src", "digestify")`,
right from `dist/` and wrong from `src/<spell>/backend/` — which is what drive
(b) above printed.

### 3 · B7's expected red — CONFIRMED

`git grep digestify grimoire/` — **zero rows in `exit-site-inventory`** and zero
in `terminator-invariant`. `review.ts` has no `process.exit` at all: it is
`process.exitCode = await main(...)` plus a natural return, under a comment
citing bounty's A-drain measurement. B7 sends the agent hunting a red that
cannot occur, or manufacturing rows.

The full list sweep, which is now a table in B7:

| list                            | digestify                                            |
| ------------------------------- | ---------------------------------------------------- |
| `exit-site-inventory`           | zero rows — correct                                  |
| `terminator-invariant`          | zero rows — correct                                  |
| `INTERNAL_ENTRY_POINTS`         | no key, and must not gain one                        |
| `flag-invariant`                | derived; follows the entry                           |
| ward 1a's pin                   | **RED** — one row to re-point                        |
| `DECLARED_EMITTED_ROOTS`        | **RED** — five roots today, digestify not among them |
| `spawn-path-ward`'s escape list | **RED** — `DEV_SURFACE_CWD`, once emitted            |
| `daemon-lifecycle-ward`         | generic since Phase 1b; green is expected            |

### 4 · B8 — CONFIRMED, and sharper than reported

**`serveFromDist`.** Digestify's `/` returns `substitute(source)` — the built
HTML with the review payload injected in memory. Its local `serveDist` refuses
`index.html` **by name**; `serveFromDist`'s guards are empty/`..`/nested only.
So adopting it verbatim with the house router expression
(`path === "/" ? "index.html" : path.slice(1)`) serves the unsubstituted
document at HTTP 200 with nothing red — **and even without that, it leaves a
live `GET /index.html` route that answers the unsubstituted page**, because the
refusal being deleted is digestify's, not the kit's. `src/kit/wire/serveDist.ts`
already documents the boundary in its own header, from the eight-daemon census;
B8's table did not.

**Module subjects.** The report said five of eight rows have no subject. As
measured it is **four with no subject** (`eventLog`, `sse`, `tailEvents`,
`discovery` — the last of which `review.ts` states outright: _"There is no
discovery file, no ready EVENT and no stdout handshake"_) and **three partial**
(`serveDist`, `heartbeat`, `housekeeping` — `shouldIdleClose` has a subject, its
idle watcher slid forward by a `POST /heartbeat` from the page; `drainAndStop`
does not, teardown being one `await server.stop()`). `errors` has a subject.

**The `heartbeat.ts` seam.** _"Give the spell its own `backend/heartbeat.ts` and
let BOTH halves import it … that file IS the seam, and the cleanest proof the
port worked"_ — **unexecutable, confirmed. There are no both halves.** The
sentence welded two claims together: the DERIVATION rule (always applies, and is
what astrolabe's +47.4 s / +92.6 s / +137.9 s measurement paid for) and the
de-duplication DEVICE (applies only with a second half). They are now separate.

**And one thing neither the report nor the playbook mentions.** Digestify raises
with `process.stderr.write("error: …"); return 2;` at **fourteen sites** — no
`die`, no error class, no envelope, so a grep for `die(` reports "no error
contract to change", the loudest possible wrong answer for a spell whose exit
codes SKILL.md publishes in a table with a per-code sentence for the agent to
say to the human. Its codes split into **failures** (2) and **session outcomes**
(124 idle timeout, 130 tab closed), and only the first belongs to `errors.ts`'s
taxonomy — which already agrees at `usage: 2`. **D52 is the precedent**:
`join.ts` adopted the envelope for startup failures and kept its own numbers for
session endings. Adopting the taxonomy over 124/130 would re-spell the two
states digestify exists to distinguish.

**And the epoch ruling does not arise** — no event log, so no `createEventLog`,
so L6 neither closes nor narrows. It must be written down as N/A rather than
omitted.

## Lower-severity items, all confirmed

- **B2's two shapes answer a single-entry agent by accident.** The shape is
  decided by the STDOUT contract and says nothing about lifecycle or arithmetic;
  digestify is CLI-by-stdout, server-by-lifecycle, daemon-by-arithmetic. B2 now
  says which question it answers, and B2's third case (a load-bearing exit) now
  says to DRIVE the shape — reading is not how bounty found it.
- **B0 and B4 pointed at instrument repairs that have landed.** `dist-check` ARM
  1b no longer reads two file names (D49) and names `review.js` in advance;
  `spawn-path-ward`'s `emittedFiles()` reads the DISK and labels against the
  index (D42), so B4's `git add` step is unnecessary. Both paragraphs kept and
  re-homed as history — the class has recurred at three levels and a fourth is
  likelier than not.
- **Counts still read "two"** in B4, B6.3 and B10's checklist — now per-entry.
- **The epoch table had no digestify row** — now an explicit N/A ruling.
- **Phase B's header listed bounty as queued** while `DECLARED_EMITTED_ROOTS`
  already contains it — corrected.

## What was changed

- `docs/playbooks/porting-a-spell-playbook.md` — Phase B re-keyed onto four
  per-entry properties, with B2, B3, B5, B7 and B8 dispatching on them; B0 and
  B4's landed repairs re-homed; counts made per-entry; five new checklist boxes.
- `docs/architecture/spell-backend-architecture.md` — digestify's caveats row
  rewritten from what was measured.
- `docs/projects/backend-convergence/decision-log.md` — D55, D56, D57.

**Nothing was ported and no spell source was modified.** The one file created
during measurement (`src/digestify/backend/review.ts`, a copy) was removed in
the same command that ran it.
