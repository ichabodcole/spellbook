# Sprint 05 — the cold reconstruction, in full

**Run:** 2026-08-10, at the merge · **Method:** a fresh agent given **the branch
and the base and nothing else** — no session log, no summary, no framing — and
asked to write the merge message · **Project:**
[Spell Hardening](../../README.md) · [outcome.md](./outcome.md)

> ⛔ **WHY THIS FILE EXISTS, AND IT IS A FINDING ABOUT THE LEAD.**
>
> Two seats independently bounded their own all-clears with the same question:
> _"you relayed four findings — did the agent's FULL output name anything of
> mine you did not forward?"_ **daedalus asked it first and it caught two more
> on his files. thoth then asked it of himself before the merge rather than
> after.**
>
> **Both were right to ask, and the reason they had to is that I was the only
> one holding the output.** A report read once, by the person who commissioned
> it, who then relays a filtered summary — that is
> [the unclosed unit](../../../../backlog/2026-08-10-the-unclosed-unit.md) with
> the lead as the single point of loss. **Answering each seat individually
> treats the instance. Landing the output treats the class.**
>
> The finalize ritual names this exactly: _"the largest leak is a report's
> recommendations section, and nothing in any ritual pulls from one."_

---

## What the reconstruction was asked for

1. The merge message (subject + body), written from the tree alone.
2. **What could NOT be determined from the tree.**
3. **Where documents CONTRADICT each other or the code.**
4. **Was the sprint's own account sufficient on its own?**

Items 2–4 are the reason the process exists. The message is the pretext.

---

## The eight contradictions, and where each landed

| #   | contradiction                                                                                                                                         | owner                             | resolution                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `plan.md` says **"Ten commits"**; the tree has **33**                                                                                                 | prospero                          | ✅ fixed `36e20dc`                                                                                                                                    |
| 2   | **`s5-9` names two different defects** — `roster-drift.test.ts` uses it for mind-mapper, `plan.md`/`retro.md` for `bounty update --stdin`             | thoth (file) / prospero (cause)   | ✅ repointed at a **file**, not a card id                                                                                                             |
| 3   | mind-mapper pinned as **DEBT** whose _"pin cannot outlive its reason"_ — the reason became a ruling that the state is **correct**, same day           | thoth                             | ✅ restated as deliberate WIP                                                                                                                         |
| 4   | Sprint 05 merging with **no `outcome.md`**, status still `ACTIVE` — the **fourth consecutive** instance                                               | prospero                          | ✅ written at the merge                                                                                                                               |
| 5   | **"the gate" is TWO THINGS** — `bun test` (1447/109) and `bun run check` (biome, 356 files). Two commit subjects claim a delivery under the wrong one | thoth `ababf0b` · circe `32d1cae` | ◐ **PARTIAL at time of writing** — thoth's landed `25f07b2`; circe's was still pending. Corrected forward, never reworded (see the count note below). |
| 6   | `roadmap.md` calibration constraint contradicted itself mid-branch (`ISOLATED COPY` → amended)                                                        | prospero                          | ✅ resolved in-branch; **part of the sprint ran under the wrong rule**                                                                                |
| 7   | README reconciliation line stamped at `ea0b34b`, **twelve commits before** the fix it reports                                                         | prospero                          | ✅ annotated — the sha names when the sweep RAN, not when the repair landed                                                                           |
| 8   | `PROJECT-SUMMARY` says **seven shipped spells** while `spellbook-v2.2.0` ships mind-mapper's `dist/`                                                  | —                                 | ⚠ **OPEN** — a packaging question, awaiting Cole                                                                                                      |

---

## What could NOT be determined from the tree — verbatim scope

**This is the half that does not get fixed, and it is the more useful half.**

- **The bounty board is gone and it was load-bearing.** Card ids (`s5-1`…`s5-9`,
  `c1`, `C′`) are cited across code comments, docs and commit bodies.
  **`retro.md` carried `s5-1`–`s5-4` with no definition anywhere in the tree.**
  → **Remedied by [`carries.md`](./carries.md)**, all nine rescued verbatim.
- **The comms channel is gone too.** Message ids (`#978`, `#1010`, `#1042`, …)
  are cited as evidence for specific claims and **resolve to nothing.** Every
  claim resting on one is testimony. **Not remedied — recorded.**
- **Cole's scope ruling exists only as relay.** _"Ruled by Cole, in
  conversation."_ Unverifiable from the tree.
- **Almost every number is unreproducible**: 436 tsc errors / 61%; 46-vs-30
  cells; 4,182 vs 4,166 lines; `0 true positives, 2 false, 26 of 33`; the
  `--as-of` refusal counts. **Only 1447/0/109 and the 16-file blind set were
  checkable, and the agent checked those.**
- **Seat-to-commit attribution beyond the trailer.** Every commit's git author
  is `Cole Reed`; seats are visible only via `Anthill-Seat:`. Whether a seat
  wrote the code or the lead committed on its behalf is **not determinable.**
- **Whether anything was verified beyond the automated gate.** No test plan, no
  verification record, no session doc.
  > ⭐ **The verify seat took this one as HERS rather than the reader's, and it
  > is the sharpest item in the reconstruction:** _a verify seat that reports on
  > the wire has produced no evidence a month from now._ Her findings live in
  > comms messages this same file says **resolve to nothing**, plus two seat-doc
  > sections and one backlog file. **The remedy is not more messages — it is
  > that every hand-verification lands as a runnable instrument or it did not
  > happen.** `gate-blind-set.ts` and the r8 scanner are the two that got it
  > right, and **neither was hers by default; both landed because someone
  > insisted.**
- **The `r8` RED set is DERIVABLE, and the cold reader's wording collapsed two
  states.** ⛔ This line originally read _"has no artifact"_. **The SET has
  one:** `bun scripts/instruments/r8-outcome-check-v3.ts` reproduces **113 RED /
  11 GREEN** from `HEAD`, with its filters printed above the result and the file
  committed. **What has no artifact is the CLASSIFICATION** — which of the 113
  are defects was never decided, **deliberately**, because the count is inflated
  by a by-name mutator list and nobody was permitted to turn it into a scope.
  _"Has no artifact" sends a reader to rebuild an instrument that already
  exists; the truth is one command and then start classifying._ **A dead end
  versus a starting point** — corrected by `cassandra`, who declined to edit
  this file mid-merge and handed over the wording instead.
- **`type-sentinel-probe.ts` hardcodes an absolute path** and will not run on
  another machine. ✅ fixed.

---

## Was the sprint's own account sufficient? — **No**, and the specifics

The agent judged `plan.md` **"a good scope-and-ruling record and a poor
deliverable record."** What it could not get from the plan alone:

- **That row 2 is half solved** — `terminator-invariant` handles **promotion**,
  not **demotion**, which is the live half. _"A reader of the plan would think
  row 2 is closed."_
- **The single most consequential design decision in the sprint's code** —
  `strict-parse-invariant` is deliberately **not** the behavioural drive the
  roadmap specified, because a daemon outranks a spell's home env var. **It
  existed only in a test-file comment.**
- **That an existing ward changed** — `flag-invariant` was refactored onto the
  shared enumerator, replacing a glob that was a latent silent filter.
- **The blind set's size** — 16 files / 4,166 lines, only in the ward and the
  instrument.
- **The `?.` canon-vs-linter conflict** — biome **requires the erasing form at
  error severity**, so the canon-compliant idiom fails `bun run check`. Live and
  unresolved; the plan mentioned it only obliquely as a deferral.
- **The calibration-harness finding** read as a scheduling note rather than _"a
  mandated method was silently under-testing by a third."_

✅ **All six are now in [`outcome.md`](./outcome.md) or the plan's correction
block, in the cold reader's wording rather than a paraphrase.**

---

## The standing conclusion

**Three of the eight contradictions were the lead's documents. Two were commit
subjects that overstated a delivery. One was an id collision the lead created
hours after a seat had used the id.** None was found by anyone who worked on the
sprint.

> ⛔ **THIS FILE ASSERTED A FIX THAT HAD NOT HAPPENED.** Row 5 read
> `✅ corrected forward` while only **half** of it was landed — thoth's at
> `25f07b2`, circe's still awaiting clearance. **circe caught it, in a committed
> file, minutes after it landed.** A ✅ in a table is a claim about the tree,
> and this one was written from intent rather than from state. Corrected to `◐`.
>
> ⚠ **AND THE "8 SHAS" FIGURE IN THAT ROW WAS MINE AND IT MOVED.** `land-check`
> reported **8** cited shas when first run and **11** by the merge — the branch
> kept committing, and citations grew with it. **The number propagated into two
> of my documents, a landed commit message, and a ward header before anyone
> re-derived it.**
>
> **The lesson is not "it was 11".** It is that a count taken from a tool at one
> moment, quoted later as a bare figure, is stale by construction on a branch
> that is still moving. **Do not hardcode it — run `bun scripts/land-check.ts`
> and read what it says now.** _(Sixth moving count this session.)_

> **A fresh agent reading the tree is doing what a future reader will do. If it
> cannot write a good message from the artifacts, that is a finding about the
> docs, not about the agent.** — the `land` skill's own reasoning, earning
> itself. </content>
