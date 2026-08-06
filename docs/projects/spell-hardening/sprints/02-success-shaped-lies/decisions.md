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
- **A label-timing amendment to G2** — daedalus's _"a label is a claim about a
  measurement, so it cannot be assigned before the measurement is taken."_ Held
  pending one more instance; **P0d will supply or deny it.**
