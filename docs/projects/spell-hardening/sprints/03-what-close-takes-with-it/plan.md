# Sprint 03 — What close takes with it

**Created:** 2026-08-07 · **Status:** 🟢 RATIFIED — scope cut and lanes open ·
**Base sha:** `003af0d` (`develop`) · **Branch:** `fix/spell-hardening-03` ·
**Project:** [Spell Hardening](../../README.md) ·
[proposal.md](../../proposal.md) · **[decisions.md](./decisions.md)**

**Predecessor:** [sprint 02 outcome](../02-success-shaped-lies/outcome.md) —
read it before this.

> ⛔ **LINE NUMBERS IN THIS DOCUMENT ARE PINNED TO `003af0d` AND MOST HAVE
> ROTTED — anchor on the SYMBOL NAMES.** Six commits landed after this was
> written. Measured at finalize: the signal handlers cited as
> `server.ts:603-610` are now at 690-691; `cli.ts:525-533` is at 594;
> `cli.ts:259-261` is at 262. **They are left as written rather than renumbered
> — renumbering makes them correct until the next commit and wrong silently
> after, which is the same trap one lap later.** See
> [`decisions.md`](./decisions.md) for the measurement.

> ## 🟢 Ratified 2026-08-08. Build from the CUT, not from the original scope.
>
> This document was a 🟡 scaffold until the ratify round of 2026-08-07/08. **The
> round did what it was for: it killed the predicate every lane was about to be
> built on.** Read [`decisions.md`](./decisions.md) alongside this — the
> rulings, the options not taken, and the six falsifications live there.
>
> **⛔ Six claims in this document were falsified by measurement. They are
> marked `⛔ FALSIFIED` inline and indexed in
> [`decisions.md` §B](./decisions.md#b). Where a falsified claim and a ratified
> one disagree, the ratified one wins — and the falsified text is kept rather
> than deleted, because a plan that quietly heals looks like one that was
> right.**
>
> **Base sha corrected:** the header said `e582150` while the branch was cut at
> `003af0d` — two commits ahead, **and both were this document's own rulings.**
>
> **This document had one cold read** (2026-08-07, fresh agent, no repo access)
> before the round. Its findings were folded in, and **the round then falsified
> two claims the cold read had passed** — a cold read is not a substitute for a
> measurement.

---

## Orientation — you were just spawned as a seat, start here

**The gate, for every commit in this sprint:**

```bash
bun run check && bun test          # run UNPIPED; `| tail` reports tail's exit code
```

**The team.** Five seats are defined in `.anthill/config.json`; the lead is
`prospero`. **The split below was ruled 2026-08-07** — lane assignments are
still the ratify round's to challenge, but the seating is settled: `circe` takes
no lane this sprint, which is correct for the work and is
[a fourth consecutive unseating carried to the finalize reflection](#open-questions).

| seat        | scope                                         | proposed lane — assignments not ratified   |
| ----------- | --------------------------------------------- | ------------------------------------------ |
| `prospero`  | lead — orchestration, the land, human liaison | the beat, sequencing, the decision log     |
| `daedalus`  | conjuration backends + thin `cli.ts` + tests  | P1a/P1b, P1e, P1f                          |
| `cassandra` | cold-agent usability, end-to-end drive        | the live-team beat, P1c                    |
| `thoth`     | craft canon, `inscribe`/`ward`, naming        | P0f-remainder, the denominator re-measure  |
| `circe`     | React studios, Alpine surfaces, theme tokens  | **none — ruled, no surface work in scope** |

**The frozen predecessor plans are READABLE, and you will need them.**
[`../01-drained-exit/plan.md`](../01-drained-exit/plan.md) ·
[`../02-success-shaped-lies/plan.md`](../02-success-shaped-lies/plan.md). _"Do
not act on them"_ means do not build their lanes — they are superseded. It does
**not** mean do not read them. Sprint 02's `## Gate law` section is the full
text of G1–G8 and is the authority when the summaries below are not enough.

**Also read:**
[sprint 02's decision log](../02-success-shaped-lies/decisions.md) (18 decisions
with options-not-taken; A3, A4, A12 and A16 bear on these lanes) ·
[`.anthill/retro.md`](../../../../../.anthill/retro.md) (last round's
hypotheses, each with its falsifier — name the ones this sprint tests) ·
[`.anthill/principles.md`](../../../../../.anthill/principles.md).

---

## The arc

Sprints 01 and 02 fixed commands that lied about what they did — a truncated
payload, a discarded flag, an unconditional `ok:true`. The user's data survived;
only the account of it was wrong.

**`#73` and `#74` are the first defects here where the data does not survive.**
That is a different severity class, and it is why this sprint leads with them.

---

## Proposed lanes

| lane                        | issue                  | what it is                                                                                                                                                 | evidence standing                                                                |
| --------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **P1a + P1b**               | `#73`, `#74`           | `close` writes live state over the on-disk snapshot unconditionally; respawn+close can destroy a keyed board's snapshot                                    | Sink demonstrated. **One-fix claim NOT demonstrated** — see below                |
| **P1c**                     | `#79`                  | `bounty list` lists boards, not tasks — an empty result reads as "no cards"                                                                                | Reported; code untouched since before the report                                 |
| **P1e** — tracked here only | _re-scoped from `#64`_ | `Bun.serve` is called with no `idleTimeout`, so Bun's 10 s default severs the SSE connection before the 15 s heartbeat                                     | Arithmetic + reproduced at HEAD. **Scope of "never fires" narrowed** — see below |
| **P1f** — tracked here only | _re-scoped from `#64`_ | A dead board is indistinguishable from a quiet one. The terminal `closed` frame reaches only clients connected at that instant; signal paths never emit it | 156 of 224 recorded deaths emitted no `closed` frame                             |
| **P1d** — tracked here only | _no issue, by ruling_  | `bounty add --size <bogus>` returns `ok:true` at exit 0 and discards the size; `update` refuses at exit 2                                                  | Both behaviours run and observed                                                 |
| **P0f-remainder**           | —                      | the remaining in-function `process.exit(` sites, the `die()` family, the SIGINT handlers                                                                   | **Denominator is 35 code sites and KNOWN STALE** — see below                     |
| **The live-team beat**      | —                      | validate the above with real terminal seats rather than isolated subagents                                                                                 | ⚠ **Justification contested by the cold read** — see its section                 |

> ## 🟢 THE RATIFIED CUT — build this, not the table above
>
> **Ruled by Cole 2026-08-08 on `daedalus`'s site-level seam analysis
> ([decisions.md A8](./decisions.md)).** The scaffold's own prediction — _"the
> likeliest correct verdict on this scope is too much"_ — was correct, and this
> is the cut:
>
> | order | lane                                                                                    | seat        | card         |
> | ----- | --------------------------------------------------------------------------------------- | ----------- | ------------ |
> | 1     | **The shrinkage guard** at the sink, rotate once per daemon session, and say it         | `daedalus`  | `t-2e69f932` |
> | 2     | **The teardown funnel** — P1f + the P0f signal slice as ONE edit · **blocked on 1**     | `daedalus`  | `t-1b9424ab` |
> | 3     | **P1e** — `idleTimeout`, XS, disjoint                                                   | `daedalus`  | `t-b1e870a5` |
> | 4     | **P1d** — an audible dropped `--size` (Cole's ruling; NOT the scaffold's P1d)           | `daedalus`  | `t-67a95057` |
> | 5     | **The P0f remediation** over the 37 measured sites, with a gate cell                    | `thoth`     | `t-df17accf` |
> | ∥     | **The re-scoped beat** — mine `daemon.log` + observe this session; destructive half CUT | `cassandra` | `t-a92ea25c` |
> | ∥     | **P1c — SPEC ONLY**, the fix deferred out of the sprint                                 | `cassandra` | `t-991ab386` |
>
> **⛔ The funnel is blocked on the guard by a real blocker edge, not by
> convention.** Routing signals through teardown makes `saveSnapshot` run where
> it does not run today — **on a guardless tree that ships a clobber on the next
> SIGTERM.** That is the `join.ts` scar exactly: `process.exit` was doing double
> duty, and here the double duty is _"die without writing the snapshot."_

**Ordering (original, superseded by the cut above):** P1a/P1b first (highest
severity). P0f-remainder last — it edits exit sites across both `cli.ts` and
`server.ts`, which is where the other lanes also live, so it rebases onto them
rather than the reverse.

⛔ **FALSIFIED — "four lanes converge on two files" is the WRONG GRANULARITY.**
The scaffold asked how four lanes sharing two files avoid each other. **Two
files is a coincidence of where code lives, not a seam.** Measured by the lines
each lane actually edits, **P1e, P1c and P1d are disjoint** — from each other
and from everything else, landable in any order by anyone.

**The real collision is three lanes on ONE 24-line region**, and they do not
merely overlap — **they are the same edit.** The handlers at `server.ts:603-610`
`process.exit` immediately, so `await done` (1293) never resolves and the whole
teardown block is unreachable. That single fact is P1f's defect (1309), two P0f
sites (605, 609), **and** load-bearing for P1a/P1b (1306). **Sequencing them
means three seats rebasing three times over one region; merging them is one edit
to one funnel.** Sizes are in [`decisions.md` A8](./decisions.md).

### P1a/P1b — what is demonstrated, and what is not

**Demonstrated:** `saveSnapshot()` in `bounty/scripts/server.ts` is an
unconditional `writeFileSync` — no emptiness guard, no rotation — called at
teardown. The repo documents this in a comment in `cmdOpen` rather than fixing
it: _"close unconditionally writes the snapshot (server.ts:1286), so an EMPTY
live board flushes empty over a populated snapshot."_

⚠ **Not demonstrated: that one fix closes both.** They share a sink; `#74`
reaches it by a different route, and that route has never been traced or tested
— the audit marked both NOT TESTABLE SAFELY. A guard at the sink might fix `#73`
and leave respawn writing a legitimately-empty board over a good snapshot. Treat
"one lane" as a working hypothesis for the ratify round to confirm, not a
finding.

**Why it is overdue** — the team has designed around it three times: A3 (P0b's
refusal names no corrective verb, because the obvious advice destroys the
snapshot), A4 (_"do not close this board at teardown"_), and sprint 02's
Left-for-Cole (two daemons must survive for the same reason).

⚠ That argues **cost**, not tractability. No lane here is sized, and the
accommodations are described as negligence in one breath and as a sanctioned
standing constraint in the next. Both readings are available; the ratify round
should pick one.

### P1e — the narrower claim the evidence actually supports

`idleTimeout` has never appeared anywhere in the bounty spell; Bun's default is
10 s; the heartbeat interval is 15 000 ms at `server.ts:742`. The severing line
`[Bun.serve]: request timed out after 10 seconds` appears 29 times in
`daemon.log`.

⚠ **The claim is NOT "the keep-alive has never fired."** An earlier draft said
that, and the cold read killed it using this document's own words: if the
reporter's clue is _read-heavy dies / write-heavy survives_, then traffic is
resetting the idle timer, so the 10 s cut is not unconditional. What is
supported: **on an otherwise-idle connection the heartbeat cannot fire, because
the connection is severed 5 s before it is due.**

⚠ **And "explains the clue" overstates.** [Open question 6](#open-questions)
records that whether P1e is cause or coincidence is not answerable — the
reporter cannot be asked. Both statements cannot stand; the honest one is that
**P1e is consistent with the clue and untested against it.**

### P1d — found by us, filed nowhere

```
bun cli.ts add --size ongoing "…"     → {"ok":true,"added":"…"}   exit 0   ← size discarded
bun cli.ts update <id> --size bogus   → exit 2                             ← refuses
```

`add` and `update` disagree about whether a bad `--size` is an error. `update`'s
refusal also omits `--size` from the flags it lists — the flag the caller
passed.

### P0f-remainder — the denominator is the first task

⚠ **Do not inherit a number.** B11 established: 45 grep hits, **35 are code** —
ten are our own sprint-01 remediation comments, textually indistinguishable from
the defect. Sprint 02 fixed five (`tail`). **35 − 5 = 30 is arithmetic, not a
measurement**, and every site we fix increments the count of sites that look
unfixed.

> ⛔ **FALSIFIED, and the direction is the finding: the answer is 37, and the
> count went UP.** `thoth` measured all 37, zero families left `UNVERIFIED`.
> **Sprint 02's fix is invisible to the grep, and in two spells it turned one
> hit into two.** So the subtraction was wrong in both operands and in its sign.
>
> **This is `H-T3` landing exactly where its own author predicted it would** — a
> plausible non-zero over the wrong population, which the zero-guard is silent
> on, found in his own lane. **The denominator was the lane's first task, and it
> was right to be.**

⚠ **The scaffold does not supply a discriminator between a remediation comment
and a live defect.** Producing one is step zero of this lane; without it, an
agent grep-and-fixing will churn its own prior work.

---

## The live-team validation beat

**Ruled in by Cole 2026-08-07.** The intent: everything above was established by
subagents in isolation, and the question is whether that method sees what a real
multi-agent session sees.

> ### ⚠ UNRESOLVED — the cold read did not accept the justification, and it is right
>
> The first draft argued a live team is needed because seats tail for hours,
> hold non-reconnecting consumers, and join and leave at different times.
> **Every one of those reduces to duration, concurrency, or consumer shape — and
> a script supplies all three, more cheaply and more repeatably.** The draft
> then undercut itself by prescribing the script anyway (_"run both consumer
> shapes deliberately"_).
>
> **The success criterion was also close to unfalsifiable.** `#73`/`#74` were
> found by reading code — the audit refused to run them. Re-finding them with a
> live team says nothing about the sensitivity of subagent _testing_.
>
> **What survives, and it is the real hypothesis:** the isolated runs each
> controlled the variable they were studying, and the production failures did
> not happen under controlled conditions. **The claim to test is that some of
> these defects are only reachable under uncontrolled concurrency — real seats,
> real timing, unplanned interleavings — and that our cheapest instrument is
> blind to that class.** That is falsifiable: if a scripted fixture reproduces
> everything the live run does, the live run was unnecessary and we should say
> so.
>
> The ratify round should decide whether that hypothesis justifies the cost, and
> specifically whether it justifies going first. **It is not settled here.**

### Safety — this beat destroys boards on a machine hosting real work

The hazard is the shape of sprint 01's P0e: _the project's own gate destroyed
the live team board twice in forty minutes._ Doing it deliberately is a
controlled experiment only if the isolation is mechanical.

**Required before the first destructive command:**

1. **Prove the redirect took.** Print the resolved `BOUNTY_HOME`, `TMPDIR` and
   the board's snapshot path, and confirm each is under scratch. Do not rely on
   having exported the variables — the `#64` investigation's own probe overwrote
   the machine-global `bounty-latest.json` because it isolated after the first
   surprise rather than before the first command.

   > ⛔ **FALSIFIED AS WRITTEN — "under scratch" is NOT isolation for board
   > IDENTITY.** `sessionKeyToId` scopes the key by `findScopeRoot`, which walks
   > up to the nearest `.git`. **`.anthill/scratch/` is inside this repo, so a
   > board opened from scratch derives the SAME scope hash as the repo root.**
   > Scratch isolates the _files_; it does not isolate the _id_. **Run from a
   > cwd outside the repo entirely, under a private `TMPDIR`, with a key that is
   > not `spellbook`.**
   >
   > **And enumerate the scrub list from the CUT's own `process.env` reads, not
   > from a remembered set** — a set-list cannot notice a variable it never
   > heard of. The full enumeration (including the `.bounty-session` walk-up at
   > precedence level 5, which `convene` itself creates) is in `t-f0d334da`.
   >
   > **The reusable preflight is built and landed at `a5c322a`** — 14 cells,
   > including `cassandra`'s addition: **assert the resolved snapshots dir does
   > not contain `k-spellbook-f4249899.json`.** A path-shape check passes on a
   > correctly-shaped path pointing at the wrong place; **naming the file is the
   > version that cannot.**

2. **Back up first.** Copy the real snapshot directory and `bounty-latest.json`
   outside the blast radius. `#73` is unfixed for the duration of the lane that
   fixes it, and this is a snapshot-destroying experiment.
3. **Prefer a wrapper over discipline.** A preflight that refuses to run when
   `BOUNTY_HOME` resolves outside scratch is worth more than every warning in
   this section. One forgotten flag is total, and the isolation currently rests
   on remembering two env vars plus flag ordering on every invocation.

**Standing constraints:**

- `anthill convene` writes `.bounty-session` at the repo root — `resolveSession`
  level 5 — so convene itself creates the ambient binding this beat must escape.
  Pass an explicit `--session-key` on every test command, and per G1 that key is
  the isolation **only if it precedes any `--`**.
- ⚠ **The write inventory is incomplete.** `close` and `--pin` are known
  writers. Whether `open`, `add`, `update` or daemon shutdown also write to
  shared paths has not been enumerated — establish this before assuming anything
  other than `close` is safe.
- **Do not kill the machine's daemons.** Two must survive: Cole's mind-mapper on
  `:60700`, and the anthill team board — ⚠ which this document cannot yet tell
  you how to identify. Get its port or session key from the lead before running
  anything destructive.
- **Define an abort criterion before starting.** What ends the beat, and what
  makes you stop early.

---

## Not in this sprint

| out                                                             | where it goes                                                                                                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#82`, `#85`–`#88`                                              | [the CLI-contract investigation](../../../../investigations/2026-08-06-spell-cli-contract-investigation.md), Active. It decides what right looks like; a lane comes after |
| `#64` as filed — _"the daemon idle-dies"_                       | [Investigated 2026-08-07](../../../../investigations/2026-08-07-bounty-daemon-idle-death.md). Re-title and re-scope, do not close — P1e and P1f are what it becomes       |
| `#72` (size affordance), `#11` (wordmark), `#75` (bounded tail) | Not this defect family. Backlog                                                                                                                                           |
| A CLI-process harness for glamour · imago · magpie              | Still out of scope; still why 3 of 5 P0f sites are driven rather than pinned                                                                                              |
| The narrower `/cmd` contract (_"did state CHANGE"_)             | Ruled out in sprint 02 (A12), left explicitly unclaimed                                                                                                                   |

⚠ **On `#64`'s falsification, precisely.** Across all 32 `timeout` exits in
`daemon.log`, `subscribers` was 0 — 32 of 32. That exonerates the idle logic
**for the window the log covers.** It does not exonerate it for the reported
deaths, because the instrument post-dates the report by 64 minutes and those
deaths left no record. _The idle framing is falsified as a general mechanism;
the specific reported events remain permanently undiagnosable._

---

## Inherited state

**G1–G8 all bind**, plus sprint 02's amendments. One line each; the full text is
sprint 02's `## Gate law` section, which you should read rather than work from
these summaries.

| gate   | in one line                                                                                        |
| ------ | -------------------------------------------------------------------------------------------------- |
| **G1** | the explicit `--session-key` **is** the isolation — and only if it precedes any `--`               |
| **G2** | a gate must be FALSE pre-fix **and TRUE post-fix**; a label cannot precede its measurement         |
| **G3** | pin board identity out-of-band — the envelope cannot carry it                                      |
| **G4** | enumerate; never write _"for each spell"_ or _"an over-buffer payload"_                            |
| **G5** | every gate positively assigns a private `TMPDIR`                                                   |
| **G6** | a gate driven through `Bun.spawn` **cannot fail** on the drain defect                              |
| **G7** | every drain gate asserts the process **exits** — and its cell works today by accident              |
| **G8** | the vacuity rule: every _"X is not there"_ needs _"and the thing that would have put X there ran"_ |

**Other traps that still apply:**

- `--` eats flags silently at exit 0, including the flag that isolates you. The
  severe form is bounty-only; four spells fall back to a machine-global pointer.
- `strict: true` in `parseArgs` catches unknown flag **names** only, not types.
- The P0f fixture spec is necessary and **not** sufficient — a cell built
  exactly to it passes against the bug.
- G7 carries a 15 s liveness budget that produced a false hang finding under
  concurrent load. Carded, unpatched — and this sprint depends on that
  instrument ([Open question 4](#open-questions)).
- **Announce-then-`ps`.** An announcement is a record, not a lock; two full
  suites ran concurrently twice.
- **Re-run the instrument at the consuming sha.** Broken again on 2026-08-07,
  when a stale _"0 of 6 SKILL.md"_ claim was carried from a draft into sprint
  02's outcome without re-running it; it had been closed in-sprint by `bbc61c2`.
- **Name the owner by measurement, not by the routing that sent you** (B15) — a
  lead's routing is a claim, and it arrives wearing the authority of an
  assignment. One `git log` answers it.
- **A16:** when a comparison is the deliverable, consistency beats cleanliness —
  cleaning the environment first can manufacture the difference you are
  measuring, in the direction that blames the change under test.

---

## Open questions

1. ✅ **Does the close family belong in this project?** Ruled 2026-08-07: **yes,
   it stays** — over a separate `bounty snapshot lifecycle` project, whose cost
   is a second proposal, plan and gate law to keep in sync. Consequence: the
   project's thesis is now two families, honest reporting and durability, and
   the README is amended to match.
2. ✅ **Are P1d–P1f filed as issues?** Ruled 2026-08-07: **no.** An issue
   opened, worked and closed by us in one sprint is bookkeeping wearing
   tracking's clothes. Consequences: this sprint ships fixes that close no
   issue, so the issue count must not stand in for the sprint; and this document
   becomes the only record of P1d–P1f, which makes freezing it carefully at
   close load-bearing in a way the previous two plans were not.
3. ✅ **What does the `#64` investigation say?** Re-scope. P1e and P1f.
4. ✅ **Is G7's 15 s liveness budget in scope?** Ruled 2026-08-08 by
   `cassandra`: **IN SCOPE — and the carded fix is WRONG as written.** _"Raise
   it to 60s/120s and the assertion loses nothing"_ is false: **at 60s it loses
   the assertion on 7 of 7 cells**, measured with a control. **It is a COUPLING
   fix, not a number change** — and raising the budget is safe only _because_
   the reorder in `t-c3060da7` landed. **That sentence travels with the card.**
5. ✅ **What does "finishes it" mean for P0f?** Answered with a **denominator,
   not arithmetic: 37 sites, all read, zero families `UNVERIFIED`.** See the
   falsification above. The remediation lane is `t-df17accf`, and per the
   ratified `H-P1` answer it ships **a gate cell, not a definition** — _if only
   a definition is reachable, say so rather than shipping it and hoping._
6. ⛔ **NOT ANSWERABLE — the reporter cannot be asked.** Whether P1e is cause or
   coincidence turns on what the "host keep-alive tail" was in the reported
   sessions; `#64` was filed by an agent, not by Cole. It can only be settled by
   reconstruction — run both consumer shapes and see which regime produces a
   death resembling the report.
7. ✅ **The ~20-minute figure in `#64`.** Ruled 2026-08-08: **record it as
   permanently unexplained — and it is now a MEASURED terminal state rather than
   a shrug.** `cassandra` measured every idle death in 30 days: **two distinct
   values only, `5s` (n=1, a configured test timeout) and `7200s` (n=31, the
   2-hour default). Zero deaths between 600s and 1800s. Zero anywhere near 20
   minutes.** So the figure matches nothing in the code **and nothing in 226
   recorded deaths across 191 sessions** — which does not explain it, but
   **removes the last place an explanation was plausibly hiding.**

   ⚠ **Carried forward verbatim, not weakened:** the instrument **post-dates
   `#64`'s report by 64 minutes**, so this exonerates the idle logic **for the
   window the log covers** and says nothing about the reported events. `#64`'s
   specific deaths remain undiagnosable.

8. ⛔ **NEW, and it binds the funnel lane: the signal path does not record
   `subscribers`, so the funnel's fix is unverifiable against our only
   longitudinal instrument.** Death classes in `daemon.log`: `ready` (232),
   `close` (38), `timeout` (32) all record `subscribers`; **`signal` (156 — 69%
   of all deaths) records none.** P1f exists to emit the terminal `closed` frame
   on exactly that path, so **after the fix lands there is no recorded quantity
   that changes — the log looks identical before and after.**

   **Ruled: log `subscribers` on the signal path as part of the funnel edit.**
   One field, at a call site the lane is already touching. Without it the funnel
   ships `UNVERIFIED-BY-CONSTRUCTION`.

   ⚠ **And a write-up binding:** _"156 of 224 deaths emitted no `closed` frame"_
   is **correct** (now 156 of **226**), but it is a count of **deaths**, never
   of **affected clients** — and nothing in this log can produce the second
   number. **Do not let the outcome slide from one to the other.** For scale,
   the population the frame has ever reached: **8 of 38 clean closes had
   `subscribers > 0`.**

9. ✅ **Does the live-team beat run inside this sprint?** Ruled 2026-08-07:
   **yes, in the sprint.** It no longer blocks opening lanes. **Still open,
   deliberately: whether it goes FIRST.** The scaffold proposes it does, on the
   grounds that a validation pass which only ever sees the fixed world cannot
   tell you whether the instrument would have caught the broken one — the
   inverted-control problem (G2) raised to the level of a whole method. That
   argument and its cost are the ratify round's to attack; see the beat's ⚠
   UNRESOLVED block.
10. ✅ **Which seats does this sprint need?** Ruled 2026-08-07: **the proposed
    split is fine; `circe` takes no lane.** Correct for the work — every lane is
    daemon, CLI or server, and the one surface-shaped item (`#72`) is out of
    scope. ⚠ **Carried to the structure reflection at finalize, not dropped.**
    This is `circe`'s **fourth consecutive** unseating, and sprint 02's outcome
    already called three _"an argument about where that boundary sits… not
    headcount but shape."_ Four rounds of a seat having no work is a fact about
    the roster rather than about the sprints — and the unseated seat is the one
    that never accumulates the scars that would tell you whether the boundary is
    drawn right. **Record it at finalize; do not let a fourth pass unremarked
    because each round's answer was individually correct.**

---

## Not the agent's to do

- **Cutting the release and pushing.** The agent stages and stops.
- **Convening the team**, and deciding when the live-team beat runs.

_(Filing issues for P1d–P1f was here until 2026-08-07 — ruled out, question 2.)_
