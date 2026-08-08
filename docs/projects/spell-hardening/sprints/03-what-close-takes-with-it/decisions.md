# Sprint 03 — decision log

**Live document. Appended as decisions are made, not reconstructed at the end.**
Started 2026-08-07 at the convene, so unlike sprint 02's log there are no
pre-log entries — every entry below was written while the decision was warm.

**What belongs here:** a point where the work could have gone more than one way,
the options that were actually on the table, the path taken, and **who ruled**.
**Options not taken are recorded with their cost**, because a decision log that
only records the winner is indistinguishable from a narrative.

**What does NOT belong here:** corrections and falsifications. Those are
amendments to [`plan.md`](./plan.md) and are listed in §B as pointers only, so
this file does not become a second source of truth for them.

> ⛔ **LINE NUMBERS IN THIS DOCUMENT ARE PINNED TO `003af0d` AND MOST OF THEM
> HAVE ROTTED. Anchor on the SYMBOL NAMES, not the numbers.** Six commits landed
> after these entries were written and the files moved under them — measured at
> finalize: the signal handlers cited as `server.ts:603-610` are now at 690-691;
> the refusal comment cited as `cli.ts:525-533` is at 594; `parseSize` cited at
> 259-261 is at 262.
>
> **The numbers are left as written rather than renumbered, deliberately.**
> Renumbering would make them correct until the next commit and wrong silently
> after — **the same trap one lap later.** `daedalus` hit this inside a single
> session on his own preflight header (`cli.ts:590` → 648, `server.ts:1206`
> → 1411) and stripped every pin from it: **symbol names survive an edit; a line
> number is a claim about a file's shape at one instant.**

---

## A. Decisions

### A1 — How the session opens · **RULED BY COLE** · at convene

| option                                      | cost                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| ✅ **Ratify round first, empowered to cut** | Consumes session time before any code moves; sprint 01 spent a whole session this way                               |
| Ratify only — stop at a buildable plan      | Cleanest handoff, but costs an extra convene/finalize cycle                                                         |
| Skip ratify, build `#73`/`#74` immediately  | Fastest at the severest lane; bets the one-fix-closes-both claim is right, which the scaffold marked UNDEMONSTRATED |

**Taken:** full ratify round, explicitly empowered to cut scope.

**Outcome: vindicated, and not narrowly.** The round killed the predicate every
lane was about to be built on ([A5](#a5)), falsified two scaffold lane claims
outright ([§B](#b-corrections-and-falsifications)), and returned a scope cut its
own author called _"yes, and this is the cut."_ **Building first would have
shipped a guard that does not guard.**

### A2 — Seats: circe's fourth consecutive unseating · **RULED BY COLE** · at convene

| option                               | cost                                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| ✅ **Redraw the boundary now**       | Decided without the affected seat in the room — the exact failure the unseating produces                             |
| Leave unseated, record at finalize   | What the scaffold's open question 9 ruled; each round individually correct, which is how four passed unremarked      |
| Re-scope circe to measurement design | sprint 02 found measurement design was the missing lens with no owner; thoth declined to propose a fifth seat for it |

**Taken:** `daedalus` owns the command-verdict path **wherever it physically
lives**, including a surface reducer that owns a `/cmd` case list (seams
Contract 13). `circe` keeps the files; rendering, layout, theming and tokens did
not move.

**Why now rather than at finalize:** sprint 02's retro asked for this decision
at _this_ convene, because the drift had become load-bearing — `daedalus` had to
edit `glamour/surface/state/reduce.ts` and annotate why she was absent, and
`thoth` named it: **_"the engine seat writes surface contracts and apologises in
the entry" is a convention forming by default._**

**Landed `539334b`, in all four places the scope is written** — config, the
roster table, and both seat headers — in one commit, because a scope clause
corrected in one place and left stale in another sends the next seat to the
wrong boundary. **Both seat docs carry the ruling in prose, and circe's says
plainly that it was decided without her and invites the argument.**

### A3 — Seat mode: terminal seats vs subagents · **RULED BY COLE** · at convene

| option                       | cost                                                                        |
| ---------------------------- | --------------------------------------------------------------------------- |
| ✅ **Terminal seats (tmux)** | Heavier on the machine; real concurrency and real timing                    |
| Subagents                    | Cheaper and quieter, but the live-team beat becomes unrunnable as specified |

**Taken:** terminal seats. **Note the interaction with [A7](#a7): the beat that
justified this choice was subsequently cut down**, so the justification did not
survive the session. The choice still paid, for a reason nobody predicted —
**the uncontrolled-concurrency findings came from the seats simply working**,
not from a designed experiment.

### A4 — What to do about `#73` firing on our own board · **RULED BY PROSPERO** · at convene

`anthill convene` returned
`POSSIBLE BOARD LOSS: saved snapshot holds 18 task(s), live board shows 0`.

| option                                         | cost                                                                                                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅ **Backup, then restore from the backup id** | Two extra steps before any work                                                                                                                                  |
| `--fresh --restore` on the live key            | **MEASURED to destroy the only copy** — `cli.ts:525-533`. `--fresh` closes the empty board, close flushes empty over the snapshot, restore then reads the corpse |
| Start clean, abandon the 18 cards              | Loses five live `todo` cards, two of which sprint 03 depends on (`t-defc47e3`, `t-2df67738`)                                                                     |

**Taken:** full snapshots dir copied to scratch → good snapshot copied to
`k-spellbook-f4249899.PRE-SPRINT03-CONVENE.bak` → board restored **from that
id**.

**Lead error on the record:** the board **id** was first passed where a session
**key** was wanted, spawning a stray board. Key `spellbook` derives id
`k-spellbook-f4249899`; passing the id derives `k-k-spellbook-…`. Nothing lost,
stray closed. **A derivation reasoned about instead of run.**

### A5 — The guard's PREDICATE: emptiness vs shrinkage · **RULED BY PROSPERO on daedalus's measurement**

<a name="a5"></a>

| option                                                               | cost                                                                                                       |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| ✅ **Shrinkage**                                                     | Guards a write path that currently always succeeds; larger blast radius than either issue asked for        |
| Emptiness (what both issues, the scaffold, and the lead all assumed) | **MEASURED DEAD** — one `add`, no `close`, took a snapshot 3 → 1 tasks. Silent on that, because 1 is not 0 |

**Taken:** shrinkage. **The emptiness predicate was killed by a third route into
the sink that no issue names** — the debounced flush at `server.ts:1257-1262`,
which writes ~1s after _any_ mutation with no `close` involved.

**Found twice, by two methods, independently:** `daedalus` traced
`emitEvent → snapDirty → snapTimer → saveSnapshot` in source; `cassandra`
watched the artifact change on disk in response to a legitimate act and stop
when the acts stopped. **Neither re-ran the other's instrument.**

**And it was live on our own board:** for ~2 minutes between convene and the
restore, the live board sat at 0 over a populated 18-task snapshot. **One
`bounty add` in that window takes it to 1, and the guard everyone was about to
build would have permitted it.** Nobody added a card — luck, not design.

### A6 — The guard's RESPONSE: refuse, rotate-per-write, or rotate-per-session · **RULED BY PROSPERO, then FALSIFIED by daedalus, then re-ruled**

| option                                | cost                                                                                                                                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅ **Rotate once per daemon SESSION** | Captures the state before this daemon touched it; **needs no retention policy at all**                                                                                                                    |
| Rotate per write _(first ruling)_     | **FALSIFIED** — writes are per mutation, so draining a 26-card board makes 26 rotations, and any retention bound `N` evicts the pre-drain snapshot by rotation `N+1`. **The guard eats what it protects** |
| Refuse the write                      | Changes a path that always succeeds; inherits A3-of-sprint-02's unsolved problem — the refusal names no corrective verb                                                                                   |

**Taken:** rotate once per boot, **and say so**. A silent rotation is a
success-shaped lie in a project named after them; once-per-session makes the
announcement cheap and legible — one line, once, naming the file.

**Two things this dissolved rather than answered:** the disk-cost question that
was queued for Cole (no retention policy needed), and the question of whether
`snapshotBackedUp` still fits (it does — only the trigger's rate moved).

### A7 — The live-team beat · **RULED BY CASSANDRA, accepted by PROSPERO**

<a name="a7"></a>

| option                                   | cost                                                                                                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅ **Keep it, CUT the destructive half** | Forfeits a confidence signal; keeps the information at near-zero cost                                                                                                |
| Run it first, destructively              | The scaffold's own proposal. **Runs the experimental arm before the control** — daedalus's cells _are_ the scripted-fixture control arm of the beat's own hypothesis |
| Drop it entirely                         | Loses the `daemon.log` mining, which is 191 sessions and 30 days already collected                                                                                   |

**Taken:** re-scoped to (1) mining `daemon.log`, (2) an observation protocol
over **this** session — already a real multi-agent run doing destructive work
under uncontrolled concurrency. **Runs alongside the lanes.** Answers scaffold
open question 8.

⚠ **The ruling's own strongest objection is carried, not resolved:** it rules on
**reachability**, which is what the hypothesis asks. **If the real question is
DISCOVERY, the beat is worth more than this prices it** — nobody would have
written the `--as-of` crossing test. **Left open for Cole:** wanting the
destructive run for _confidence_ rather than _information_ is a legitimate
reason this ruling does not touch.

### A8 — The scope cut · **RULED BY COLE on daedalus's site-level analysis**

| option                          | cost                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------ |
| ✅ **Take the cut as proposed** | Drops P1d as filed and demotes P1c to a drive                                  |
| Cut further — drop the beat too | Saves the most expensive item; forfeits the blind-instrument answer            |
| Keep P1c as a fix lane          | Would build on a mechanism `daedalus` showed is not the empty-result behaviour |

**Taken:** guard → funnel → P1e → the P0f remainder → the re-scoped beat.

**The seam framing was the lead's and it was wrong.** The plan asked how _four
lanes sharing two files_ avoid each other. **Two files is a coincidence of where
code lives.** Measured by site, P1e/P1c/P1d are **disjoint from each other and
from everything else**; the real collision is **three lanes on one 24-line
region**, and they are not overlapping edits but **the same edit** — the
handlers at `server.ts:603-610` `process.exit` immediately, so `await done`
never resolves and both `1306` and `1309` are unreachable. **Merged into one
funnel, one seat, one land — guard first.**

### A9 — P1d · **RULED BY COLE**

| option                                     | cost                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| ✅ **Keep the leniency, make it AUDIBLE**  | Adds a field; no change to success semantics                                                                 |
| Reverse it — bad `--size` becomes an error | Consistent with the sprint's thesis; **re-opens the typo hazard the original ruling was written to prevent** |
| Leave it entirely                          | Costs nothing now; leaves a verb reporting success while discarding what you passed it                       |

**Taken:** the drop stays; the envelope says it dropped. Same family as
`restoreSkipped` — honour what you can, say what you did not.

**Note this is a different, smaller thing than the scaffold's P1d, which is
falsified** — see [§B3](#b).

### A10 — The tmpdir-leak thread · **SCOPE CALL BY CASSANDRA, ruled by PROSPERO**

**Parked, not dropped** (`t-0484455a`). Nine messages across three seats
produced real findings about a **different product** while `doing: 0` and no
lane card existed. **The seat who opened the thread is the one who called it.**

**Findings preserved:** 856 leaked dirs house-wide · glamour 790 · bounty 66 ·
**magpie ZERO, the control that proves the fix** · 951 `glamour-styles-*`
invisible to the ratified `tmpdir()` predicate **by design** · `TEST_TMPDIR` has
no teardown · **anthill's own tooling at 9,001 — 4× all of spellbook combined.**

**Routing:** ours → `docs/backlog/`, not GitHub issues (those are inbound from
other teams). The anthill figure is the lead's outward send via
`anthill feedback`.

---

## B. Corrections and falsifications

<a name="b"></a>

Pointers only — the amendments live in [`plan.md`](./plan.md).

- **B1 — the plan's base sha was stale.** Header said `e582150`; the branch cut
  at `003af0d`, two commits ahead, **and both were the plan's own rulings.**
- **B2 — the plan's safety §1 is FALSE as written.** _"Confirm each is under
  scratch"_ does not isolate **board identity**: `sessionKeyToId` scopes by
  `findScopeRoot`, which walks to the nearest `.git`, and `.anthill/scratch/` is
  inside this repo — so a board opened from scratch derives **the same scope
  hash as the repo root.** Scratch isolates the files, not the id.
- **B3 — P1d's stated mechanism is falsified.** `add` and `update` are
  byte-identical; `parseSize` drops silently **by documented intent**
  (`cli.ts:259-261`), and `update`'s exit 2 is the **empty-patch guard** firing,
  not a size refusal. The scaffold's _"two verbs disagree"_ is an artifact of a
  one-flag test case.
- **B4 — P1c's stated symptom is falsified.** `cmdList` prints
  `no running boards` on the empty set. The real defect is **house-wide and
  sharper**: three spells report a **failed read** and a **legitimate empty
  result** with the identical sentence at exit 0, while two others already carry
  the good shape.
- **B5 — `35 − 5 = 30` is falsified. Measured 37, and the count went UP** —
  sprint 02's fix is invisible to the grep and turned one hit into two in two
  spells.
- **B6 — two of the plan's counts have decayed under the sprint's own
  sessions:** `29` timeouts → **30**, `224` deaths → **226**, both attributable
  to tonight. **Re-derive at the consuming sha; do not carry either.**

---

## C. Hypotheses under test (from sprint 02's retro)

| id     | status at time of writing                                                                                                                                                                                                                                                       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `H-P2` | ⛔ **FALSIFIED, by the lead.** Baseline was ZERO blocked-time across sprint 02; this session reached **two of three seats idle simultaneously** while the lead was in a long human round-trip. Three seats then spent five messages diagnosing the absence.                     |
| `H-T1` | **3 lapses, all the lead's, all inside `convene`** — the anchor published inside the message it bounds, the gate run after the commit, and rotate-per-write ruled without asking what makes it un-skippable. **Zero from any seat in ordinary work: the falsifier is holding.** |
| `H-T3` | ✅ **Landed exactly where its author predicted, in his own lane** — `35 − 5 = 30` is a plausible non-zero over the wrong population, and the zero-guard is silent on it.                                                                                                        |
| `H-P1` | **Answered better by a seat than by its author.** daedalus: _"a preflight script is skippable by construction; the un-skippable form is a CELL INSIDE THE GATE that fails the suite when the resolution is wrong."_ Ratified and applied to thoth's discriminator.              |
| `H-T2` | Not yet exercised.                                                                                                                                                                                                                                                              |
