# Sprint 02 — decision log

**Live document. Appended as decisions are made, not reconstructed at the end.**
Started 2026-08-06 at Cole's request, mid-session, so entries before it were
written from the record rather than in the moment — that distinction is marked
per entry.

**What belongs here:** a point where the work could have gone more than one way,
the options that were actually on the table, the path taken, and **who ruled**.
**Options not taken are recorded with their cost**, because a decision log that
only records the winner is indistinguishable from a narrative.

**What does NOT belong here:** corrections and falsifications. Those are
amendments to [`plan.md`](./plan.md) and are listed in §B as pointers only, so
this file does not become a second source of truth for them.

---

## A. Decisions

### A1 — How to open the sprint · **RULED BY COLE** · pre-log, from the record

| option                             | cost                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| ✅ **Targeted ratify, then build** | Bets that only the NEW/REWRITTEN parts need a round                                   |
| Full ratify round first            | Highest confidence; sprint 01 shows it consumes a whole session before any code moves |
| Straight to build                  | Fastest; bets the rewritten P0d/P0f gates are right first time                        |

**Taken:** targeted — each seat ratifies only P0d's replacement gate, P0f's five
cells, and P0b's control, with P0c step 0 running in parallel.

**Outcome so far: vindicated but narrowly.** The targeted ratify found the P0f
lane table wrong on 2 of 5 rows and resolved the UNDETERMINED split — **both
inside the narrowed scope.** It did not touch the ~90% of the plan it skipped,
so this is _not_ evidence the skip was safe.

### A2 — How far the sprint carries · **RULED BY COLE** · pre-log

| option                                | cost                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------- |
| ✅ **All four lanes + release beats** | Largest scope; the release is where this project's own defect class recurs |
| Lanes only, release is sprint 03      | Issues stay open another round                                             |
| Stop after two lanes, reassess        | Buys real data on gate-law cost per lane; delays everything                |

**Taken:** all four plus the release beats. Agent merges to develop and stops;
**Cole cuts and pushes.**

### A3 — P0b's refusal message · **RULED BY COLE** · pre-log

| option                         | cost                                                                   |
| ------------------------------ | ---------------------------------------------------------------------- |
| ✅ **Name no corrective verb** | Least helpful to a stuck user                                          |
| Name the `kill -9` sequence    | Most useful; puts a process-kill in a shipped spell's user-facing copy |
| Point at docs                  | Keeps `kill -9` out of the terminal; costs a doc round-trip            |

**Taken:** no corrective verb. **The reason is data loss, not tone:**
`--fresh --restore` — the obvious helpful suggestion — **destroys the
snapshot**, because `close` flushes the empty live board over it (#73). A user
in the exact situation the message is written for would follow it and lose their
only copy.

**Marked not reopenable at implementation time**, and daedalus confirmed he did
not reopen it.

### A4 — The 22-task board found empty at convene · **RULED BY PROSPERO** · pre-log

`anthill convene` warned the live board was empty over a 22-task snapshot and
that closing it would overwrite the snapshot permanently.

| option                         | cost                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------- |
| ✅ **Back up, do NOT restore** | Board starts clean; the 22 exist only in the `.bak`                           |
| Restore the 22 onto the board  | Seeds stale sprint-01 cards beside sprint-02 lanes → claim-by-title-adjacency |
| Do nothing                     | Leaves a live board one `close` away from destroying the snapshot             |

**Taken:** backed up first
(`~/.bounty/snapshots/k-spellbook-f4249899.PRE-SPRINT02-CONVENE.bak.json`,
`cp -p`, byte-identical at 16884), **then** read the 22, **then** ruled.

**The ruling in one line: the data was preserved; the knowledge was never on the
board.** 17 of 22 were `done` and permanently recorded in `outcome.md`; of the 5
`todo`, three _are_ sprint 02's lanes restated far better in the plan, and two
are explicitly out of sprint scope.

**Standing constraint: do not close this board at teardown.**

### A5 — Where gate hygiene lives · **REAFFIRMED, inherited ruling** · pre-log

Sprint 01 tried putting G5's scrub in `.anthill/config.json`'s gate string and
**reverted it**. Sprint 02 reaffirmed the revert.

**Not taken, and why:** a config-level scrub **hides a harness regression from
every seat at once** — the pointer defect could return and every suite in the
repo would stay green.

**But the brief was wrong anyway**, and thoth caught it: #295 instructed _"post
your gate baseline"_ while carrying **none** of the gate law, and **n=2 seats
ran the raw string** — one with `BOUNTY_SESSION_KEY=spellbook` live in his
shell. **Fix: the two flags inline in the brief, not a pointer to the law.** The
distance between an instruction and its precondition is the interval in which
the instruction gets obeyed.

### A6 — `--pin` passed together with a lost-effect flag · **RULED BY PROSPERO**

daedalus had implemented **all-or-nothing** (a refusal withholds the pin).

| option                     | cost                                                                  |
| -------------------------- | --------------------------------------------------------------------- |
| ✅ **Honour what you can** | Two outcomes from one invocation; needs saying out loud in the source |
| All-or-nothing             | Makes one flag's outcome depend on an unrelated flag                  |

**Taken:** write the pin (really honoured), refuse about `--restore` (effect
lost), exit 2.

**daedalus's own diagnosis of his original, which is the durable half:** he had
imported **a transaction rule into something that is not a transaction**. It is
the plan's over-inclusive error **spelled as a side effect instead of an exit
code**, which is why it did not look like the thing the plan warns about.

**⚠ My hazard was right about the mechanism and WRONG about the instance.** I
claimed it broke `open --session-key K --pin --no-open`, the seat rejoin. That
invocation carries no lost-effect flag and was never at risk. The genuinely
affected one was `--pin --restore`. **Recorded because a warning that is right
about the mechanism and wrong about the example still reads as fully correct —
and a reader who checks the example and finds it safe may discard the mechanism
with it.**

### A7 — Who audits cassandra's gate cells (H7) · **RULED BY PROSPERO**

She offered: daedalus runs her cells, since he builds against them.

| option                   | cost                                                                           |
| ------------------------ | ------------------------------------------------------------------------------ |
| ✅ **Split by job type** | Two people instead of one                                                      |
| daedalus runs all of it  | He reads a gate for _what it demands of my code_ — the frame it was written in |
| thoth runs all of it     | He is the proven frame-mismatch, but on the critical path with step 0          |

**Taken:** **the decoration check is mechanical and incentive-proof** (restore
the bug, confirm the cell goes red) → daedalus, inside the lane. **The judgement
audit** (_can this cell's instrument see the failure it is aimed at?_) → thoth,
queued behind step 0.

**Rejected as a remedy:** cassandra's _"I will check whether I am running the
uncorrected version."_ She said herself why — awareness is the thing that
failed. **Those two jobs are instruments; that sentence is a resolution.**

### A8 — P0f build order · **RULED BY PROSPERO**, on cassandra's finding

**Taken: build bounty FIRST, then lift its shape to astrolabe.**

`bounty/scripts/server.test.ts` already holds **both** halves — the G6-correct
`sh -c "… | cat"` construction (`:2824`), a `tail` subprocess harness
(`:1741`/`:1780`/`:1840`), and a termination test (`:1733`). **The bounty cell
is a composition of two patterns already in that file, not new harness work.**

**And astrolabe is not what the plan thought:** its harness is
`Bun.spawn({stdout:"pipe"})` — **pinnable for the termination cell, useless for
the drain cells**, per G6. It must be rewritten, not reused.

### A9 — `glamour/cli.ts --restore` has no correct type · **RULED BY COLE**

The sprint's first genuine design blocker. Boolean in `style archive` (`:254`),
string in the `open` daemon spawn (`:317`), **both published in `SKILL.md`**
(`:180` and `:167`), and `parseArgs` takes one `options` map per entry point.

| option                                          | cost                                                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| ✅ **Rename `style archive`'s → `--unarchive`** | A documented flag on a shipped spell changes spelling                                                          |
| Drop `glamour/cli.ts` from P0c this sprint      | No user-facing change now; **a known-broken parser ships and thoth's ward slips too** (it cannot claim 16/16)  |
| Rename `open`'s instead                         | Breaks house consistency with bounty/imago/magpie **and** `glamour/server.ts`; hits the more load-bearing verb |

**Taken:** rename the boolean one. `restore: {type:"string"}` ·
`unarchive: {type:"boolean"}` · `:254` becomes `archived: !flags.unarchive`.

**Why:** `--restore <id>` is the house-wide spelling across five entry points;
`style archive` is the sole outlier; `--unarchive` names the inverse of archive
better than `--restore` does; and it **kills a live bug by construction** —
today `flags.restore !== true` means `glamour style archive <id> --restore foo`
**archives instead of restoring, exit 0, no signal.**

**`glamour/SKILL.md:180` updates in the same change.**

---

### A10 — Promoting the label-timing rule into G2 · **RULED BY PROSPERO**, narrowed by `cassandra`

I proposed promoting daedalus's line — _a label is a claim about a measurement,
so it cannot be assigned before the measurement is taken_ — **on the stated
grounds that two seats in opposite roles had hit it independently.** I asked
cassandra to falsify it.

| option                                              | cost                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------- |
| ✅ **Promote WITH the expiry clause + enforcement** | Longer rule; needs a two-arm run before any label exists              |
| Promote as I first worded it                        | **Catches cassandra's instance and MISSES daedalus's** — see below    |
| Hold for a third instance                           | Two instances already shipped; a third costs another mislabelled gate |

**She could not falsify it and instead did something more useful — narrowed it,
and killed my justification for it.**

**My "two independent seats" claim was FALSE.** She had read daedalus's report
of the defect, **including his mechanism**, forty minutes before committing the
same class herself. **Not two independent discoveries — one report, and a second
seat committing it anyway having read it.**

**That is a stronger argument for promotion, not a weaker one:** a fresh,
explicit, peer-delivered, _written_ warning did not prevent it. Which is exactly
why the remedy must be **a mechanical gate rather than awareness**.

**And the two instances are different sub-mechanisms** — his was a correctly
labelled cell whose class was changed by a later edit; hers was a label never
derived from a pre-fix run at all. **My wording caught only hers.** The expiry
clause is what catches his.

**Landed wording, with its enforcement and its falsifier, in `plan.md` under
G2.** Countable metric: _cells that CHANGED label when arm 2 ran_. First
datapoint: **1 of 9.**

### A11 — G7's reachability · **RULED BY PROSPERO**, found by `thoth`'s H7 audit

**Both remedies, not one.** `thoth` preferred (1) and would take both; I ruled
both required, and the card (`t-c3060da7`) carries them.

| option                                                | cost                                                      |
| ----------------------------------------------------- | --------------------------------------------------------- |
| ✅ **Reorder the awaits AND add a precondition cell** | Two changes instead of one                                |
| Reorder only                                          | Leaves the next harness author to rediscover the coupling |
| Precondition cell only                                | Leaves the harness able to hang                           |

**The finding:** the G7 termination cell **cannot report the hang it exists
for.** It reads both pipes to completion before awaiting exit, so its assertion
sits downstream of an EOF that a detached grandchild can withhold forever. Under
a one-word change it does not go **red** — it becomes **unreachable**, and the
failure mode degrades from _"a red cell naming the hung verb"_ to _"a slow
suite."_

**It works today only by accident:** bounty's daemon holds none of the harness's
handles, a property documented as being about **#64 crash capture** and
load-bearing for G7 **as a side effect**, asserted nowhere.

**Blast radius deliberately left UNVERIFIED and NOT grepped** — four other
harness files share the primitives, but `Promise.all` near a spawn is a shape,
not a diagnosis. **Enumerate by call site; one file-open each.**

### A12 — What `/cmd`'s verdict MEANS · **RULED BY PROSPERO**, proposed by `daedalus`

P0d makes `/cmd` return a verdict. **Which verdict** was an open choice, and
daedalus stated it rather than defaulting it.

| option                           | cost                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅ **"was the type RECOGNISED"** | A real gap remains: a recognised type that silently does nothing still reports `ok`                                                               |
| "did state CHANGE"               | **Breaks working callers** — these handlers are full of guarded branches that legitimately do nothing; **~38 per-site judgements in imago alone** |

**Taken:** recognised. **The narrower contract is ruled OUT of this sprint and
left explicitly UNCLAIMED** (card `t-d7a3fa14`).

**Two reasons, and the second is mine:** reporting legitimate no-ops as failures
is **P0b's over-inclusive error in a new spelling** — twice in one session, in
two costumes. And _"did state change"_ is a **NEW CONTRACT, not a defect against
an existing one**: #83 and #84 are defects, this is a feature. **~38 per-site
judgements each able to break a caller is the exact bulk shape that cost 28
tests the same hour.**

**The judgement worth repeating: leaving a real gap named and unclaimed beats
half-doing it.**

### A13 — Where glamour's verdict comes from · **DECIDED BY `daedalus`**, ratified

| option                                          | cost                                                                                                                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅ **`applyAgentMsg` (the reducer) returns it** | Crosses a seat boundary — engine logic in a surface-owned file                                                                                           |
| A recognised-set list beside the switch         | **A hand-kept mirror of a case list**, the drift bug this repo has shipped **twice** (the bounty surface mirror; `propose-node --stdin` dropping `tags`) |

**Ratified**, and the anti-mirror reasoning is the durable half — it will
otherwise be re-litigated by whoever next wants a list beside a switch.

**Consequences, both recorded rather than absorbed:**

1. **It is a SEAM** — `glamour/surface/state/reduce.ts` →
   `glamour/scripts/server.ts`'s `/cmd` route. **daedalus writes the `seams.md`
   entry**, noting that circe (its normal owner) is unseated.
2. **P0d's gate coverage STOPS AT IT.** The three `/cmd` cells assert the
   **route's** answer; the verdict now crosses a boundary **none of them
   observes.** Cells valid, coverage bounded — **stated in the verdict, not
   discovered later.**

**For the structure reflection, not for now:** a P0d fix that could not be made
without touching a surface reducer is an argument about where that boundary sits
— and it is the **third consecutive round** circe has been unseated.

### A14 — Gates before P0c, and who writes which · **RULED BY PROSPERO**, argued by `daedalus`

P0f's five sites were fixed but only **1 of 5 gated**. P0c is the integration
lane that reshapes `main()` and invalidates edit sites across everything landed.

| option                                          | cost                                                                                                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅ **Gates first, split across two seats**      | Delays the largest lane; the sprint's remaining time goes to verification rather than new code                                               |
| Open P0c now, gate P0f after                    | **P0c rebases onto four sites whose only evidence is "the shape is proven elsewhere"** — the exact substitution this sprint exists to refuse |
| Build harnesses for all three driven-only sites | **Explicitly OUT of sprint scope**; it is why 4 of sprint 01's 9 were driven, not pinned                                                     |

**daedalus's argument, ratified verbatim:** _"P0c rebases onto these lanes and a
lane whose gate was never written cannot tell anyone whether P0c broke it."_ The
plan already says P0c's gate **re-runs theirs** — a gate that does not exist
cannot be re-run.

**Target is `2 pinned · 3 driven`, stated as the honest maximum inside scope**,
not as a shortfall. **Split to parallelise:** daedalus writes astrolabe's cell
fresh (never adapting its `Bun.spawn` harness, which G6 says cannot fail) plus
the G7 reachability fix first; **cassandra records the three drives**, since
driving an assembled spell is her seat's scope **and she is the arm daedalus
cannot supply — he wrote the fix.**

---

## B. Corrections and falsifications — pointers only

**These are not decisions and their single source of truth is
[`plan.md`](./plan.md).** Listed so the review has an index.

| #   | what was wrong                                                                      | found by    | landed              |
| --- | ----------------------------------------------------------------------------------- | ----------- | ------------------- |
| B1  | P0f filed under H5 (instrument class); it is the **recognition** class              | `daedalus`  | plan + `t-fc623be2` |
| B2  | Session anchor published **on the channel it bounds**                               | `cassandra` | conceded, #300      |
| B3  | G5 repeal criterion phrased as a **directory** property; it is a **suite** property | `thoth`     | plan                |
| B4  | The convene brief instructed a gate and carried **none of its law**                 | `thoth`     | brief, #304         |
| B5  | P0f write spelling: **3 of 5 are bare**, not 1                                      | `cassandra` | plan                |
| B6  | UNDETERMINED split resolved → **2 pinnable · 3 driven-only · 0 undetermined**       | `cassandra` | plan                |
| B7  | `PINNABLE` **flattens two capabilities**; ask per capability                        | `cassandra` | plan, into G6       |
| B8  | **`--pin` is a WRITE route to the wrong board**; G1 enumerated only reads           | `daedalus`  | plan, into G1       |
| B9  | A **RED cell was wearing a BLAST-RADIUS label** in daedalus's own gate              | `daedalus`  | his lane            |
| B10 | Flag count **112 vs 118**; and "169 sites" is **lines**, not reads (249)            | `thoth`     | plan                |
| B11 | **45 exit sites are grep hits; 35 are code** — ten are our own remediation comments | `daedalus`  | plan                |

| B12 | **G7's cell cannot report the hang it exists for** — under a one-word
change it goes UNREACHABLE, not red | `thoth` | plan, into G7 | | B13 |
**`glamour` has the G7 hazard LIVE in source** (`["ignore","pipe","inherit"]`),
latent only because its suite never spawns | `thoth` | plan, into G7 | | B14 |
**The G2 promotion's justification was FALSE** — "two independent seats" was not
independent | `cassandra` | plan, into G2 | | B15 | **The audit was routed at
the wrong owner, by the lead** — see below | `thoth` | **this file** |

**B15 is recorded here rather than in `plan.md` because it is a coordination
error, not a plan defect.** I queued thoth _"the judgement audit of cassandra's
cells"_ before anyone had established whose the cells were — they were
daedalus's. thoth verified the artifact scrupulously and **inherited the one
fact he had been handed.**

**His lesson: _name the owner by measurement, not by the routing that sent you._
Mine is the sibling: a lead's routing is a CLAIM, and it arrives wearing the
authority of an assignment.** One `git log` answers it; neither of us ran it.

**What made a wrong arrow survivable was the SOP's other rule** — daedalus read
on topic rather than on address.

**B11 is the one worth reading twice: it INVERTS the other denominator rows.**
The first five recorded _misses_; this is a false **positive**, where sprint
01's remediation comment is textually indistinguishable from the defect it
documents — so **every site we fix increments the count of sites that look
unfixed.**

---

## C. Open, unresolved

- **`snapshotBackedUp` and `hydrated`** — zero code hits. **Zero hits means zero
  opportunities to diverge, not a pass.** Land in P1, plausibly another session.
- **Candidate issues for Cole**, reported and deliberately not fixed:
  `glamour style archive --restore foo` archives (dissolved by A9, but the
  filing is still Cole's).
- **Whether glamour / imago / magpie can be closed by DRIVE at acceptable cost**
  — established only that no CLI-process harness exists in any of the three.
- ~~**A label-timing amendment to G2**~~ — **RESOLVED and landed** (see A10).
  The second instance arrived from `cassandra` before P0d, from the opposite
  role.
- **⏳ HELD FOR THE RETRO, deliberately not promoted: the artifact-decay rule as
  a team PRINCIPLE.** It is standing law in `plan.md` for this sprint — a
  gate-law act. **Promoting it to `principles.md` is a different act and the SOP
  forbids doing it mid-session:** _never add one mid-session; the pressure to
  generalise peaks exactly when you have just been burned._ **`thoth` called
  this and he was right — I was drifting toward promoting it.** Retro Q3, with
  its scar, and **`cassandra` owns it** since the instant-axis/time-axis cut is
  hers.
- **📊 For the retro, with a COUNT rather than as anecdotes: ~8 instrument
  failures across 4 seats in one session, all ONE SHAPE** — a **lexical**
  instrument standing in for a **structural** question. An awk range that
  over-ran; an `indexOf` reading the first of 36 maps; a `sed` window that
  displayed the counterexample without it firing; a narrowing blind to
  `parse*(flags.x)`; a `] *=` matching `===`; a guessed line range spanning two
  functions; an `endswith` blind to trailing comments; a routing claim made from
  memory. **The denominator table records what a count was wrong ABOUT; this
  records why the instrument COULD NOT SEE it.**
- **The best single sentence the session produced, `thoth`'s, and it belongs
  wherever the decay rule lands:** _"A published absence claim has no listener.
  Reading a fact does not propagate it to the claims you have already
  published."_ He read the counterexample to his own published claim, in a `sed`
  window, in a different investigation, **forty minutes after publishing it**,
  and it did not fire. **That is why the remedy is a mechanical re-run and not
  care.**
