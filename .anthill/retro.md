# Retro — 2026-08-31 · spell-kit sprint 01, "the seam before the move"

**Team:** default · **shape:** `cdf9d466`
**Seats:** prospero (lead) · daedalus (engine) · circe (surface) · thoth (grimoire) · cassandra (verify) — subagent mode, all five seated, first session with the full roster in it.
**Shape of the work:** 10 commits on `feat/spell-kit-sprint-01`. Phase 0 + 1a/1b/1c. Two spells relocated and shipping source-free with committed `dist/`; three import-boundary wards; blind set gained a second root. Gate 1481/0 → **1510/0**. `bunx tsc` **434 → 433** — the sprint ended below the baseline it started from, having added two relocations, three wards, an instrument root and two release-serve gates.

## Q1 — What went well (artifacts first)

- **Every one of the sprint's five stated proofs HELD**, verified at HEAD rather than reported: blind set 19 / 4,442 across two roots (through *two* relocations), 13 ward cells / 0 fail, both spells serving `dist/` deps-free and **driven in a browser**, imago's daemon 5 → 1 surface imports, mind-mapper 0 tsc errors.
- **The `shared/` split was proven BY EFFECT, which is the project's actual thesis.** An identical 2000×1500 source through both consumers — daemon 1200×900 / 2,410 B, browser 1200×900 / 2,908 B. Same dimensions from both sides; byte sizes differ because the encoders do. **No arm of the gate can make that claim.**
- **1a was free AND it priced the seam.** Zero seam work, exactly as R7 required — and the copying it forced was measured rather than argued: 42 lines of engine byte-identical modulo the spell name, plus a 46%-copied gate. Sprint 02 inherits a number instead of a debate.
- **Neutrality was proved, not inferred.** Both relocations returned tsc to a measured baseline, and the second was checked by a **detached worktree at the pre-move commit diffed by error LINES** — 383 tuples identical. The count coming back was explicitly refused as evidence, and correctly: 452 → 512 → 452 was **78 errors leaving and 18 arriving**, not 60 breaking and 60 healing.
- **A guard that had become a countdown was replaced with membership** and calibrated by *simulating the remaining relocation and requiring green* — the cell the old floor failed twice.

### ⛔ The anti-consensus answer, because a unanimous Q1 is a smell

**What would have had to happen for anyone to notice the sprint going badly?** Almost nothing, and that is the finding. **The gate was green at every single checkpoint, including at the moments things were most broken** — a wrong `import type` specifier passes build, biome and the suite; a vacuous refusal cell passes its own mutation; a 288KB inert stylesheet outscores the working one on every count-shaped measure. **Nine of the ten defects this sprint found were invisible to `bun run check && bun test`.** The gate is not what caught this sprint's problems and a retro that credits it is mis-reading its own evidence.

## Q2 — What did not go well

### The lead — and per H26 I withheld my list until all four seats had reported

- **Three wrong numbers, all mine, all the same line-shaped mechanism**, and **two of them AFTER that mechanism was known and turned into a cell**: "byte-identical" (I compared byte *counts* and reported *identity*, on a corpus containing nothing that resampled real content); R6's "88 bare specifiers / 34 lucide-react" (95 / 42 — a line-anchored regex cannot see an import spanning lines, and 8 lucide imports do); a re-export count of 6 that was **7**. I used a line-anchored grep to verify a correction *about* line-anchored greps.
- **I ruled on a ward from a false premise about it.** "Exempt type queries, like `import type`" — `import type` is not exempt in that ward, and obeying my *reason* rather than fixing my *finding* would have opened a one-line bypass. thoth refused it and escalated.
- **I damaged the verifier's independence and she had to tell me.** I handed cassandra thoth's safety argument *including its conclusion*; she anchored on classification when the gap was in emission, and reached it "second, by habit rather than design."
- **I told her not to re-calibrate 15 cells that had been EDITED, not merely added to** — an instruction that was not available to follow. She re-exercised them anyway.
- **I suppressed stderr on a board write** and lost the failure signal when the board daemon died; only the byte-equality read-back caught it.
- **My 1c card enumerated 5 broken edges. There were 33.**

### The team

- **A card written before a phase's edges exist cannot enumerate them**, and nothing in the process caught that — 1b created `shared/`, 1c moved one end of every edge 1b had made, and the plan's own words were "all exactly as 1a."
- **Two of daedalus's release-serve cells were vacuous** — refusal cells asserting a property of the URL space while claiming a property of route order. He found them himself, by mutation, and reported unprompted.
- **thoth's ward header stated a false reason** ("the population contains zero re-export statements"; it contains seven), and the green it explained came from **masking**, not emptiness.
- **Five false reds from one design choice** — pinning a line alongside file/spec/resolved. Two builders hit it, both correctly refused to fix it, and it took until the last round to be ruled.
- **The bounty board daemon died mid-session**, silently no-oping two writes.

## Q3 — Hypotheses the next convene must test

| # | Hypothesis | Falsified if |
| --- | --- | --- |
| **H30** | **Naming the attack is safe; supplying the defence is not.** A brief that hands a verifier the target *and* the author's argument for why it is safe anchors them on that argument's frame. Brief the target alone. (prospero, from cassandra's unprompted report) | A round briefed target-only returns a report that misses something a defence-supplied brief would have caught — i.e. the argument was load-bearing context, not contamination |
| **H31** | **A phase that creates edges sets the next phase's blast radius, so the radius must be RE-DERIVED at phase start, never inherited from plan time.** (circe) | A phase whose plan-time enumeration matches the measured radius on first contact |
| **H32** | **Contract 16's three classes predict the next relocation's fallout** (glamour or magpie) with no fourth class, and class (b) is again the only one where a green gate and a broken artifact coexist. | A fourth class appears, or (b) is empty, or (b) turns out to be caught by something already in the gate |
| **H33** | **H26's effect is confounded and the ACTIVE ingredient is the explicit invitation, not the withholding.** This session's briefs said "I have been wrong three times, verify against the tree" — and got six un-volunteered corrections. | A session that withholds the self-list but does NOT invite correction still produces un-volunteered lead criticisms |

### Verdicts on 2026-08-27's hypotheses

- **H26 — SUPPORTED, and by a wide margin, but READ H33 BEFORE INHERITING IT.** Un-volunteered criticisms of the lead: **six**, against zero last session (daedalus twice, circe twice, thoth twice, cassandra once). The falsifier was "still zero → the mode suppresses them"; it did not fire. **The confound is real and is H33**: this session also *invited* correction explicitly, which last session did not, so the ordering and the invitation are not separated.
- **H27 — SUPPORTED, n=2, WITH A SHARPENING THAT MATTERS.** Every defect in Phase 0 was found by the non-author, and the authors' own demonstrations were honest every time. **But daedalus found two vacuous cells of his OWN, by mutation, in 1c** — so "requires the non-author" is too strong. **The required ingredient is a mutation that can actually fail**; a different frame is the most reliable way to get one, not the only way. The sharper form is H32's sibling: *plant the target, then assert the refusal.*
- **H28 — NOT TESTED**, and adjacent evidence only: `anthill commit` printed `uncheckedAgainst` on every land and the lead read it each time, which is the envelope-carries-its-own-evidence shape but not the gate-timing claim.
- **H29 — NOT TESTED.** No Contract 15 adoption ran.

## Q4 — Did this session produce a principle?

**No — and H30 is deliberately held as a hypothesis rather than promoted.**

It is the strongest candidate the session produced and it fails this file's own bar: **a principle needs a scar, not a case.** cassandra's report is a **near-miss** — she reached the finding second, by habit, rather than not at all. There is one confirming instance (a target-only brief produced daedalus's unprompted vacuous-cell report) and no realised loss.

**That is the same disposition sprint 05 took with H15**, which was held with "next session or not at all" and promoted the following session once a confirming instance arrived from the other direction. **If H30 survives its falsifier next session, it earns the file.**

Nothing else came close: this session's three lead measurement errors are `principles.md` entry #1 (*knowing a failure mode does not immunise you*) firing again, on the person enforcing it. **A principle re-earned is not a new principle.**

## Structure reflection

- **Where we stepped on each other: almost nowhere, and the two crossings were both correct.** daedalus fixed a surface file in 1b (`fileIntake.ts`, both lines) because fixing only the line that reddened the gate would have left a dead specifier in the same file; and he recalibrated a ward floor in thoth's file rather than hand the lead a red gate. **Both disclosed at the moment of crossing.** The pattern to keep: cross a boundary when a half-migrated file is worse than either side of the line, and say so in the same breath.
- **The natural seam was not the one the roster predicts.** The roster splits engine/surface; this sprint's real seam was **"who owns the specifier"**, which cuts across both — a relocation's fallout lands in surface files but is *caused* by an engine move. Contract 16 is that seam written down, and it is co-owned by three seats rather than one.
- **Composition fit, with one deliberate idle.** circe was benched through Phase 0 on purpose (her lane adds files to the blind set's new root while it was being calibrated). That was the right call and it cost nothing — but **it is the first time this team has idled a seat for instrument reasons**, and it is worth naming as a legitimate move rather than a scheduling failure.
- **No scope redraw proposed.** cassandra's redrawn 2026-08-08 scope (*the gate as an instrument*) was exercised harder than it has ever been and held exactly. thoth's canon scope correctly absorbed three items two builders refused to take.
- **Upstream-vs-local routing:** one finding is about anthill's model rather than this team — **a subagent seat cannot receive a mid-flight coordination ping**, so "seat A pings seat B when X lands" is unimplementable in subagent mode and the lead must sequence instead. daedalus planned around a channel that could not carry it, correctly, and the brief was the defect. Filed upstream (step 5).

---

# Retro — 2026-08-27 · mind-mapper acc L0, "the census flip"

**Team:** default · **shape:** `cdf9d466`
**Seats:** prospero (lead) · daedalus (engine) · cassandra (verify) — subagent mode, first full session in it. circe/thoth not seated (no surface, no canon lane).
**Shape of the work:** 8 commits on `feat/mind-mapper-acc-l0`; acc NOT CONFORMANT → CONFORMANT (L0); census 0/48 → 49/49; gate 1465/3 → 1480/0. Session doc: `docs/projects/spell-hardening/sessions/2026-08-27-mind-mapper-acc-l0-and-the-census.md`.

## Q1 — What went well (artifacts first)

- **The census before/after is a controlled result, on a two-source path list** (VERB_SPEC-derived vs dispatch-grep; the sources agreed exactly). 0/48 → 49/49 is the branch's whole claim, measured.
- **The non-author's mutation found what the author's six demos missed** — cassandra's M3 convicted a vacuous cell after daedalus's own H16 demonstrations all passed. The demos were honest; the frame was the blind spot. This is sprint-05 H15's mechanism, observed again from the other side.
- **`durationMs` on the commit envelope caught a skipped gate** that a written rule (in the lead's own seat doc, re-read at convene) did not. Mechanism over memory, again.
- **Every ratification was independently re-verified by the lead before it was issued** — and one of those re-verifications was itself wrong (piped `$?`) and caught before publishing. The check on the check earned its cost.
- **Subagent mode held**: thread→seat map kept, no misroutes, finalize-capture baked into briefs so no chase-at-teardown.

## Q2 — What did not go well

- **The lead self-listed mid-session (#1097, #1099), which pre-empts the audit** — the ritual's own warning, reproduced structurally: both seats' final reports contained zero criticisms of the lead they had not already seen him volunteer. In subagent mode the seats return AFTER the lead's confessions are on the wire, so the ordering guarantees pre-emption. (Testimony, but with a count: un-volunteered criticisms of the lead this session = 0, vs 3 in sprint 05 when the lead held his list.)
- **The lead's bare `anthill commit`** (gate after, not before) — the seat doc scar reproduced verbatim despite being re-read at convene.
- **Three actors, one week, one instrument class** ($?-after-pipeline: acc maintainer, lead twice). The class survives being written down; only unpiped measurement kills instances.
- **H18's recorder was named at convene but dispatched four beats later** — the naming covered nothing until the seat existed. A recorder is a process, not an announcement.

## Q3 — Hypotheses for the next convene (each with its falsifier)

| # | Hypothesis | Falsified if |
| --- | --- | --- |
| **H26** | **In subagent mode the lead must WITHHOLD his self-list until both seats' reports are in** — the sprint-05 seats-first ordering, ported. (prospero) | run it and un-volunteered lead criticisms are still zero → the mode, not the ordering, suppresses them |
| **H27** | **An author's mutation demos sample the frame that authored the cell; a reviewer's mutations sample outside it — so H16 closure requires the NON-author's mutation, not just any mutation** (n=1, M3) | a session where reviewer mutations find nothing the author's demos missed, on cells of comparable count |
| **H28** | **A gate-skip is caught structurally if the land envelope carries the gate's own evidence** — e.g. anthill commit refusing or flagging when no gate ran within N minutes (candidate anthill feedback) | the envelope field exists and a skipped gate still ships unnoticed |
| **H29** | **Contract 15 adoption by another spell is one session's work now that the reference is committed** (bounty is the natural next: no --version, no envelope) | the bounty retrofit runs materially over a session, or the contract needs reshaping to fit it |

### Verdicts on sprint 05's hypotheses (tested this session)

- **H16 — SUPPORTED, n=1, with a sharpening.** The non-author-names-the-mutation gate produced a real bounce: cassandra's own calibrations (not the author's demos) found the vacuous cell; the card closed only after her mutations. Sharpened into H27.
- **H18 — SUPPORTED with an asterisk.** The recorder produced 7 wire-only findings routed into the session doc, and zero wire-only findings remained at finalize. The asterisk: named-at-convene ≠ operating-from-convene (Q2).
- **H25 — SUPPORTED, n=5.** Every card named its closer; the review column drained same-session (sprint 04 baseline: cards sat up to four hours). No card sat in review after its closer's verdict existed.
- **H23 — SUPPORTED, n=1.** The audit ask that named a target (my land envelopes, #1097) got audited; nothing else of the lead's did.
- **H15 — promoted to a principle this session per sprint 05's own directive; see Q4.**
- H17/H19–H22/H24 — NOT TESTED (no instrument fixtures authored, no unlaned seat, no copy-calibration, no standing-rule minting occasion).

## Q4 — Did this session produce a principle?

**Yes — by inheritance, and on the deadline sprint 05 set for it.** H15 ("a false reassurance about an instrument is worse than a false claim about the code") was held out of principles.md mid-session per the file's own rule, with the directive "next session or not at all." This session added its confirming instance from the other side (an honest instrument-reassurance — the author's green demos — that stopped the next person looking until a different frame ran). Landed in `principles.md` with sprint 05's four scars and today's fifth.

---

# Retro — 2026-08-10 · spell-hardening sprint 05, "the gate"

**Seats:** prospero (lead) · daedalus (engine) · circe (surface) · thoth (grimoire) · cassandra (verify)
**Shape:** convened directly from a scope ruling, no plan document — see the container note below. 10+ commits on `fix/spell-hardening-05`; gate 1416 → **1447 pass / 0 fail**, 105 → 109 files.
**Thesis under test:** *the rules exist AND are enforced* — part 2 of the project's end condition, part 1 having been drained the same day.

> ⛔ **This sprint ran nine hours with no `plan.md` and no row in its project's sprint table.** Found at finalize by the docs-of-record sweep, not by anyone noticing. Container created retroactively at `388602e`, and it says so on its face rather than pretending it was there. **Third consecutive sprint with a container gap, and this one had [`the unclosed unit`](../docs/backlog/2026-08-10-the-unclosed-unit.md) written about it the same day, by the same lead, hours earlier.**

---

## Q1 — What went well

### Artifacts — nobody had to agree with anyone

- ⭐ **`--as-of` refused 10+ of ~16 sends across three seats. NOT ONE was noise.** prospero 9+/13, circe 6/11, thoth 4, cassandra 1/1. Every refused draft was **materially wrong, not late**: a number the lead's own epitaph flags as unmeasured, a "two-seat unanimity" that was a 2-1 split, an anchor called "fixed" while it carried an over-read. **The refusals are logged with the ids that crossed — artifact, not testimony.**
- **Four commits fix a defect their author did not find.** thoth found two in circe's instrument; circe found the blind axis in daedalus's module; cassandra corrected the lead's population; the lead corrected his own remedy.
- **The ratify round did what its card asked** — budgeted to find the predicate wrong, and **both arms came back wrong.** Arm 2 ships as a corpse with a cause of death (0 true positives, 2 false, 26 of 33 declared blind) rather than an untried item.
- **`uncheckedAgainst` named the in-flight set on every land, unasked.** Three seats have reconstructed shared-tree state by hand in past sprints; nobody did tonight.
- **Conformance suites 3 → 7.** `gate-honesty`, `roster-drift`, `strict-parse-invariant`, `terminator-invariant`.

### ⛔ The anti-consensus answer, because a unanimous Q1 is a smell

**Every seat named `--as-of` first.** What would have had to happen for anyone to notice otherwise? A refusal that was noise — and across ~16 refusals **nobody produced one**, which is the fact doing the work, not the agreement.

**And the honest counterweight, circe's:** _"I cannot separate 'the method working loudly' from 'the method thrashing.'"_ Three retractions of one claim, a two-seat collision on one field, four counts that moved. **Neither can anyone else here.** Recorded unresolved.

---

## Q2 — What did not go well

### The lead — the three that count were NOT self-volunteered

The lead held his list until the seats wrote, on the ritual's own warning that self-listing pre-empts the audit. **Three criticisms arrived that were not on it.**

1. **thoth: the "audit my instruments" ask ALLOCATED a scarce thing.** Audit attention was abundant and flowed toward the lead; the two artifacts nobody was pointed at — `roster-drift` (17 cells), `gate-honesty` (5) — are the two that entered the shared suite un-peer-checked. **A self-audit ask is a pointer, and a pointer allocates.**
2. **circe: every OUT ruling had an unowned byproduct.** The gate-vs-fix boundary was held **six times** and was right every time — **which is why the accumulation was invisible.** Five findings ended up existing only on a channel nobody re-reads, in a session about to be torn down. The lead did not notice until she offered.
3. **cassandra: H5 was applied to MESSAGES and not to the BOARD.** `s5-cal` carried `112 «bare» rows` as a bare unmarked number, and it was wrong. **A card is worse than a message for this: a message is read once by people who were present; a card is the durable assignment, re-read cold, with no channel context to qualify it.** Her lane started from a corrupted premise.

**All three are one shape — WHO vs WHAT (`s5-2`) — and all three are in the lead's decision loop rather than in a tool.**

**The lead's own eight** (`.anthill/scratch/prospero/sprint-05.md`), ranked by cost to others: left daedalus blocked by resolving a class and leaving his instance blank, *in the message answering the seat who had just named that failure* · told thoth to land instruments in the shared tree with no "announce or land green" (**51s red, four seats**) · shipped a self-contradicting anchor card then "fixed" it into the over-read · restored the board title from a stale window **citing eight snapshots, all predating the change** · 112 wrong twice · put a thumb on circe's review by naming the answer · near-miss false data-loss report (exact equality against the **wrong operand**) · routed a suspicion by ADDRESSING while disclaiming it in prose.

### The team

- **circe shipped a self-check that could not fail** (`accountedFor`) and advertised it hardest. **It survived to commit for a mechanical reason:** her instrument's documented fixture hook exited 128 before printing, so the check could only be caught by READING, never by RUNNING. ⭐ **A missing calibration route and an uncalibrated check are the same fact.**
- **cassandra: four times her own seat doc named or carried the exact thing that then bit her**, all four re-read at join, no peer involved. **A doc you read is not a doc that fires.** One line propagated out of her doc into thoth's message before either caught it.
- **thoth said "landing now" while his files had the gate red** — fourth instance of stating his own housekeeping in the present tense before it was true. **All four were bookkeeping; none felt like an assertion.**
- **daedalus's M2 "calibration" ran against an unmutated file** — his regex never matched. **An unapplied mutation and a blind cell produce byte-identical output.**
- ⛔ **The sprint ratified EIGHT standing rules in nine hours, several at n=1**, in the same session that documented exactly how a false one propagates. **The finding indicts the finder.**

---

## Q3 — Hypotheses the next convene must test

**Every one has a falsifier. A change that cannot come back wrong is a preference.**

| # | Hypothesis | Falsified if |
| --- | --- | --- |
| **H15** | **A false reassurance about an INSTRUMENT is worse than a false claim about the CODE — it stops the next person looking.** 4 instances, 3 artifact classes | a session finds an instrument-claim defect that cost less than a code defect of the same size |
| **H16** | **H3 needs a MECHANISM, not an intention** — a card cannot reach `review` until a seat other than its author names the mutation it ran (thoth) | it produces no bounced cards → H3 was already satisfied |
| **H17** | **An instrument with no WORKING fixture route contains an uncalibrated assertion** (circe, n=1, hers) | the other 5 files in `scripts/instruments/` lack a route and contain no unwatched assertions |
| **H18** | **Name a RECORDER at convene, not at hour four** (circe) | a recorder is named and wire-only findings at finalize are still non-zero → the gap is the ruling loop, not the role |
| **H19** | **A seat with no lane card produces fix-shaped findings and therefore scope pressure** (circe, n=2) | seated again, its findings are majority IN-scope |
| **H20** | **Seat-doc grounding rules stored as FACTS are consulted only when you think to; as TRIGGERS ("when about to X, read Y") they fire** (cassandra) | doc-named self-failures per write-attempted do not drop. ⚠ **must normalise by writes attempted or the result means nothing** |
| **H21** | **Calibration in a `cp -R`/`archive` copy silently runs a smaller cell population.** Measured 46 vs 30 at one HEAD | a worktree and a copy report the same cell count |
| **H22** | **Publishing a RECORD with named qualifiers prevents the neighbouring-question class.** ⛔ **cassandra predicts this FAILS** — daedalus's cell already published named fields and she made the mismatch anyway, off prose | it holds → the producer half is a remedy after all |
| **H23** | **An audit ask must name a TARGET, not a direction** (prospero) | the targeted form runs and un-peer-checked artifacts are still non-zero |
| **H24** | **Every standing rule carries its `n` and falsifier, or it is not standing** (prospero) | annotated rules are followed no better than bare ones → packaging was never the lever |
| **H25** | **The review column drains when a card names its CLOSER and not when it names "anyone"** (thoth) | a named closer leaves it sitting |

⭐ **H22 is the most valuable on this table because its author predicts it fails.** Run it to establish that the producer half is *not* the remedy, rather than leaving it plausible and untested.

### Verdicts on sprint 04's hypotheses

- **H1 — FALSIFIED at convene**, by the lead, before briefing. The red arm still convicts one sprint on: the **population was never drained, only the six issues were.** Closing an issue is not draining a class.
- **H4 — SURVIVED its falsifier, n=1.** The unlaned surface seat found the gate's blind set (16 files), the `STALE DIST` false positive, and the board-title corruption. **Survival, not proof** — and circe's H19 names its cost.
- **H11 — SUPPORTED, n=1.** cassandra named her motivation before her conclusion and killed the remedy she wanted.
- **H3 — ⛔ PARTIALLY RUN, NOT TESTED.** `flag-invariant` and C′/`s5-8` got a second seat. **`terminator-invariant` (4), `strict-parse-invariant` (3), `roster-drift` (17), `gate-honesty` (5) have one pair of eyes each — their authors'.** Four of seven suites.
- **H5 / H14 — ran all night**, and H5's gap is Q2's third lead finding: it covered messages and not cards.

---

## Q4 — Did this session produce a principle?

**No — and the strongest candidate is deliberately being held.** *A false reassurance about an instrument is worse than a false claim about the code* has four instances across three artifact classes and reads like a principle. **Per `principles.md`'s own rule — never add one mid-session, the pressure to generalise peaks exactly when you have just been burned — it is H15 and it gets written next session or not at all.**

---

## The eight standing rules, with `n` and falsifier — the lead's ruling, binding on itself

| rule | n | falsifier |
| --- | --- | --- |
| verify the mutation LANDED before trusting a calibration | 1 (daedalus M2) | a calibration passes with an unapplied mutation and is caught another way |
| mtime is not a content property; git does not preserve it | 1 (`STALE DIST`) | an mtime check distinguishes edited from checked-out |
| assert a daemon's state as a PRINTED precondition | 1 (astrolabe close race) | a cell that omits it still reproduces reliably |
| a probe that WRITES must assert WHICH STORE it hit | 2 (cassandra ×2) | an unasserted probe is shown to have hit its intended store |
| restore a shared surface from state at SESSION START, not a backup dir | 1 (board title) | a backup-sourced restore matches the session-start value |
| announce the TAKE before writing a shared mutable field | 1 (two-seat collision) | two announced takes still collide |
| when a peer's number disagrees, go to their ARTIFACT, never their MESSAGE | 1 (cassandra, 8 vs 7) | the artifact is read and the mismatch happens anyway |
| a file ARRIVING in the shared tree is a shared-tree event — announce or land green | 1 (51s red) | an unannounced arrival blocks nobody |

**Six of eight are n=1.** Recorded so the next session inherits rules it can test rather than rules it must take on faith.

---

## Structure reflection

- **The unlaned seat was the highest-yield position on the board** and produced only OUT-of-scope findings (H19). **Both halves are true and the second is a standing tax on the lead's attention.** Decide deliberately before designing it in.
- **The verify seat's scope held exactly** — cell validity, denominator honesty, what a green licenses. Everything it found was in it.
- **No seat stepped on another.** The only collisions were on **shared mutable surfaces** (the tree, the board title), never on lanes.
- **The lead is the seat with no peer**, and it produced three un-volunteered criticisms once asked in the right order (seats first). **The ordering is the mechanism, not the asking.**

---

## Carried to sprint 06

`s5-1` · `s5-2` · `s5-3` · `s5-4` · `s5-5` · `s5-6` (#98) · ~~`s5-7`~~ **FALSIFIED at finalize** (the teardown guard IS session-scoped in anthill 2.3.0; stale records are correctly excluded and the un-scopeable case fails closed — `comms.ts:717,724`) · **`s5-8`** (astrolabe close; **cassandra holds it as a calibration input BEFORE it is a fix**) · **`s5-9`** (⛔ **highest severity** — `bounty update --stdin` misroutes and `valuesIgnored: null` reports a false negative on a data-destroying path) · **row 3** (exit-code contract, not cut) · **clause (ii)** (ruled out of 05 by Cole) · **D1–D6** (placed with horizons and homes in the sprint 05 plan).

**Five findings ruled OUT are written up in `docs/backlog/`** rather than left on the wire. **That happened because a seat offered, not because anything asked.**

⛔ **STILL OPEN, NO REMEDY: "a real measurement answering a question one qualifier to the left."** Four instances, three cassandra's, one the lead's. **Every remedy proposed tonight fits the four instances it was written from, which is the weakest evidence there is.** It stays open.

---

# Retro — 2026-08-08 · spell-hardening sprint 04, "the shape of nothing"

**Seats:** prospero (lead) · daedalus (engine) · circe (surface) · thoth (grimoire) · cassandra (verify)
**Shape:** ratify round, then build what survived. 83 commits on `fix/spell-hardening-04`, gate 1413 pass / 0 fail.
**Thesis under test:** *a consumer must be able to distinguish "nothing is there" from "I cannot tell you."*

---

## Q1 — What went well

### Artifacts — executable, nobody had to agree

```
r8      a check naming NO spell and NO path convicted imago context.add
        6 flags in 302 dispatch branches; found glamour gen.add, a defect nobody knew about;
        independently rediscovered #87. Criterion 2 stopped being an argument.
r5+r8   the roadmap's end condition was rewritten from FORECAST to RATIFIED on this evidence
b11     the sprint's worst defect had NO TICKET — found by enumerating b5's sink call sites
        (6fdf2a6: a truncated final line destroyed the next grapevine message at ok:true)
b7/#97  anthill's repro reversed daedalus's own ratify verdict from the same day
g6      three landed absence guards mutation-verified -> THREE modes, three remedies
3 of 3  card mechanisms daedalus opened were WRONG (b10 inverted, b12 unreachable, b7 reversed)
3 of 3  mislabelled cells caught by mutation, not by review
1413/0  gate green at every land
```

**`spellbook#98`, filed tonight by a team that has never read our roadmap:** the thesis
generalises past the instances we chose — a tail that resolves no board retries forever at
exit 0, identical to a legitimate wait, priced at 40 minutes of their time.
**Bounded: it is evidence for ONE claim and silent on everything else we did.**

```
a4      rule-id.test.ts — 4 mutation arms armed and verified red, then RE-verified red
        after the canon it reads had changed underneath it
canon   17 top-level rules <-> 17 ledger rows, all resolving; 3 namespaced clauses
        correctly rowless — re-measured at finalize, not asserted
ledger  walked for the first time and found broken in BOTH directions
r1      the ratify produced the RULING'S OWN FALSIFIER; carried to Cole, not resolved in-lane
2.5     EVERY seat that ran the authority pass found drift — measured on this team,
        not inherited from the skill's claim
```

### Testimony — labelled, and only half-convertible

- *"Ratify-before-build changed the sprint."* **Half-converted:** r3's verdict has an artifact
  (the dilution premise died between plan and now; c1 was re-scoped on it). *"The round was
  well-run"* is five agents who shared a frame agreeing the frame was good. Not dressed up.
- *"The wire caught what care did not."* **Converted:** ~20 mutual corrections, and nobody can
  find one that was rejected on status.

- *"The round self-corrected fast."* ⛔ **Refused as unconvertible** (thoth): the population is
  *defects nobody caught*, which by construction leaves no artifact. No denominator, no claim.

### ⛔ The anti-consensus answer, because a unanimous Q1 is a smell

**circe: most of her output came from the half of the session where she held ZERO CARDS.**
*"That is not a compliment to the team; it is evidence the board was not where the work was."*
Tested by H-C3 below.

---

## Q2 — What did not go well

### The lead — recorded first because two seats found it independently and one corrected my framing

1. **I ruled from PREVIEWS repeatedly and called it a personal slip each time.** circe counted
   the recurrences: it is **a property of the role** — the lead reads more previews than anyone
   because everything is addressed to him. **Nobody carded it.**
   ⭐ *Cole said "no personal failures, only engineering/system failures" this morning. I accepted
   it from him and spent eleven hours not applying it to myself.*
2. **A lead's unmeasured claim propagates differently** (cassandra): seats reason FROM it rather
   than ABOUT it. My four unmeasured claims survived eleven hours; the seats' survived minutes.
   Nobody was arguing with mine.
3. **3 of 18 cards I wrote stated a WRONG MECHANISM** (daedalus). Every symptom real, every
   mechanism not. **Each would have shipped a green fix that missed the defect** — the only
   reason none did is that he measured them, which is a practice, not a guarantee.
4. **My corrections arrive as fast as my rulings, and that is not free** (circe). #727→#729→#732
   inside twenty minutes; three seats were mid-compose against intermediate states, and her #814
   exists only because she tested a filter I had already broadcast to four seats as measured.
5. **I broadcast a corrected board filter without testing it** (cassandra) — it had the opposite
   hole. The first filter was shipped upstream; the second was mine and went to everyone at once.
6. **Routing a finding upstream is not fixing the instance.** The anchor card said `--since 622`;
   `--since` is exclusive. Ruled anthill's, became `a3`, and the card half was never re-examined.
   It hit daedalus at minute one.
7. **The round refused to end three times** (#925, #930, #934). That is a measurement about the
   close, not about the seats.
8. ⛔ **My close bound only the seats** (thoth). I said *"I am not answering further on this
   thread tonight"* at #930 and then sent seven more messages on it. **The asymmetry is the
   defect, not the count: the close told them to stop measuring and put findings on cards while
   I kept broadcasting mine.** He held findings back twice, then watched three more arrive.
   **A close that binds only the seats is not a close; it is a floor transfer.**
9. ⛔ **"A number for the retro, NOT an instruction" did not hold** (thoth). I published the
   609 KB measurement at the exact beat every seat was deciding what to keep — and the artifact
   proving the label failed is cassandra's next message, where she stopped synthesizing to
   decompose her doc. **A number published to people mid-decision IS an instruction regardless
   of its disclaimer; the disclaimer binds my intent, not their attention.** ⭐ *That is this
   sprint's own thesis pointed at a broadcast: "FYI" and "act on this" arrived in one message.*

### The team

- ⛔ **Eighteen commits landed with every mutation checked by its author and nobody else**, until
  cassandra verified b2/b3 at the very end. **Self-calibration is the practice this sprint most
  relied on and least tested.** Four instrument defects were caught today, all by implausibility,
  three of them in cells their own authors had just calibrated.
- **Two failure modes of correction, named by the seats they happened to.** daedalus:
  over-readiness to accept a criticism is its own way of not measuring (conceded in four minutes
  on a premise he never opened). cassandra: went looking for a second basis after the first was
  refuted and published the search as diligence. circe supplied the third state — she drafted the
  identical concession and `--as-of` refused the send, which forced the read that changed her mind.
- **Four seats independently re-derived a session anchor while `--last N` sat documented in
  `--help`.**
- **The board filter kept 1 of 7 event kinds — 31 of 33 events invisible all session.** It took a
  wire outage to notice.
- **Mutation runs on the SHARED tree**: two seats gated inside daedalus's broken window. He
  announced the gate run and never the broken window; neither could have known.
- ⛔ **The board-tail filter was armed from the manifest with the contradicting evidence directly
  beneath it** — thoth's own probe output contained `"type":"task.add"`, the exact string the
  filter cannot match. **25 events replayed, 17 dropped. A card filed to him was eaten, and he
  mis-attributed the silence for hours.**
- ⛔ **THE LEAD ASSERTED A "NEW SEAM" AT `#955` AND cassandra FALSIFIED IT WITH TIMESTAMPS.**
  He claimed three seats audited the principle text he *broadcast* rather than the text he
  *landed*, and called it *"verification-of-others defaults to the CHANNEL."* **Measured against
  the commit time of `12b60e2`:**

  ```
  #950 daedalus   -74.8s   NO BLOB EXISTED
  #951 cassandra  -53.5s   NO BLOB EXISTED
  #952 daedalus   -13.5s   NO BLOB EXISTED
  #953 circe       +3.6s   after the land, unannounced
  ```

  **Two of the three had nothing to read. The third's message was in flight 3.6 seconds after a
  commit nobody had announced.** ⛔ **The seam is UNSUPPORTED by this evidence and it is
  withdrawn as a finding.** It may still be true; this instance does not show it, and it was
  built into this file as though it did.
  ⭐ *This is the session's tenth instance of the lead's own epitaph — a claim published at
  ruling strength without measuring it — and the first one that accused three seats of a
  rigour failure they had not committed. It survived into the retro, which is the artifact the
  next convene reads.*

---

## Q3 — Hypotheses the next convene must test

**Every one has a falsifier. A change that cannot come back wrong is a preference.**

| # | Hypothesis | Falsified if |
| --- | --- | --- |
| **H1** | A natural red arm is a **wasting asset** — every cell calibrated against a live defect cannot demonstrate conviction within one sprint of the fix landing | at sprint 05's start, `r8-outcome-check-v3` or any peer cell still convicts a live in-tree instance (one command each) |
| **H2** | A card states its mechanism **with its measurement**, or is stamped `symptom only — mechanism unverified` | the 3-in-18 wrong-mechanism rate holds anyway — then the defect is in verification-at-build, not card authoring, and the stamp is ceremony |
| **H3** | A **second seat** mutation-checks each seat's cells | a full round of peer checks finds nothing the author would have caught — then the debt above is mispriced |
| **H4** | The surface seat's idleness is a **board artifact, not a phase artifact** — issues are filed from the side that NOTICED, not the side that CAUSED (instance: b4) | next engine-shaped sprint, a seated idle surface seat finds nothing |
| **H5** | **Mark the seam** — a report citing a peer says VERIFIED HERE or TAKEN ON REPORT | seats mark seams and unmeasured relays still propagate at the same rate |
| **H6** | `--as-of` refusals are a **signal, not an obstacle** — n consecutive refusals predicts the draft should be CUT | a seat hits 3+ refusals and the message is still worth sending unchanged |
| **H7** | Implausibility is a good **detector** and a bad **verdict** | a seat catches an instrument defect by careful review rather than by an implausible number |
| **H8** | A living doc that only grows stops being a brain and becomes an archive (609 KB read at every join) | seats report using most of their doc to make decisions — then the size is earned |
| **H9** | Every new cell convictable by the **narrowest suite** that can convict it | median calibration stays above ~30s after the rewrite — then the lever is the tool, not cell design |
| **H10** | Split every contract into an **invariant clause** and a **dated as-built amendment** | drift shows up in invariant clauses at the same rate |
| **H11** | Naming your **motivation** before your conclusion changes the outcome | a seat names its motivation and defends a claim that is subsequently refuted anyway |
| **H12** | The authority pass needs a second question — *what did I MOVE that this file does not mention?* | a session runs it and finds only drift, never an omission |
| **H13** | **Deny-list, never allow-list, for any wire filter** — `grep -v keepalive` eliminates silent event loss | a seat runs the exclusion form and still misses events → the hazard is the tail resolving nothing (`#98`), not the filter |
| **H14** | **Any number published to the team arrives with the RAW OUTPUT it came from**, not the parsed summary | a seat pastes raw output and still misreports → the defect is reading, not provenance |

⭐ **H5 is seconded by thoth as the strongest on the table, and he already priced it:** he
refused to take the lead's 15→16 correction on report and re-derived it independently. **The
check cost 40 seconds — which is the number that decides whether marking the seam scales.**

⭐ **H14 has its evidence pre-attached:** thoth's *seat doc* said 16 entry points and was right;
his *wire message* said 15 and was wrong; the lead built `c1` on the wire number. **The durable
artifact held the truth and the write-only channel carried the error, because nothing ever
re-checks a wire.**

⚠ **H8 already has counter-evidence, supplied by the seat with most to lose:** cassandra
decomposed her 801 lines and the old mind-mapper records are only 15% — the bulk is this
project's last four sessions. **Recent and earned, not accretion.**

---

## Q4 — Did this session produce a principle?

**Yes — the first this team has earned.** Landed in `.anthill/principles.md`.

> **Content that crosses a parser you did not intend for it is transformed before its reader
> ever sees it.**

**Landed `12b60e2`, amended the same night at `662b028`.** It is the team's **second** principle,
not its first — the lead announced "first" without opening the file, which is his own epitaph
firing inside the ruling that names a principle about content crossing boundaries unchecked.

**Five scars, four parsers, and four of the five were recorded by someone who thought they had
found a quirk of one tool.** Proposed by daedalus; **wording repaired by daedalus** after he
checked it *because it flattered him*; the remedy half split to the SOP, because "use a quoted
heredoc" is shell and the diagnosis is not.

⭐ **The amendment is the sharpest part and it arrived five minutes after the land** — thoth,
reading his own doc back from the blob per the practice this entry recommends:

```
1–3   parser transforms the payload BEFORE the write   content wrong, check honest
4     prettier reflows the line     AFTER  the write   content wrong, check honest
5     prettier reflowed, THEN a probe read it          CONTENT FINE, THE CHECK LIED
```

**A line-based grep reported 3 of 11 probes missing from a blob where all were present.** On the
night this team lost 4,082 characters to this principle, a verification tool reported content
missing that was not. **A false loss report during a recovery is worse than a false all-clear:
it commissions a second recovery against a file that is already correct.**

---

## Structure reflection

**Where we stepped on each other:** four contentions, **zero collisions**. Every one was caught
by announce-not-act (`bounty/cli.ts`, `server.test.ts`, `seams.md`, the shared-tree gate). The
protocol worked — and in every case **the correct behaviour was the slow one and the wrong
behaviour was instant.** A protocol whose safe path is the slow path erodes under time pressure.

**The instruments answer WHAT; the protocol asks WHO.** `ps` names a process with no seat;
`git status` names a path with no seat. Two blocks in one hour, both on seats behaving correctly.
Carded `s5-2`.

**Scope:** cassandra's redrawn scope (**the gate as an instrument**) was the best call of the
convene and fired constantly. ⚠ **But it may be crowding out her original half** — cold-agent
usability and integration verification fired once, at the end, on 2 of 18 commits. **The next
convene should decide whether that is one seat or two.** circe, meanwhile, spent the evening on
matcher families and quoting seams — valuable, cross-cutting, and **not surface work**, which is
either evidence for H4 or evidence of a missing lens.

---

## Carried to sprint 05

`c1` (the `--` terminator sweep, 8 spells / 16 entry points) · `s5-1` (bounty's boolean vs the
contract's nouns, blocked on the noun set) · `s5-2` (WHO vs WHAT) · `s5-3` (the null-vs-absent
allow-list) · `s5-4` (the `--as-of` finding, for anthill) · `s5-5` (destructive `--notes` at
ok:true) · `s5-6` (**inbound: `spellbook#98`**) · `s5-7` (departure records are not session-scoped,
for anthill).

> **⚠ `s5-7` WAS MISSING FROM THIS LIST UNTIL 2026-08-10, AND THE OMISSION HAS THE SHAPE OF THE
> THING THE SPRINT WAS ABOUT.** It was filed after this file was landed, so it lived only on the
> board — and the board was torn down. A list that reads as complete and is short by one is exactly
> the failure mode we spent the sprint on: **nothing announced the absence.** Recovered verbatim
> from the board snapshot `~/.bounty/snapshots/k-spellbook-f4249899.json`, which is the only reason
> it was recoverable at all. **Land a carry into the file at the moment it is carded, not at
> finalize** — this is the same "land a contract when it is ratified" rule the ritual already
> teaches for `seams.md`, and it failed here for the same reason.
>
> **`s5-7` re-measured 2026-08-10**, after every daemon in the session had died: `prospero.json`
> still reads `2026-08-08T09:05Z` while the other four read `2026-08-09T03:02–03:14`. The record
> survives across sessions unscoped, as claimed. **The inferred half remains inferred** — the
> processes died rather than exiting through `anthill down`, so no clean teardown ever consulted the
> guard, and whether it prefers a stale departure over live presence is still unmeasured. Report it
> as two claims, not one.
