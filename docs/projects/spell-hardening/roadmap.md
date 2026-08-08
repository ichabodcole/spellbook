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

**Confidence: medium.** It is the most load-bearing claim in this document and
the least evidenced. **What would falsify it:** a sprint-04 ratify round finding
that the rules cannot be expressed as a mechanical check — in which case the end
condition is a convention plus review, and the project is longer than two more
sprints.

---

## Now — Sprint 04, "The shape of nothing"

🟡 **SCAFFOLD** · [plan.md](./sprints/04-the-shape-of-nothing/plan.md)

**Thesis:** a consumer must be able to distinguish _"nothing is there"_ from _"I
cannot tell you."_

**Blocked on:** `#82`'s cross-tool spelling — **Cole's ruling, not a lane.**

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

**Why it is plausible as one sprint:** the rules already exist and are written
down. The work is a harness, not a discovery round.

**Why it might not be:** nobody has established that these are mechanically
checkable across eight spells with different shapes — three conjurations with
daemons, cantrips without. **If the ratify round finds only half are checkable,
this splits.**

⚠ **This forecast has a known bias.** It was written by the same author who
proposed the end condition it serves. **A sprint-05 scaffold should be drafted
by someone else, or cold-read before it is ratified** — the no-stake-reader
finding from 2026-08-08 says the author is the least able to see this.

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
