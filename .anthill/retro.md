# Retro — newest first

Written by the lead at `anthill:finalize-session`, from the seats' answers on the wire.
**Every Q3 answer is a hypothesis the next session can test.** The next convene reads them back and says which it will test — **a prediction that comes back wrong is the valuable outcome.**

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
