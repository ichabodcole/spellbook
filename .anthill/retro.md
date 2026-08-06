# Retro — newest first

Written by the lead at `anthill:finalize-session`, from the seats' answers on the wire.
**Every Q3 answer is a hypothesis the next session can test.** The next convene reads them back and says which it will test — **a prediction that comes back wrong is the valuable outcome.**

---

## 2026-08-06 — spell-hardening, the P0 BUILD round

**Seats:** prospero (lead) · daedalus (engine) · cassandra (verify) · thoth (grimoire). circe unseated again — no surface work; correct for a second round.
**Scope:** build the ratified P0 family. **Outcome:** P0's drained exit verified at **9 of 9** sites (5 pinned by regression tests, 4 by recorded drive); P0e complete; **one regression shipped and fixed inside the session**; P0b/P0c/P0d/P0f not started.
**Gate at close:** 1297 pass / 0 fail, biome clean, **under a private `TMPDIR`** — a frame that did not exist at open.
**Zero of the fourteen issues are CLOSED.** That is the honest headline.

### Q1 — What went well

**ARTIFACT claims (executable; nobody had to agree):**

- **The mechanism was measured across six spells** — bounty 89168, mind-mapper 119975, astrolabe 87806, magpie 88941, glamour 96911, imago 97021 — **all truncating at exactly 65,536.** Six payload sizes, one cut point, to the byte.
- **The gate went 1125s/red → 107s/green under G5**, reproduced by two operators independently.
- **`cassandra`'s precondition cell fired FOUR times and was right four times.** Each was a broken *fixture* that would otherwise have reported `COMPLETE == COMPLETE`. **A number, not testimony.**
- **A shipped regression was caught, diagnosed, fixed and gated in one session** — `ec33378`'s glamour hang, found in `ps` etime, fixed at `62a5972`, verified 1s against 91s.
- **Two seats struck two items from the lead's account, neither volunteered by him**, both before `retro.md` was written (#282, #285). **This is the direct falsifier of last session's observation that no seat produced a criticism of the lead he had not already volunteered.**

**TESTIMONY (labelled as such):** falsification was welcomed and nobody defended a claim. **thoth's caveat is retained because it is the right one:** *"four agents sharing one session and one frame will converge, and 'we corrected each other well' is what shared priors produce."*

**The one agreement that IS evidence:** daedalus and thoth enumerated the piped-spawn set **with different instruments** and got the identical six. **That is the inverse of the `ls` convergence below, and only the pair is meaningful.**

### Q2 — What didn't

> **⛔ AMENDED AT RETRO by daedalus, and the amendment matters more than the table.** The lead filed **every** Q2 failure under the instrument class. **The session's costliest defect does not belong to it**, and filing it there points the next session at the wrong fix.
>
> **The glamour hang was not a measurement whose question was too narrow. There was no measurement.** The one-liner was applied across eight files **as a bulk mechanical edit**, and the per-site precondition — `process.exit` doing double duty over a held pipe — was never surfaced because **nobody opened the file.**
>
> **The discriminator is exact and daedalus supplied it from his own record:** he caught the identical pattern at `join.ts` **because he opened it**, and shipped it at `glamour` **because it was one of eight.** Same engineer, same pattern, same night; the variable was bulk.
>
> **So there are TWO classes, and the fixes point in opposite directions:**
>
> | class | failure | what would fix it |
> | --- | --- | --- |
> | **Instrument** (10 instances) | a measurement was taken and its QUESTION was too narrow | a different frame; ask what the check cannot see |
> | **Recognition** (the hang, and `join.ts`'s near-miss) | **no measurement was taken** — a pattern was applied where a precondition was per-site | **stop treating N files as one edit**; better instruments do nothing here |
>
> **His epitaph is the finding compressed: _a bulk mechanical edit is where recognition fails._**
>
> **⚠ ALL THREE SEATS REACHED THIS INDEPENDENTLY, AND THE THIRD IS THE ONE THAT MAKES IT EVIDENCE.**
>
> - **daedalus** named it from his own shipped regression.
> - **cassandra** corroborated **from records written hours BEFORE his message** — not by agreeing with him after it.
> - **thoth** — **the seat whose data most naturally argues the OTHER way.** He catalogued more instrument failures than anyone (seven in his own ward alone), so if *"instrumentation was the costliest class"* were true, **his records are where it would show. He reports that they do not.**
>
> **A seat contradicting its own emphasis, using its own tally, is the strongest single piece of evidence this retro contains** — and it is the exact form of corroboration that survives the shared-frame objection thoth himself raised in Q1.
>
> **THE LEAD'S FRAMING WAS WRONG AND THREE SEATS SAID SO BEFORE `retro.md` WAS WRITTEN.** _Last session's observation — that no seat produced a criticism of the lead he had not already volunteered — is falsified three times over._

**The lead's original framing, retained below because the table is still true of the ten — but it is NOT the whole of Q2.**

**One class with ten instances: A TRUE MEASUREMENT WHOSE QUESTION WAS NARROWER THAN THE ONE NEEDED.** Seven were the lead's.

| instrument | asked | needed |
| --- | --- | --- |
| `grep <token>` | does the string appear | what consumes argv |
| `git show HEAD:<f>` | what is at HEAD **now** | what is at **this sha** |
| `git status` pre-gate | clean **now** | changed **during** the 107s gate |
| `ls <dir>/*.test.ts` | tests **here** | tests |
| the wire | what was **asked** | what was **done** (the tree) |
| `grep Bun.spawn` | does it **spawn** | does it **reach** the pointer write |
| `timeout` (macOS) | — | the tool does not exist; exit 127 read as success |
| pane + `comms positions` | what was **painted / read** | is it **working** (`ps`) |
| `stdio:` array grep | node's key | **`Bun.spawn` uses a different key** |
| `file:line` in a landed doc | where it **was** | where it **is** (6 of 9 stale by finalize) |

- **The `ls` convergence — the strongest structural result of the night.** daedalus measured wrong; **all three verifiers independently reproduced the error.** cassandra had a message written and unsent saying *"your premise verified, not assumed"* over the same glob; thoth had a correction drafted; the lead ran it and was composing a re-plan. **Each wrote their own command. Every one asked the narrower question, because the claim being checked supplied the frame.** What caught it was the author re-measuring his own claim — the one check this team's principle says cannot be trusted.
- **The lead published a false finding off a dirty tree** (#186) and handed a seat a scope escalation built on it; withdrawn at #188. **The instrument that would have caught it — `uncheckedAgainst` — had been named to him by thoth an hour earlier and assigned to him at his own ruling.**
- **The lead ruled P0e half 2 "UNBUILT and the unblock" three hours after it landed**, writing from the wire rather than the tree; the board then carried a `todo` card for finished work.
- **The lead started a competing drive on the verify seat's live measurement**, believing she had stopped. Caught by `ps` before the measurement step.
- **cassandra: 10+ instrument defects, and _not one was a false positive in her favour_ — all failed toward under-reporting.** Which is exactly why *"do my results look right?"* was structurally incapable of finding any of them.
- **thoth: seven instrument defects in his own ward; the three he caught had absurd output and the ones he missed were plausible.** He broke his own canon rule (`d2380a3`) **twice within ninety minutes of landing it.**
- **daedalus shipped the glamour hang in a file he never opened** — the fix was mechanical and the file was one of eight. He had reverted the identical pattern at `join.ts` four commits earlier.

### Q3 — Hypotheses for the next session

**Verdicts on last session's first:**

- **H1 (`landed: <sha>` column) — TESTED, and it produced a real result rather than a tick.** Its `_pending_` value read as *"decision pending"* and caused a ratified ruling to be flagged as unanswered (#165→#169); fixed mid-session to *sha or dash, never a word*. **Unpredicted benefit: requiring a sha meant each ruling landed as its OWN commit**, producing a history where every ruling is individually traceable.
- **H2 (bounded checks) — FALSIFIED BY COMPLIANCE.** Every seat stated scope and denominator, and **five enumerations were wrong while stating one.** In each, the stated scope *was* the shape of the blind spot. **cassandra's replacement stands as the finding: _a denominator is a claim about the cells you did NOT run, and stating one does not test it._**
- **H3 (assume-drift) — SUPPORTED, and now with the lead included.** Step 2.5 found **6 of 9 line references stale** in a doc he had landed hours earlier.
- **H5 (verification-by-mechanism is blind to bypass) — CONFIRMED TWICE, once outside code.** The source-scanning guard found **35 sites a mutation test cannot reach**. And the bypass appeared in *experiment design*: four draws on a hypothesis arm, one on its control, then "the control is stable."
- **H6 — holds as stated, with a mechanism attached.** ≥5 unverified claims about landed content occurred. But three seats ran blob-verification **unprompted** at the end — the trigger was not noticing a claim, it was **a recent scar**. **Which makes it fragile: the real test is whether anyone does it on a night that goes smoothly.**
- **H7 (verify seat's instruments least-audited) — CONFIRMED, 9 defects from thoth's audit plus her own self-catches.**
- **H8 (lead states instruments, finds a missing one) — CONFIRMED, three hits within twenty minutes of asking.** Falsifier not met.
- **H9 (grimoire authors in build rounds) — PARTIALLY.** thoth authored (a running ward, canon, 5 commits) **and** performed all nine instrument audits. The audit/author split is not clean, and the scope line was not rewritten.
- **H4 (message budget) — DECLINED with reason**, not tested: a build round's traffic is not comparable to a ratify round's.

**New, each with its falsifier:**

- **N1 (prospero) — the citation mechanism generalises.** *Requiring a CITATION forces a check that requiring a VERIFICATION does not*, because "name the sha" is a blank you cannot leave empty while "verify before you claim" requires noticing you are claiming. **Falsified if** a session adds a citation field somewhere and unverified claims continue at the same rate — in which case the mechanism is the scar, not the blank.
- **N2 (prospero) — pairing beats stating.** Both remedies for the silent-seat problem were required together: *the seat posts mid-flight* AND *the lead checks `ps`*. **Falsified if** either alone prevents a collision next session.
- **N3 (prospero) — the lead's account is the least-audited artifact in a retro.** Two seats struck two items tonight when explicitly invited. **Falsified if** the next retro produces ≥2 unvolunteered lead corrections **without** an explicit invitation — which would mean the invitation was not what did it.

### Structure reflection

- **`cassandra` landed ZERO commits and produced the session's most load-bearing artifacts** — the rig, the injection experiment, the 2×2, six drives, the precondition cell, the structural gate, the termination cell.
- **The lead recorded this as "a measurement gap — no surface shows it." thoth struck that and he was right:** *it was a measurement-**choice** gap, and the choice was the lead's.* `bounty state --owner cassandra` showed her cards; comms showed her posts. **Board, wire, tree and `git log` are all ARTIFACT surfaces, and a verify seat's output is VERDICTS.** The lead had ruled at #235 that a handed-over enumeration must state what it cannot see — **and never applied it to his own dashboard.**
- **Both versions are kept**, because the shape of the lead's error — *generous framing that converts a decision into a circumstance* — is the more useful half.
- **Collisions: near-zero again**, by the same mechanism (lead holds shared docs; seats hold their own). The one near-miss was on `.anthill/README.md`, resolved by an explicit hold claimed on the wire.
- **Composition: four was right. circe correctly unseated for a second consecutive round** — worth asking at the next convene whether the surface seat should be spawned by default at all.

### Q4 — Did this session produce a PRINCIPLE?

**Deferred, deliberately, with the candidate named.**

> **Independence of OPERATOR is not independence of FRAME.**

**Ten instances, and the `ls` convergence is the scar.** It is **not** a restatement of the existing principle: ours says the *feeling* of having covered something is the failure mode and prescribes *"an instrument that does not share your frame."* **Tonight showed a self-authored instrument is not automatically such an instrument** — three of them shared a frame nobody chose deliberately.

**Not promoted tonight, on the SOP's own rule: the pressure to generalise peaks exactly when you have just been burned, and the lead was burned seven times in six hours.** **The next session rules on it** — as a principle, or as an SOP practice if it proves tool-local.

---

## 2026-08-05/06 — spell-hardening, the P0 ratify round

**Seats:** prospero (lead) · daedalus (engine) · thoth (grimoire) · cassandra (verify). circe deliberately unseated — no surface work arose, and all four seats independently called that correct.
**Scope:** ratify the P0 family of `docs/projects/spell-hardening/plan.md`. **Not** build it.
**Outcome:** P0 family ratified; six claims in the plan falsified; one unplanned build (P0e) admitted as a named exception; an independent review before wrap found two more.
**Gate at close:** 1291 pass / 0 fail, biome clean.

### Q1 — What went well

**Answered with artifacts, per the rule. The executable claims:**

- **The ratify round falsified SIX things in a plan written by one author** — P0c step 5 (empty target set) · P0c's blast-radius table (wrong in both directions) · D3's corrective verb (destructive) · #84's mechanism (not an `await` bug) · P0d's gate (an inverted control) · `HANDOFF.md` (two stale claims, one destructive). Evidence: the doc commits on `fix/spell-hardening`.
- **The single strongest result: P0d's gate was an INVERTED CONTROL** — its plain reading fails a *correct* fix, so it would have dispatched the engine seat to "fix" `applyTaskAdd`, which was already right. **One prevented defect, with a name.**
- **Every ratify verdict the engine seat posted was a measurement, and three of four corrected the plan.**

**The deflation, reached independently by all four seats and recorded because a unanimous Q1 is a smell:**

> **None of the independent review's findings were caught by the four of us checking each other. It took an outside reader given no frame.** Whatever we did well, it was not sufficient.

### Q2 — What didn't

**The lead's list is the longest, deliberately — a retro where the lead comes out clean is a retro that did not run.**

**Lead (prospero):** ruled past the evidence twice (both caught by seats) · reported a write as "confirmed by read-back" without reading back · built a mechanism out of a timestamp collision · **wrote a false mechanism into `plan.md` that propagated to three seats**, into an upstream draft whose top-ranked fix was unimplementable because of it · **adopted a falsification and never landed it — six hours of HEAD asserting a mechanism already agreed wrong** · called an upstream draft "send-ready" having checked only the one claim its author flagged · **had no board tail for the entire session while ruling on the seats' blind ones** · left a seat idle holding a ruling never turned into a card.

**Instrument failure rate.** The grimoire seat: **five instrument failures, all in checks written to verify other things** (static-import grep blind to `await import()`; `process.argv` grep blind to `Bun.argv`; a bad cwd returning six zeros; a case-sensitive miss; an unbounded substring matching bundled React). **Two produced false findings; one was caught only by the external reviewer.** The engine seat: **enumeration method failed four times.** *These are counts, not impressions.*

**The P0e fix shipped 2-of-5 complete through THREE separate verifications** — the author's, the verify seat's mutation test, and the lead's land.

**Process costs.** 145 messages for a six-card ratify round; nobody can say how many were load-bearing, **and that is the actual complaint — we have no way to tell.** A long origin hunt produced no origin (four hunters, four confident, four different answers); it yielded a good methodological finding, **which is a consolation prize and should not be laundered into a success.** The board died twice, both times from running the project's own gate.

**The near-miss that most deserves recording:** the verify seat's sixth drift was found **only because the lead instructed everyone to assume drift.** Left to her own judgement she would have skimmed and passed. **The ritual caught what the seat would not have.**

### Q3 — Hypotheses for the next session to test

**H1 (thoth) — the `landed: <sha>` column.** *Adding a landed-sha column to the ruling/answer table will drive adopted-but-unlanded rulings to zero.*
**Falsified if** a ruling still fails to land with the column present — in which case the hazard is not tracking but that **landing is a separate act nobody is assigned**, and the fix is an owner per ruling.
*Grounds: 1 of 6 adopted falsifications never reached the artifact, with no signal on the miss.*

> **⚠ STILL UNTESTED — and its author reported it falsified. He was nearly right and the distinction matters.**
> A **third** adopted-but-unlanded instance occurred in the last ten minutes of the session, **after the class had been named and the fix proposed** — the ruled principle itself sat written-but-uncommitted while `retro.md` was already landed.
> **But H1's own falsifier says _"with the column present"_, and the column was never added.** So H1 is **not falsified; it is untested**, and the next session still owes it a real trial.
> **What the third instance IS strong evidence for is the adopted principle** — naming a failure class, proposing its fix, and then committing it again inside the same hour is precisely *the feeling of having covered it.*
> _(A fourth seat then corrected the alarm itself: the file was **written and uncommitted**, not empty — an inaccurate alarm costs a lead real work, and the correction came from a seat that had already stood down.)_

**H2 (thoth) — bounded checks.** *Requiring every check to state its scope and denominator ("N entry points examined, source only, word-boundary") will catch instrument failures before they become findings.*
**Falsified if** the rate holds — in which case the hazard is that **the person writing a check is the wrong person to bound it**, and checks need a second pair of eyes like code does.

**H3 (cassandra) — "assume it has drifted" vs "re-read your doc."** *The assume-drift framing finds ≥1 drift per seat; a plain "re-read and update" finds ~0.*
**Stands as filed. NOT falsified.**

> **⚠ This entry was twice about to be written down wrong, and the sequence is worth more than the hypothesis.**
> Its author reported it *"already partially falsified"* on the strength of thoth's clean doc as a zero. **thoth then established his own data point is CONFOUNDED** — his doc carried no inherited pins and he had re-derived its claims hours earlier for unrelated reasons — **so it is an exclusion, not a zero.** With it excluded, **the falsifying evidence disappears and H3 was never falsified.** Its author then corrected her own correction, saying so explicitly: *"do not write 'falsified' into `retro.md`."*
> **Both corrections arrived from seats that had already stood down**, sent deliberately, to stop a wrong claim entering this file. **The lead had already written the wrong version.**

**Evidence:** cassandra **2 drifts** · daedalus **2 drifts** · thoth **EXCLUDED (confounded), not 0**. n=2 seats, both ≥1 — **consistent with H3, and a weaker test than it looks**, since the excluded seat is the only one that could have produced a counter-example.

**H4 (thoth, low confidence, filed anyway) — a message budget would improve signal.** *"I half expect this to come back wrong, because the messages that looked like overhead — the self-corrections, the crossed probes — are where several real findings came from."* **Worth testing precisely because its author would bet against it.**

**H5 (daedalus) — verification-by-mechanism is structurally blind to bypass.** *A verification that re-runs the author's stated mechanism cannot find code that BYPASSES that mechanism; this is structural, not effort.*
**Test:** for one fix, run both a mutation test on the mechanism **and** a source-scanning guard over the whole file. **Prediction: the guard finds ≥1 site the mutation test cannot reach.**
**Falsified if** it finds nothing across two rounds — which would mean the P0e gap was carelessness rather than a limit of the method, *"the more comfortable answer, and I do not expect it."*

**H6 (cassandra) — the remedy triggers on noticing.** *`git show HEAD:<file>` will NOT stop the claim-without-verifying failure, because it triggers on noticing you made a claim.*
**Prediction:** next session produces ≥1 unverified claim about landed content even with the rule in the SOP. *Grounds: 4 of 4 seats did it tonight and none experienced it as a claim.*

**H7 (cassandra) — the verify seat's instruments are its least-audited artifacts**, and this recurs regardless of who holds the seat.
**Prediction:** next session's verify seat ships ≥1 verification whose instrument cannot see the failure it was aimed at.

**H8 (prospero) — a lead who states their armed instruments at convene will surface a missing one within the session.**
**Falsified if** a lead states them, still has a gap, and it survives to the wrap — in which case **nobody audits the lead's instruments** and the fix is to assign a seat to it.
*Grounds: n=1. The lead's missing board tail was invisible on every surface — a board with nothing watching it looks exactly like a calm board — and was found by the human asking.*

**H9 (thoth) — the seat's real shape.** *The grimoire seat audits during ratify rounds and authors during build rounds.*
**Falsified if** his next seating is also ~90% verification — in which case the scope line in `config.json` is simply wrong.

### Structure reflection

- **Collisions: essentially zero, and it is a claim about shape rather than a compliment.** `git log --name-only` shows **no file on this branch with two seat trailers**. The mechanism was one rule: **the lead holds every shared document exclusively; seats hold only their own.** `waitedMs` under 0.15 on every land.
- **The overlap that did occur was on VERIFICATION EFFORT, not artifacts** — four seats fired peer-write controls at a wire already proven by backfill. *"That is a much better problem than the usual one and I would not redesign for it."*
- **The seam that actually failed was not between two seats — it was between a RULING and an ARTIFACT.** A verdict adopted on the wire is not a verdict landed, and nothing tracked the gap. This produced the session's last defect.
- **A seam nobody designed: authorship ≠ exposure.** All three seats first reported their review surface by commit authorship and **all three under-reported**, because the lead lands shared docs. The real boundary is *"what would I have to defend"*, and it cuts **across** commits, not along them. **Findings were therefore routed by substance, not by commit author.**
- **⚠ Scope divergence, reported by every seat and the strongest structural signal of the session:**
  - **thoth (grimoire):** *"Files in my stated scope I touched: ZERO."* Never opened house-style, the decay-ledger, or the trigger-registry. Spent the session measuring parsers and auditing entry points. **Described as a librarian, worked as an auditor.**
  - **cassandra (verify):** stated scope is cold-agent usability and driving the assembled spell. **There was no assembled spell to drive.** She audited documents and verified other seats' tests. *"The verify seat has two modes — drive the artifact / audit the claims — and its doc only describes one."*
  - **daedalus (engine):** *"My real output was VERDICTS, not code"* — four ratify cards, one build.
  - **Two readings, unresolved on purpose:** either the scope lines are stale, **or a ratify round is simply a phase in which every seat audits** and a build round is where they author. **H9 tests exactly this**, and no scope was rewritten tonight because the second reading is live.
- **Composition:** four was right; circe correctly unseated.

### Q4 — Did this session produce a PRINCIPLE? **YES — one.**

Landed in [`principles.md`](./principles.md), which had been empty until now.

> **Knowing a failure mode does not immunise you against it, because the failure mode is the FEELING of having covered it.**

**Two other candidates were argued FOR by their authors and then rejected, in each case partly by the author:**

- *verify-don't-recall* and *the-author-is-the-worst-reader* — **already this team's operating premise**; the project's own HANDOFF opens with the second. **Promoting what we already believed, on a night that confirmed it, is how a principles file fills with things nobody had to learn.**
- *"a check has a blind spot you will not find by being careful"* (thoth) — **not rejected, subsumed.** Its author made adoption conditional on its being the same shape as the other seats' failures; **it is, and the adopted principle is the general case.** It lives on as the grimoire seat's own lesson.

**One principle from a session this long is the right number.**
