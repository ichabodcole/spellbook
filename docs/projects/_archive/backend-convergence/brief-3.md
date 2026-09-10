# Phase 3 — imago, and the first real test of the playbook

**Created:** 2026-09-08 · **Author:** Claude Code (orchestrator) · **Mode:**
**deliberately thin.** **Predecessor:** Phase 2 (glamour), landed `e88ae5e`.

---

## Read this first: what is being tested

Phase 2 produced **Phase B of `docs/playbooks/porting-a-spell-playbook.md`**
(line 856), written from glamour's failures so that five more spells could port
without re-earning them. **You are the first port that runs on it.**

So this brief is short on purpose. **Phase B is your path, not this document.**
Where the playbook is enough, follow it. Where it is not, that is the finding
this phase exists to produce:

⛔ **Every time you have to go outside Phase B — a step it does not mention, a
step whose instruction does not fit imago, an order that turns out to be wrong,
a decision it leaves you to make alone — STOP AND WRITE IT DOWN AT THAT
MOMENT**, in `phase-3-journal.md`, before you solve it. Then solve it.

**The list of those moments is this phase's most valuable output**, worth more
than the diff, because four spells port after imago and each gap you record is a
gap none of them pays for. A port that goes perfectly and reports "the playbook
was fine" has told us nothing we can check.

**Do not fix the playbook as you go.** Record, port, then amend it in one pass
at the end with everything you learned. Amending it mid-port makes it impossible
to say afterwards which version you actually followed.

## Why imago

It is the line glamour forked from, so Phase B should transfer almost intact —
which makes it **the cheapest possible test of whether the playbook works for
someone who wasn't there.** If Phase B fails here, it fails everywhere, and it
fails now rather than on grapevine.

## What I measured — confirm, do not re-derive

- **The backend is 2,438 lines across three files:** `server.ts` (**1,765** —
  larger than glamour's whole backend), `cli.ts` (653),
  `imageOptimize.server.ts` (20). Plus `shared/`, `tests/`, and a `references/`
  directory no other ported spell has.
- **The surface imports the skill folder 33 times** — nearly double
  glamour's 17. D10's rule (a module moves iff no surface file imports it)
  decides what stays.
- **Both entries are `if (import.meta.main)`** — `cli.ts:642`, `server.ts:1758`.
  Phase B step B3 covers this; confirm it does.
- **Both anchors are the bare spelling**
  `dirname(fileURLToPath(import.meta.url))` (`cli.ts:38`, `server.ts:59`) — the
  one the spawn-path ward has always read. So the ward should print
  `anchor-read=yes` with a non-zero pin count for imago. **Per B4, confirm that
  it does rather than assuming it.** If imago's emitted bundles produce
  `pins=0`, the ward is not guarding this port.
- **imago has NO `acc.config.json`, and that is fine** (D37, closed today from
  measurement): nothing in the tree requires one, so this port does not acquire
  an acc grade and is not gated on one.

## Scope

**Imago's whole backend, following Phase B.** Chapter it as B prescribes, gate
between chapters. Adopt all of `src/kit/wire/`. Imago is now the **fourth**
consumer of those modules — where a boundary is wrong for imago, that is a
finding about the module, not about imago (Phase 2 widened two of them for
exactly this reason).

**Out of scope:** every other spell; the surface; the epoch query parameter
(D23); an acc config (D37); choosing one discovery convention (D3).

## Done means

- Both artifacts built and committed; `dist-check` exit 0; roster green.
- **Dev and release both driven on a booted daemon**, per B7.
- Imago's own census defects closed **by adoption**, each named with the module
  that closed it.
- The spawn-path ward confirmed to actually cover imago (`anchor-read=yes`,
  `pins > 0`).
- Gate green **unpiped**, exit read from a file.
- `decision-log.md` (D38+), `phase-3-journal.md`, a session doc — **and a Phase
  B amendment pass** carrying every gap you recorded.

## Conventions that bite

`bunx biome check --write` on changed `.ts/.tsx` before every commit · gate
UNPIPED (`bun run gate > /tmp/g.log 2>&1; echo $?`) · **build ONLY through
`bun run build` — never a bare `bun src/build.ts`, which resolves a different
Bun and dirties all eight spells** (see the backlog item on the pin) · rebuild
and commit `dist/` in the same chapter as its source (Contract 18) · story
chapters · every daemon gets its own home under the session scratchpad and is
torn down · **never kill pids 23127 or 66902** · ⛔ **never stage, stash,
commit, edit, or `git checkout --` `skills-lock.json` or
`.claude/skills/shadcn/` — a previous agent ran `git checkout --` on that file
and destroyed the user's uncommitted work. `git status` showing them
modified/untracked is CORRECT** · do not push, do not merge · trailers
`Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` and
`Claude-Session: https://claude.ai/code/session_01BiZGj5ZTDSZi1mB8YtuRcx`.
