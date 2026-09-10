# Phase 5 — digestify: one entry, single-shot, and the playbook's second test

**Created:** 2026-09-09 · **Mode:** thin — Phase B is your path.
**Predecessor:** Phase 4 (bounty), landed `a061139`; pre-work `6c4428b4`.

---

## Read first

**`docs/playbooks/porting-a-spell-playbook.md` Phase B — rewritten yesterday FOR
YOU.** It no longer keys its steps on the names `cli` and `server`; it opens by
asking **four questions of each entry** (what arithmetic does it carry · does it
serve a substituted payload · is there a second half · long-running or
single-shot) and dispatches on the answers, with a worked digestify table. **You
are the first port to run on the rewritten version**, so the same experiment
imago ran applies one level up: **record every place it is still not enough, at
the moment you hit it, before you solve it.**

Then `decision-log.md` D1–D57 (**D42, D52, D55, D56, D57** bind you),
`phase-5-prework.md`, `phase-4-journal.md`, `src/kit/wire/*.ts`, and
`.anthill/dev/seams.md` Contracts 3, 4, 5, 18.

## Why digestify is unlike the four before it

It is the **smallest** subject and the **least normal**: one caller-facing entry
`scripts/review.ts` (725 lines), no `cli.ts`, no `server.ts`, and it is
**single-shot rather than a standing daemon**. Two test files sit beside it in
`scripts/`. The surface reaches into the skill folder only **twice**.

## What is already measured — confirm, do not re-derive

- **D57 · the diagnostic lies, and it is LOUD.** Run from the relocated path,
  `review.ts` exits **2**, twice, and both messages blame the wrong thing — one
  tells the operator to go to a directory that does not exist, because the error
  string is itself computed by running the broken `SKILL_ROOT` through four
  `..`. **Do not expect silence.** The trap is that the loud, confident error
  invites you to fix your cwd and move on.
- **Digestify has no `die` and no error class** — 14 sites of stderr prose plus
  `return 2`. **A grep for `die(` reports "no error contract to change", which
  is the loudest possible wrong answer** for a spell whose SKILL.md publishes a
  per-code sentence for the agent to say to the human.
- **Its exit codes are TWO populations.** `2` is a failure; **124 and 130 are
  session outcomes**, returned from `main` and never raised. They stay outside
  the taxonomy. **`join.ts`'s ruling (D52) is the precedent** — startup failures
  converted, session endings left alone.
- **`serveFromDist` cannot be adopted verbatim.** Digestify's local `serveDist`
  refuses `index.html` **by name**; the kit's does not. Adopting it as-is leaves
  a live `GET /index.html` serving the **unsubstituted** page at HTTP 200. The
  `/` handler must keep serving the substituted payload.
- **There is no heartbeat seam here** — no both halves. Phase B's flagship proof
  does not apply. **Say so out loud in the journal rather than inventing one**
  (D56).

## Scope

Digestify's backend into `src/digestify/backend/`, one launcher at
`scripts/review.ts`, one committed artifact `dist/review.js`, and **the kit
modules that have a subject** — four have none in a single-shot spell and three
are partial; adopt what fits, name what does not and why. Digestify is the
**sixth** consumer: a boundary that is wrong for it is a finding about the
module.

**Out of scope:** other spells; the surface; the epoch parameter (D23); an acc
config (D37).

## Done means

- One artifact built and committed; `dist-check` exit 0 (all arms);
  **`launcher-pairing-ward` green with a row for digestify**;
  **`spawn-path-ward` showing digestify examined, not absent.**
- **Driven on a real run, both modes** — this spell's whole point is a human
  reading a rendered page and submitting once, so drive that, not just the boot.
  **`GET /index.html` must not serve the unsubstituted page.**
- The error contract decided: what converts, what stays a session outcome, and
  why — with 124/130 explicitly outside the taxonomy.
- Gate green **unpiped**; records: `decision-log.md` D58+, `phase-5-journal.md`,
  a session doc, a **Phase B amendment pass**, and — new standing requirement —
  **a row appended to `docs/architecture/spell-backend-architecture.md`'s
  caveats table and any live inconsistency added to `conformance-register.md`.**
  _(That register moved on 2026-09-10 to
  `docs/architecture/house-conformance-register.md`; D92. This brief is left as
  it was given.)_

## Conventions that bite

`bunx biome check --write` on changed `.ts/.tsx` before every commit · gate
UNPIPED (`bun run gate > /tmp/g.log 2>&1; echo $?`) · **build ONLY through
`bun run build`** · rebuild and commit `dist/` in the same chapter as its source
(Contract 18) · story chapters · every process you start gets its own home under
the session scratchpad and is torn down · **never kill pids 23127 or 66902** ·
⛔ **never stage, stash, commit, edit, or `git checkout --` `skills-lock.json`
or `.claude/skills/shadcn/` — an earlier agent did and destroyed the user's
uncommitted work. `git status` showing them modified/untracked is CORRECT** · do
not push, do not merge · trailers
`Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` and
`Claude-Session: https://claude.ai/code/session_01BiZGj5ZTDSZi1mB8YtuRcx`.
