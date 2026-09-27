---
type: artifact
title: "Sprint 06 — Filed is not fixed"
description:
  Sprint 06 plan scaffold created before the sprint, noting that three ratify
  rounds have falsified claims across previous sprints
status: stable
generated: { by: unknown, at: 2026-08-11 }
---

# Sprint 06 — Filed is not fixed

> **✅ THIS FILE EXISTS BEFORE THE SPRINT, WHICH IS THE ONE THING SPRINT 05
> COULD NOT SAY.** Sprint 05 was convened, scoped and built to 33 commits with
> no `plan.md` in the tree; its container was created at finalize and says so.
> **The gap was found by the docs-of-record sweep, not by anyone noticing during
> nine hours of work.**
>
> ⛔ **AND A SCAFFOLD IS NOT A PLAN.** Three ratify rounds have killed **six,
> two and six** claims respectively — including, in sprint 03, the predicate
> every lane was about to be built on. **Nothing below has survived that.** Read
> it as the author's argued guess, and expect the convene to kill some of it.
> The falsifiers are named at the bottom so the round has something to shoot at.

## The shape — ruled by Cole, 2026-08-11

**Two phases, in order: drain the fix queue, then close clause (ii).**

**The option not taken, and the reason it was live:** a pure gate sprint (clause
(ii) + row 3 + the demotion half + second-seat calibration) is continuous with
sprint 05 and would have been the smaller, more predictable sprint. It was
declined because **the fix queue has been deferred by four consecutive scope
rulings, one of its items is another team's open issue, and one destroys data at
`ok:true`.**

> ⚠ **THE RISK COLE ACCEPTED, IN THE PROJECT'S OWN WORDS — quote it at the
> convene rather than rediscovering it:** _"a discovery lane that inherits a
> harness's schedule is how a sprint lies about its size."_
> ([roadmap.md](../../roadmap.md))
>
> **Phase 2 is the harness half and phase 1 is a fix queue with at least two
> undecided design calls in it.** The named mitigation is the phase boundary:
> **phase 2 does not start until phase 1 lands**, and if phase 1 eats the sprint
> then phase 2 is CUT and said so, not compressed. **"Build two and say so"** —
> sprint 05's standing permission — applies to this sprint whole.

## The thesis

**A finding that is filed is not a finding that is fixed — and the same gap one
rung up: a rule that is written is not a rule that is enforced.**

Both phases are the distance between **the record** and **the effect**. Phase 1
is the project's own backlog, which it has been filling faster than draining
(**12 issues filed against 9 pre-existing**, plus every `docs/backlog/` item,
which the issue count cannot see). Phase 2 is clause (ii): a rule in prose and a
check in `.test.ts` have **no shared mechanism**, so nothing detects the gap
between them.

⚠ **This thesis is a candidate and it is the most falsifiable thing in this
file.** It reads well, which is exactly the property sprint 05 learned to
distrust. If the convene finds the two phases share only a rhyme, **say so and
let the sprint have two theses** — a sprint is allowed to be two things; a
sprint that PRETENDS to be one thing is how scope hides.

---

## Phase 1 — the fix queue

**Every item was found by this team, filed with a measurement, and held out of a
sprint by an explicit ruling.** None is a discovery; all have durable homes.

| item               | what                                                                           | home                                                                            | state at scaffold                                             |
| ------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **`s5-9`**         | `bounty update --stdin` writes the TITLE; `valuesIgnored: null` lies about it  | [backlog](../../../../items/bounty-update-stdin-misroutes-to-title.md)          | **doc warning shipped `05a30d3`; CODE UNTOUCHED**             |
| **`s5-5`**         | `update --notes ""` cannot tell a deliberate clear from a dead substitution    | [backlog](../../../../items/bounty-notes-clear-vs-empty-substitution.md)        | open — **same verb, same field family as `s5-9`**             |
| **`s5-6` / `#98`** | a tail that resolves no board retries forever at exit 0, looking alive         | [backlog](../../../../items/bounty-tail-unresolvable-target-retries-forever.md) | open — **INBOUND, another team is waiting, cost them 40 min** |
| **`s5-8`**         | `astrolabe close` exits 0 carrying an error envelope — wrong on both axes      | [backlog](../../../../items/astrolabe-close-exits-zero-with-error-envelope.md)  | open — **read the 2026-08-10 amendment first**                |
| **`c1`**           | the `--` terminator eats `--session-key`; the write lands on the ambient board | [carries](../05-the-gate/carries.md)                                            | open — **this is row 2's live half** (see below)              |
| **STALE DIST**     | mind-mapper's staleness warning fires unconditionally                          | [backlog](../../../../items/stale-dist-fires-unconditionally.md)                | open — **it fires in this repo's own test output today**      |

### The two design calls phase 1 cannot start without

1. **`s5-9` + `s5-5` may be ONE repair.** Same verb, same field family. The
   candidate repairs on the table: refuse `--stdin` on `update` as having no
   referent, or require it to name a destination field; and for `s5-5`, refuse
   an empty `--notes`/`--title` without an explicit clear, and/or report what
   was replaced. **⛔ Do not adopt the withdrawn `s5-9` framing** ("`--stdin`
   should mean notes on `update`") — it would make bounty inconsistent with
   itself, and its author withdrew it twenty minutes after filing.
2. **`c1` is row 2's DEMOTION half, and sprint 05 did not solve it.**
   `terminator-invariant` solves **promotion** (free text → flag name). Demotion
   — a real flag silently swallowed as a positional — is untouched, and it is
   `c1`'s actual mechanism. **A reader of sprint 05's deliverable listing would
   think row 2 is closed. It is not.** Denominator is already measured and
   already instrumented: **7 entry points by path, 16 by behaviour**; reuse
   `grimoire/lib/entry-points.ts`, do not re-derive.

### What phase 1 is NOT

- **Not `s5-1`** (bounty speaks `noop: true` while four spells speak the
  contract's nouns). It is a wire change with a named open question that is
  **Cole's, not the team's** — whether `already-connected` earns its place as an
  echo. Carried, not scheduled.
- **Not `s5-3`** (mechanize the null-vs-absent assertion allow-list). Its
  motivating instance was **withdrawn in full by its originator**; the durable
  output is the contextual deny-list refinement. That is gate work with a
  wasting calibration arm — **if it is scheduled at all it belongs in phase 2.**
- **Not `s5-2` or `s5-4`.** Both are **anthill feedback, not spellbook code**
  ([drafted, unfiled](../../../../items/anthill-feedback-drafted-unfiled.md)).
  They move when Cole sends them, and that is not sprint work.

---

## Phase 2 — clause (ii), and the deferrals with a sprint-06 horizon

**Clause (ii), verbatim from the end condition:** _every rule must name the
check that enforces it, and every check must cite the rule it enforces —
bidirectionally, and the link itself is gated._

⭐ **The template is already built and battle-tested.**
`grimoire/flag-invariant.test.ts` enforces a different pair (`SKILL.md` ↔
entry-point flags) **in both directions with a zero-denominator guard on each
side**, and it survived three wrong enumerators to get there. **It also just
convicted this scaffold's own predecessor commit** — it refused a proposed flag
spelling in shipped prose, which is clause (ii)'s exact shape arriving early.

| #      | item                                                                                                                                    | source                                                        |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **ii** | rule ↔ check, both directions, gated                                                                                                    | Cole's ruling at sprint 05's convene                          |
| **D6** | **second-seat calibration**: `roster-drift` (17 cells) · `gate-honesty` (5) · `terminator-invariant` (4) · `strict-parse-invariant` (3) | sprint 05, retro H3 **partially run**                         |
| **D2** | `outcome-contract.md` has no decay-ledger row and **cannot get one** as the ledger is keyed                                             | [backlog](../../../../items/outcome-contract-cannot-decay.md) |
| **D4** | the hop — value-position `?.` reads of present-and-null fields in shipped code. **Zero is a welcome answer.**                           | sprint 05 deferral table                                      |
| **D3** | the `biome.json` `useOptionalChain` exemption vs the canon — **blocked on D4**                                                          | sprint 05 deferral table                                      |
| **D1** | canon: **a response states its TARGET, not just its outcome**. Deliberately not minted unratified.                                      | sprint 05 deferral table                                      |
| **D5** | digestify's `reason` divergence — "to be carded, never silently converted"                                                              | already in `grimoire/outcome-contract.md`                     |

> ⚠ **D6 IS NOT BOOKKEEPING AND THE LISTING HIDES IT.** Four of seven suites
> carry **one pair of eyes each — their author's.** Sprint 05's own outcome says
> the seven-suite listing "reads as seven equally warranted wards and it is
> not." **A roster-wide cell verified against one spell is uncalibrated for the
> other seven, and reads identically.** Calibrate in a **detached git worktree**
> (`git worktree add --detach <path> HEAD`), never a directory copy — a copy
> silently ran 30 cells where the real tree runs 46, and **the dangerous case is
> the count, not the crash.** The calibrator must print `pass / fail / CELLS`
> and reconcile the cell count against the real tree.

### Row 3 — the exit-code contract

**Not cut in sprint 05**, scoped with its cost named. It is the third
behavioural row and the only one still unbuilt. **Phase 2 candidate, and the
first thing to drop** if phase 1 runs long — sprint 05's standing permission to
build two and say so was given for exactly this row.

---

## Explicitly OUT — with the reason, so nobody re-litigates it

- **The `tsc --noEmit` gate.** Its own project, measured at **436 errors**, 61%
  from `noUncheckedIndexedAccess`.
  [Ruled](../../../../items/typecheck-gate-is-a-project-not-a-flag.md).
- **The r8 RED-set classification.** 113 RED / 11 GREEN, reproducible in one
  command (`bun scripts/instruments/r8-outcome-check-v3.ts`). **The set has an
  artifact; the CLASSIFICATION does not, deliberately** — the count is inflated
  by a by-name mutator list and nobody is permitted to turn it into a scope
  without a decision first.
- **mind-mapper's packaging question** — whether its built `dist/` should ship
  while it is WIP. **Cole's, not the team's**; its undeclared state is
  intentional by his ruling, and `roster-drift` asserts over 7 of 8 folders
  because of it.
- **Anything from a future investigation.** This project has filed more issues
  than it started with; **that is the method working**, and it is also the
  reason this scaffold cannot forecast what the sprint will find.

---

## What would falsify this scaffold — shoot at these first

**Written so the ratify round has targets. A scaffold with no named falsifier is
a scaffold nobody can kill, which is the state sprint 03's predicate was in.**

1. **"`s5-9` and `s5-5` are one repair."** Not measured — read off the fact that
   they share a verb and a field family. **If they are two repairs with
   different shapes, phase 1 is bigger than this file says.**
2. **"The fix queue is not a discovery round."** Every item has a home and a
   measurement, **but at least two have undecided design calls, and a design
   call is a discovery round wearing a fix's clothes.** This is the specific
   mechanism by which this sprint would lie about its size.
3. **"The template transfers."** Clause (ii) is claimed to be `flag-invariant`'s
   pattern pointed at a new pair. `flag-invariant` reads a `SKILL.md` table with
   a stable shape; **`house-style.md`'s rules were enumerated four different
   ways in one day, with three of them wrong.** If the rule set cannot be
   enumerated by behaviour, clause (ii) is a discovery round.
4. **"Both phases share a thesis."** See above; the honest fallback is two
   theses.
5. **`STALE DIST` is listed as a fix and may be a ruling.** It fires
   unconditionally today; whether that is a bug or the correct signal for a WIP
   spell touches the packaging question, **which is Cole's.**

## Decision log

| date       | decision                                                                                                                                                                                                                                                                                                                                                                              | by                        | option not taken                                                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-11 | Sprint 06 is **fixes first, then the gate**, one sprint, phase-ordered                                                                                                                                                                                                                                                                                                                | Cole                      | a pure gate sprint (smaller, continuous with 05); or a pure fix sprint deferring (ii)                                                                                                                     |
| 2026-08-11 | `s5-9`'s **doc warning ships ahead of the sprint** on its own branch; the code repair goes to phase 1                                                                                                                                                                                                                                                                                 | Cole                      | folding the warning into the sprint (leaves the destructive path undocumented for weeks)                                                                                                                  |
| 2026-09-27 | Convened as cycle `2026-09-filed-is-not-fixed`, after the acc cycle (Cole: "acc work first, then back to spell hardening")                                                                                                                                                                                                                                                            | Cole                      | convening before acc (would have fixed bounty's parser twice)                                                                                                                                             |
| 2026-09-27 | The ratify round is a **re-measure**: a no-stake subagent runs every phase-1 defect on `develop` before any fix is briefed, because the acc cycle rewrote bounty's and astrolabe's parsers since these were filed                                                                                                                                                                     | lead                      | ratifying from the August measurements (falsifier 2: a stale repro is a discovery round wearing a fix's clothes)                                                                                          |
| 2026-09-27 | `feature/spell-hardening` goes `done` → `active` while this cycle runs                                                                                                                                                                                                                                                                                                                | lead                      | leave it `done` with an active cycle under it (the board would show no work in play)                                                                                                                      |
| 2026-09-27 | Re-measure ([remeasure.md](./remeasure.md)): all five still live. **Falsifier 1 half-holds**: `s5-9`+`s5-5` are two edits in the same four lines sharing one envelope, so **one item pair, one implementer**                                                                                                                                                                          | lead                      | two implementers on the same lines (guaranteed conflict)                                                                                                                                                  |
| 2026-09-27 | ⭐ `s5-9`: `update --stdin` keeps meaning **title** (consistent with `add`), is **refused together with `--title`** (exit 2), and **refused on empty stdin** (as `add` and anthill's `comms` do). The envelope names the fields it wrote                                                                                                                                              | lead                      | refuse `--stdin` on `update` outright (breaks a documented verb for no gain); `--stdin --into` (new surface for a case no caller has); `--stdin` means notes (withdrawn framing, inconsistent with `add`) |
| 2026-09-27 | ⭐ `s5-5`: an empty `--title` is refused (as `add` does); an empty `--notes` is refused unless `--clear-notes` is given; `--clear-notes` with `--notes` is refused                                                                                                                                                                                                                    | lead                      | report prior values (a daemon wire change, the only repair covering both, deferred); keep accepting `""` and only warn (a warning with no act that answers it)                                            |
| 2026-09-27 | ⭐ `#98`: ask 1 on **every** retry line (key, derived id, cwd); a **named** target (`--session` or `--session-key`) unresolved after a fixed grace exits non-zero with `not_found` and that line; an explicit `--session` that never existed stops saying "closed" and stops offering `open --restore`. An unpinned tail keeps waiting                                                | lead                      | a `--grace` flag (no caller has asked; the reporter asked for "a few seconds"); keep exit 0 on the stop (the issue's whole point is that supervisors cannot see it)                                       |
| 2026-09-27 | `s5-8`: the sequencing constraint has **lapsed** (no ward references the site); close goes through `cmd()`'s discipline, and close-with-no-daemon becomes a benign no-op with an outcome noun and no error, per the item's own reading. Close waits (bounded) until the daemon is down before returning, which removes the fixture trap                                               | lead                      | only flip the exit code (keeps the error on a no-op, the item's "wrong on both axes")                                                                                                                     |
| 2026-09-27 | ⭐ `c1` demotion: the **registry** emits one stderr warning when a token after `--` exactly matches a flag that row accepts, naming the recovery (move the flag before `--`). Exit and stdout unchanged. One fix covers all 43 variadic rows                                                                                                                                          | lead                      | refuse it (breaks `--`'s purpose: writing text that contains a flag name is legitimate); fix per spell (43 copies)                                                                                        |
| 2026-09-27 | The four same-class findings go to `triage` as items, not into this cycle                                                                                                                                                                                                                                                                                                             | lead                      | fold them in (the plan's own warning: a discovery lane is how a sprint lies about its size)                                                                                                               |
| 2026-09-27 | Four implementers in parallel worktrees, one per repair; source commits cherry-picked, `dist/` rebuilt once on the cycle branch (`5554e12b`); golden and census pins regenerated or summed on conflict, not hand-merged                                                                                                                                                               | lead                      | serial implementers (no shared lines except generated fixtures and one census pin)                                                                                                                        |
| 2026-09-27 | `c1` lands as **warned, not refused**, which is the ⭐ ruling above, and so falls short of the item's own "never silently a positional". Its entry-point ward (zero-denominator guard over the 7/16 entry points) is not written; it is gate work and **carries to phase 2**                                                                                                          | lead                      | write the ward in phase 1 (phase 1 is fixes; the plan's phase boundary)                                                                                                                                   |
| 2026-09-27 | `astrolabe close` still up after the 3 s wait is `internal`, exit 1, not bounty `b14`'s `ok:true, down:false`; the noun is `already-closed` (astrolabe's `already-*` family). The stale-port triage item is covered by the same fix and says so; its lifecycle is left to triage                                                                                                      | implementer, kept by lead | mirror bounty's `down:false` (reports the act, not its completion — the defect this item is about)                                                                                                        |
| 2026-09-27 | `#98`: "never existed" and "existed and closed" are told apart by the close snapshot; a deleted snapshot reads as never existed, so the wording is "no session found", not "never existed". A seat re-arm whose keyed board never opened now exits 5 `not_found` after the grace instead of `tail.closed`. anthill 2.3.0 only runs `tail --mine --as` (unpinned), so it is unaffected | implementer, kept by lead | a `--grace` flag; keep exit 0 on the stop                                                                                                                                                                 |
| 2026-09-27 | `update --stdin` accepts whitespace-only input, matching `add` (the brief said "count as empty" and "match add"; they conflicted and `add` won)                                                                                                                                                                                                                                       | implementer, kept by lead | refuse whitespace on `update` only (the two verbs would disagree again, the `s5-5` shape)                                                                                                                 |

---

_Scaffold authored by the lead. **It has a known bias and the project has said
so before:** the same seat wrote the roadmap forecast this scaffold inherits.
[Sprint 05's cold read](../05-the-gate/cold-read.md) found that **three of eight
contradictions were the lead's documents** and none was caught by anyone who
worked on the sprint. **This file should be cold-read by someone with no stake
in it before the convene ratifies it.**_
