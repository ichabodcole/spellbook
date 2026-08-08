# Spell Hardening — roadmap

**Updated:** 2026-08-08 · **Project:** [README](./README.md) ·
[proposal.md](./proposal.md)

> ## ⚠ THIS DOCUMENT IS A FORECAST, NOT A PLAN
>
> **Nothing past the current sprint is committed.** A sprint becomes real when
> it is scaffolded (`plan.md`, status 🟡) and buildable only when a convene's
> ratify round has survived it. **Three ratify rounds have killed six, two and
> six claims respectively** — including, in sprint 03, the predicate every lane
> was about to be built on. **A forecast written here has not been through that
> and should be read as the author's current guess.**
>
> **What it is for:** a signpost, so the next convene inherits a shape instead
> of a blank page, and so parked work has somewhere to be seen rather than being
> rediscovered.
>
> **Read it back at every convene and say which parts still hold.** That is the
> only check it gets, and it is the same mechanism the retro's Q3 hypotheses
> use.

---

## The end condition — what "done" means

**This project does not end at zero defects.** It ends at the point where **a
new spell cannot ship a new instance of an old defect.**

The argument, measured: two of the largest closures were cross-spell — `#81`
(`--flag=value` silently ignored, **all spells**) and `#84` (`/cmd` returns
`ok:true`, three spells). **The defect population scales with SPELL COUNT, not
with defect count.** Eight spells multiplied by every rule we derive is a
treadmill; one conformance gate retires the class and makes spell #9 inherit it
for free.

### ⭐ RATIFIED 2026-08-08 — the falsifier was run and it FAILED TO FIRE

**This section was "confidence: medium, the least evidenced claim in this
document." It is now the best-evidenced one.** Sprint 04's ratify round drove it
(`r5`, `r8`, cassandra) instead of arguing it.

**The named falsifier — _the rules cannot be expressed as a mechanical check_ —
is FALSIFIED. Three counter-instances ship in this tree today**, two of them
roster-wide and already inside the gate:

| ward                                   | what it proves                                                        |
| -------------------------------------- | --------------------------------------------------------------------- |
| `grimoire/flag-invariant.test.ts`      | roster-wide, **both directions**, zero-denominator guard on each side |
| `grimoire/exit-site-inventory.test.ts` | roster-wide inventory — **identity, not count**                       |
| `scripts/land-check.ts`                | mechanises a **prose rule from `AGENTS.md`**, and _discriminates_     |

**And a purpose-built check convicted a real defect it was never told about:** a
scan keying on _dispatch branch captures a return → the local never escapes into
an outbound payload → the callee is a mutator_ flagged **6 of 302 dispatch
branches**, naming no spell and no path. It convicted imago `context.add`,
**independently rediscovered `#87`**, and **found a defect nobody knew about** —
glamour `gen.add` drops `addItem`'s return, so a silent dedupe returns
`ok:true`. One false positive, and it was **a stateable scope bug** (it flagged
a _browser_ handler, where no caller awaits an envelope) rather than a per-spell
exception — which is the distinction that decides whether a gate survives.

⛔ **THAT IS A PRECISION RESULT AND THERE IS NO RECALL CLAIM. The `6 / 302`
figure is NOT a coverage rate**, and an earlier version of this section reported
it as though it were. **The check keys on _captured_ returns, so it is blind to
every non-capturing call — and that blind set contains both extremes:**

```
bounty  task.add     no capture, REPORTS the refusal with a reason   -> unflagged  ✅ correct
magpie  element.add  no capture, drops the outcome entirely (agent)  -> unflagged  ⛔ wrong
```

**The best behaviour in the house and the most complete drop in the house are
indistinguishable to the instrument.** So the check has been shown to CONVICT;
it has never been shown that its SILENCE means anything. **A rate over a
denominator the check cannot fully see is not a coverage figure.**

⭐ **The green arm exists, and it is the answer to the defect** —
`bounty task.add` is the exact analogue of imago's `context.add` and does the
opposite: `ok: true, applied: false` with
`"task … already exists — the board is unchanged and the existing task kept its id"`.
**That error answers the precise question imago's silent dedupe leaves
unanswerable — _did I just clobber the original?_** The house has a worked
example of the right thing, in the spell we coordinate on.

⚠ **Precision, because the distinction is load-bearing:** none of the three
wards enforces any rule in the sprint-05 table. They enforce **adjacent**
invariants, so the table's `enforced by: nothing` column is **accurate
per-rule**. What is established is the **capability**, not the **coverage**.
_(The earlier version of this document ran those two sentences together.)_

### ⛔ TWO SUPPORTING CLAIMS WERE FALSE, AND ONE CHANGES THE SHAPE

1. **`H-D3` is decoupled — from the gate's EXISTENCE.** `bun run check` is
   **biome**; TypeScript is absent from dependencies entirely — so a repo-wide
   `tsc` gate is _adopting a dependency_, not draining a 398-item queue. **And
   it does not block criterion 2:** both shipped wards run repo-wide today under
   `bun test` and neither type-checks anything. **H-D3 can be TRUE and this end
   condition still reachable.**

   ⚠ **BUT IT RE-COUPLES AT PRECISION, and that is a later decision nobody
   should inherit as settled.** The `r8` check's v3 identifies mutators **by
   name** (`add|create|save|…|push|set`), which sweeps in `arr.push()`,
   `params.set()` and `setTimeout()` — so its 114-of-123 red is **inflated and
   was reported as inflated.** Distinguishing a real mutator from a
   same-named-method requires either **type information** or **per-spell
   knowledge — and per-spell knowledge is precisely what `r8` established a gate
   must not need.** So: **the gate exists without types; a LOW-NOISE gate may
   not.** If that trade is ever forced, adopting TypeScript is a **cost and
   appetite decision — Cole's**, not a wire call. It is not forced yet.

2. ⭐ **The project's own thesis is what makes two of its rules uncheckable.** A
   checker looking at a `0` faces **exactly the ambiguity the rule forbids** —
   it cannot tell _"0 because zero"_ from _"0 because it failed"_ without
   knowing what the code meant. **You cannot mechanically detect that a `0` is a
   lie.** What is checkable is structural: _no catch or early-exit path returns
   a bare `0` or `[]` that a success path could also return._ **That restatement
   is a different rule with a different scope — i.e. a discovery round.**

### THE END CONDITION, RESTATED — two criteria, not one

1. **The population is drained** — no open issue or backlog item in the absence
   / parity / consistency family that blocks another team or us. **A non-blocker
   that is really a _decision about how the CLI should work_ gets decided NOW;
   deferring is what produced this arc.**
2. **The rules exist and are enforced** — `grimoire/house-style.md` carries them
   in its mandatory shape, and a conformance gate **fails** a new violation.

⭐ **AND TWO MORE CLAUSES INSIDE CRITERION 2, both earned on 2026-08-08:**

> **(i) A conformance gate must state what it cannot see.**

Both shipped wards already carry a _"what this cannot see"_ block. Without it,
_"the gate is green"_ is an answer that does not state the question it answered
— and **the arc-end test below is only DECIDABLE if the gate's coverage is
written down.** That is the difference between ending the arc and believing you
have.

> **(ii) Every rule must name the check that enforces it, and every check must
> cite the rule it enforces — bidirectionally, and the link itself is gated.**

**Measured, and it is why (ii) exists:** `bunx biome check` on a `.md` reports
`Checked 0 files` at exit 1, and `bun run check` is biome-only. **The gate
cannot read a single markdown file in this repo** — so `house-style.md`, the
decay ledger, the trigger registry and every sprint plan are outside it. The
tool that _does_ read markdown is `prettier`, which lives in `format:md` and the
pre-commit hook, **not in the gate.** For a docs change the informative check
and the gated check are different tools, and only the uninformative one is named
in the land string.

**That does not sink criterion 2** — a conformance gate convicts _code_, not
prose, so rules living in a file the gate cannot read is survivable. **What is
not survivable is the consequence:**

> **A check written as a `.test.ts` IS gated. A rule written as prose in
> `house-style.md` is NOT. So _"the rule exists"_ and _"the rule is enforced"_
> have NO SHARED MECHANISM, and nothing detects the gap between them.**

A rule whose text drifts from the test enforcing it cannot be caught, because
one half is invisible to the gate. **That is the decay ledger's paraphrase
problem at a higher altitude.**

⭐ **The fix already exists in this repo and enforces a different pair.**
`grimoire/flag-invariant.test.ts` checks `SKILL.md` ↔ entry-point flags **in
both directions with a zero-denominator guard on each side.** Point that same
pattern at rules ↔ checks: **a gated test that reads the prose, extracts the
rule set, and asserts a live check for each — and, in the other direction, that
every conformance check cites a rule that still exists.** The template is built,
battle-tested through three wrong enumerators, and was written by the seat that
found this gap.

⚠ **And a docs-only commit currently earns a VACUOUS GREEN that is
byte-identical to a real one.** The gate's own output must distinguish _"checked
0 files of your type"_ from _"checked and passed"_ — clause (i) applied to the
gate itself, which is where this arc keeps arriving.

### How to tell the arc has ended

**The arc ends when a new inbound report stops being evidence that hardening is
incomplete.** Today every report reads as _"still leaking,"_ because nothing
distinguishes _we have not fixed the known set_ from _the set is unbounded._
Once criterion 2 holds, a new report is either **a rule we had not written**
(scope — decidable) or **a gate miss** (bug — decidable). Neither reopens the
phase.

**Cost, measured rather than hoped: every gate cell needs a confirmed instance,
and for an already-fixed rule that instance must be MINTED BY MUTATION** —
revert the fix in a scratch copy, prove the cell goes red _at the right
assertion_, restore. All six rules were fixed in sprints 01–03, so **a gate
written against them passes everywhere the moment it is written**: six
decorative cells and a green that licenses nothing, in the arc whose thesis is
that a clean answer can be a lie.

**Corroborating, and it is why the calibration is not optional:** the first
draft of the `r8` check reported **186 of 380 (49%)** — well-formed, plausible,
precisely formatted, and wrong, at exit 0. It was caught by the hit rate being
**implausible on its face**, not by review. **The first draft of every such
check will be wrong in a way that reads as authoritative.**

⭐ **AND THE SECOND DRAFT WAS TOO, IN A QUIETER WAY.** One rule took **three**
instrument revisions, each failure a different class:

```
v1  brace-matching / mark-to-mark slicing   -> 49% noise, caught by implausibility
v2  capture-and-drop                        -> convicts (precision OK), but its GREEN is meaningless
v3  must ALSO catch the uncaptured call     -> not yet built
```

**v2 is the instructive one: it works, its hits are real, and its silence still
means nothing.** A cell that can convict but whose clearance is uninformative is
**half-calibrated**, and half-calibrated is the state that looks finished.
**Budget three revisions per rule, not one** — and calibrate each cell in _both_
directions before its green is allowed to license anything.

---

## Now — Sprint 04, "The shape of nothing"

🟡 **SCAFFOLD** · [plan.md](./sprints/04-the-shape-of-nothing/plan.md)

**Thesis:** a consumer must be able to distinguish _"nothing is there"_ from _"I
cannot tell you."_

**Keystone RULED 2026-08-08** — `#82`'s cross-tool spelling is adopted, both
shapes. No longer blocking. The operative test for the team: adopt anthill's
spelling **unless it requires a trade-off other than development work.**

Six instance lanes (`#79`, `#85`, `#86`, `#88`, grapevine `message_count`, and
an unverified `--full`/`?lean=1` no-op) plus one owed cross-team lane (the `--`
terminator, `t-2df67738`). See the plan for what it deliberately excludes.

---

## Next — Sprint 05 (FORECAST), "the gate"

**Not scaffolded. No plan.md. This is a guess with a rationale.**

**Likely thesis:** convert the rules from things we find violations of into a
**conformance gate every spell runs.**

**Candidate contents**, each currently enforced only by our having found each
violation individually:

| rule                                        | derived in                      | enforced by |
| ------------------------------------------- | ------------------------------- | ----------- |
| present-and-null, never absent              | sprint 02 (`#80`, D1.2)         | nothing     |
| `null` not `0` when you cannot answer       | sprint 03 (`snapshotTaskCount`) | nothing     |
| `--flag=value` parses; unknown flags refuse | sprint 02 (`#81`)               | nothing     |
| a no-op is not a failure                    | sprint 04 (`#85`)               | nothing     |
| the exit-code contract                      | sprint 01                       | nothing     |
| free text never promoted to a flag name     | sprint 04 (`C1`)                | nothing     |

### ⛔ IT SPLIT. Ruled 2026-08-08 on `r5` + `r8`.

**The old text said: _"the rules already exist and are written down. The work is
a harness, not a discovery round."_ That is FALSE and it was falsified by the
mechanism it predicted.** Two of the six rules require **intent** to check, so
mechanising them means **restating them** — and a restatement is a new rule with
a new scope, which is a discovery round by definition.

**The "why it might not be" clause was right for the wrong reason.** It guessed
that only half would be checkable across differing spell shapes. **Shape was
never the obstacle** — the `r8` check handled if-chains, switches, a reducer and
an anonymous inline handler without naming any of them. **Intent was.**

| rule                                        | mechanizable?         | as what                                           |
| ------------------------------------------- | --------------------- | ------------------------------------------------- |
| `--flag=value` parses; unknown flags refuse | **yes**               | behavioural drive over the 16 entry points        |
| free text never promoted to a flag name     | **yes**               | behavioural; `flag-invariant` **cannot** see `--` |
| the exit-code contract                      | **partly**            | inventory pinned; correctness needs fixtures      |
| present-and-null, never absent              | **yes, costlier**     | shape check over a live daemon per spell          |
| `null` not `0` when you cannot answer       | ⛔ **not as written** | requires INTENT → restate structurally            |
| a no-op is not a failure                    | ⛔ **not as written** | requires INTENT → restate structurally            |

**SPRINT 05 IS TWO SPRINTS:**

- **(a) the harness.** First act: **extract `flag-invariant`'s behavioural
  enumerator as a shared module** — do not write new scans against a glob. Then
  mechanise the three behavioural rules, **mutation-calibrating every cell.**
- **(b) the restatement.** Turn the two intent-bearing rules into structural
  predicates. **It gets its own ratify round.** A discovery lane that inherits a
  harness's schedule is how a sprint lies about its size.

### ⛔ A HARD CONSTRAINT ON HOW (a) IS RUN — measured 2026-08-08, not anticipated

> **Mutation calibration happens in an ISOLATED COPY, never in the shared tree.
> If a mutation must touch the shared tree, it is ANNOUNCED before and cleared
> after — the window is the announcement, not the mutation.**

**Why this is a constraint and not hygiene.** Sprint 04 logged three separate
"gate contention" incidents — a seat blocked behind a peer, a gate red on a
peer's in-flight tests, and two seats measuring RED and GREEN on the same
artifact minutes apart. **All three turned out to be one mechanism, and it was
not scheduling:** a seat was deliberately breaking code to prove a cell could
fail.

**A seat mutating to calibrate is INDISTINGUISHABLE, to every other seat, from a
broken tree.** Same red, same files, same gate. The discriminator — _this red is
intentional and mine_ — exists only in the mutating seat's head.

**Sprint 05 (a) requires mutation calibration for EVERY cell.** That is not one
window, it is dozens. **On a shared tree, the sprint would spend most of its
wall-clock looking broken to everyone not currently mutating** — every peer gate
run a false red, every peer land blocked or misattributed.

_(The requirement's original wording already said "revert the fix in a scratch
copy." That read as fastidiousness. Sprint 04 established it is what makes the
sprint runnable at all — one incident is a nuisance, dozens is a sprint that
cannot report its own state.)_

⚠ **THE DENOMINATOR IS THE TRAP, AND IT IS ALREADY SOLVED — REUSE IT.**

```
entry points by PATH      (skills/*/scripts/cli.ts)             ->   7
entry points by BEHAVIOUR (parses args: strict/allowPositionals) ->  16
```

**A path-based gate is blind to 9 of 16 — including ALL of `digestify` (its
entry point is `review.ts`) and every `server.ts`.** That is house-style's own
`63 vs 37` scar reproduced on the gate question. `flag-invariant` already
enumerates by behaviour and **survived three wrong enumerators to get there.**

⚠ **This forecast still has a known bias**, now partly discharged: the end
condition it serves was **cold-read and driven by the verify seat**, not by its
author. **The sprint-05 (a)/(b) split is cassandra's recommendation, adopted —
not the author's forecast surviving.** The scaffold itself is still unwritten
and should be drafted or cold-read by someone with no stake in it.

---

## Parked — real, measured, and deliberately not scheduled

Visible here so it is not rediscovered. **Parked is not "next"** — an item moves
only by being scaffolded into a sprint.

| item                                                                               | size                                    | why parked                                                                                                  |
| ---------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [tmpdir leak, house-wide](../../backlog/2026-08-08-tmpdir-leak-house-wide.md)      | 15,623 dirs; bounty 12,830 (5,085 live) | **Needs an afternoon, not a sprint** — one `rm -rf` of the suite root at `afterAll` is the whole bounty fix |
| [grapevine channel janitor](../../backlog/2026-08-08-grapevine-channel-janitor.md) | 5 ad-hoc steps, none a grapevine verb   | A feature, not a defect                                                                                     |
| `mind-mapper` absent from all 4 synced listings                                    | —                                       | **A roster question for Cole**, not sprint work                                                             |
| `#72` `#75` `#11`                                                                  | —                                       | Features / cosmetic; not this project's family                                                              |
| `#76`                                                                              | —                                       | A real defect, unratified, no family                                                                        |

---

## Not in the forecast, and why

- **`#64`** is not scheduled because it is **not ours to close** — anthill runs
  the pre-registered measurement at their next convene and reports either way,
  including _not tested_.
- **The two principle candidates** from the 2026-08-08 wire (ambiguous absence;
  reason-rot) are **anthill's to ratify**, not sprint lanes.
- **Anything from a future investigation.** The project has filed **more issues
  than it started with** (12 during, against 9 pre-existing), so the honest
  position is that looking produces findings and this document cannot forecast
  them. **That is not a gap in the roadmap; it is the roadmap's boundary.**

---

## Meta — why this file exists, and what it is a precursor to

The `CARRY-FORWARD → sprint N+1` section in a sprint's `outcome.md` is the
existing handoff and it stays. **It is not sufficient on its own for three
reasons:** it fires only at sprint close, so nothing exists during the sprint;
it carries **deferred lanes** rather than a **thesis**; and sprint 03 shipped
without an `outcome.md`, so the chain is currently broken.

**This file is also a deliberate cheap test of
[the project-roadmap-surface fragment](../../fragments/2026-08-05-project-roadmap-surface.md)**
(Cole, 2026-08-05), which asks exactly these questions — _what's the roadmap,
what are the next several sprints, what goes in them_ — and proposes a surface
to answer them. **If this shape holds as prose across a couple of projects, that
surface has a schema to render. If it goes stale and nobody updates it, that is
evidence about whether the surface is worth building** — and cheaper to learn
here than after.
