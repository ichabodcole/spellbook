# Sprint 04 — The shape of nothing

**Created:** 2026-08-08 · **Status:** 🟡 SCAFFOLD — **not ratified, not
buildable** · **Base sha:** `e22b281` (`develop`, unpushed) · **Branch:** not
cut · **Project:** [Spell Hardening](../../README.md) ·
[proposal.md](../../proposal.md)

**Predecessor:** sprint 03 has **no `outcome.md`** — read the named merge commit
**`88a298f`** and
[sprint 03 decisions](../03-what-close-takes-with-it/decisions.md) instead, plus
[`.anthill/retro.md`](../../../../../.anthill/retro.md).

> 🟡 **THIS IS A SCAFFOLD. Every claim below is the author's, unratified, and
> written to be falsified.** Sprint 01's ratify round killed six claims; sprint
> 02's narrower one killed two; sprint 03's killed six including the predicate
> every lane was about to be built on. **Assume this document is wrong somewhere
> and find where.**

---

## The thesis

> **A consumer must be able to distinguish _"nothing is there"_ from _"I cannot
> tell you."_ When absence is ambiguous, `0` — or an omitted field, or a
> non-zero exit — is the wrong sentinel.**

This is not a new idea being proposed. **It has been independently derived four
times in one week by four routes, and enforced zero times:**

| where                              | what it said                                                               |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `spellbook` D1.2 (sprint 02, #80)  | `restoreSkipped` present-and-null, never absent                            |
| `bounty` `snapshotTaskCount()`     | `null` **not** `0` — "zero would mean it exists and holds nothing"         |
| `anthill` `seams.md` Contract 6(c) | `gap: null` = "the tool has no idea", may never be a rounded-down `0`      |
| the `anthill-spellbook-r2` wire    | _a mechanical guard whose output lives only in the terminal…_ (2026-08-08) |

**Four derivations, zero enforcement, and a fifth instance found today** —
`grapevine list` reporting `message_count: 0` for 57 of 57 unloaded channels,
into a janitor choosing between `archive` (preserves) and `close` (**deletes**).

## Why now rather than later

**Because the rule is settled and the SPELLING is not** — that is
[`#82`](https://github.com/ichabodcole/spellbook/issues/82)'s argument, raised
from the anthill side, and it is the thing that decays. Two toolchains agreeing
on a rule and disagreeing on its wire format produces a divergence that gets
more expensive every sprint, and **both are still small enough to change.**

---

## The keystone — `#82`, and it is COLE'S RULING, not a lane

`#82` asks: when a CLI is asked to do something and does not do it, **how do the
two toolchains say so, and can they say it the same way?**

**Nothing below should be built before that ruling exists.** Every lane is an
implementation of a vocabulary, and implementing five spells against a
vocabulary that then changes is the most expensive available ordering.

⚠ **The scaffold's own claim, offered to be falsified:** that `#82` is a
prerequisite rather than a parallel lane. **If the ratify round finds the lanes
are separable from the spelling, this ordering is wrong and the sprint gets
wider and faster.**

---

## Proposed lanes

**Unratified. Sizes are guesses. The issue numbers are real; the groupings are
the author's.**

### A — the vocabulary (blocked on `#82`)

| lane   | source | claim                                                                                                                                              |
| ------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A1** | `#82`  | Ratify one cross-tool spelling for _asked-for-didn't-happen_ and _done-but-not-how-you'd-assume_. **Deliverable is a written contract, not code.** |
| **A2** | —      | Encode it in `grimoire/house-style.md` with the shape that file requires: **imperative + boundary check + repeal criterion.**                      |

### B — the instances (each is a claimed member of the family; each is falsifiable)

| lane   | issue                                                                              | the ambiguity                                                                                                                                        |
| ------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B1** | [`#79`](https://github.com/ichabodcole/spellbook/issues/79)                        | `bounty list` lists **boards, not tasks** — an empty result reads as "no cards"                                                                      |
| **B2** | [`#85`](https://github.com/ichabodcole/spellbook/issues/85)                        | `astrolabe` — a benign **no-op exits non-zero**; `running` is absent exactly when the daemon is up. `bounty` treats the identical payload as success |
| **B3** | [`#86`](https://github.com/ichabodcole/spellbook/issues/86)                        | `grapevine roll` skips its version verify on the cold path, and **`version_ok` cannot say "unknown"**                                                |
| **B4** | [`#88`](https://github.com/ichabodcole/spellbook/issues/88)                        | `digestify` — a cancelled/timed-out review writes **nothing to stdout**; "the human declined" is unobservable through a pipe                         |
| **B5** | [backlog](../../../../backlog/2026-08-08-grapevine-list-message-count-unloaded.md) | `grapevine list` `message_count: 0` for unloaded channels — **57 of 57 after a roll**, feeding a destructive verb                                    |
| **B6** | —                                                                                  | `bounty` `state --full` / `?lean=1`: `cli.ts` sends the param at two sites, **`server.ts` has no handler** — the flag is a no-op                     |

**B5 has a known-good implementation in this repo already** —
`snapshotTaskCount()` — and porting beats re-deriving. **B6 is unfiled and
unverified beyond a grep; it may be a documentation defect rather than a code
one.**

### C — not this family, carried because it is owed

| lane   | source       | why it is here                                                                                                                                                                                                                                               |
| ------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **C1** | `t-2df67738` | The `--` terminator eats `--session-key`; the write lands on the ambient board at **exit 0**. **anthill hit the identical defect (`anthill#102`) and has given us three rules to implement against; we owe them our refusal text before they write theirs.** |

**C1 is a real cross-team commitment with a named counterparty.** It is in the
absence family only loosely — its defect is silent absorption, not ambiguous
absence — and **the ratify round should consider cutting it to its own sprint
rather than letting it dilute the thesis.**

---

## Not in this sprint

- **The tmpdir leak** (15,623 dirs house-wide; `bounty` 12,830, of which 5,085
  live). Real, measured,
  [documented](../../../../backlog/2026-08-08-tmpdir-leak-house-wide.md), and
  **not this thesis.** One `rm -rf` of the suite root at `afterAll` is the whole
  bounty fix; it does not need a sprint, it needs an afternoon.
- **The grapevine channel janitor** — a feature, not a defect.
- **`mind-mapper` absent from all four synced listings** — a roster question for
  Cole, not sprint work.
- **`#87`, `#76`, `#72`, `#75`, `#11`** — `#87` (imago mints an id and discards
  it) is arguably B-family and was **left out deliberately so the ratify round
  has to decide it rather than inherit it.**

---

## Inherited state — measured, not remembered

**The project's population, measured 2026-08-08 rather than quoted:**

```
issues #64–#88 touched by this project:  21
  pre-existing (before 2026-08-05):       9   → 5 closed, 4 open
  filed DURING the project:              12   → 6 closed, 6 open
                                         ──
  total                                        11 closed, 10 open
```

**The project has filed more issues than it started with**, and that is the
method working rather than failing. **But the shape is converging even though
the count is not: 8 of the 10 still open are the absence family**, which is why
this sprint has a thesis available at all.

⚠ **The count systematically undercounts what we find.** Our own findings route
to `docs/backlog/`, not to issues (issues are inbound from other teams). Sprint
03's P1d–P1f and today's two grapevine items are invisible to the table above.

⚠ **`README.md`'s issue ledger is WRONG and I wrote it today.** It says **"Six
remain"** and then lists **nine** issue numbers, and its `14` denominator is a
curated set that cannot be reconstructed from the tree. **Fixing it is lane A0
or a pre-sprint chore; it is a miscount inside a section about miscounting.**

---

## Does this project end? — a projection, offered to be wrong

**The original thesis is nearly done.** Six of the eight closures are
success-shaped lies. What remains is largely one family, which is the whole
argument for this sprint.

**What would make it never end:** the two biggest closures were cross-spell —
`#81` (`--flag=value` silently ignored, **all spells**) and `#84` (`/cmd`
returns `ok:true`, three spells). **The population scales with SPELL COUNT, not
with defect count.** Eight spells × every rule we derive is a treadmill.

> **⭐ THE PROPOSED END CONDITION — and the sprint 05 candidate.** The project
> ends not at zero defects but at the point where **a new spell cannot ship a
> new instance of an old defect.** Every rule we have derived —
> present-and-null, null-not-zero, `--flag=value`, the exit-code contract,
> no-op-is-not-failure — is currently enforced by our having found each
> violation individually. **One conformance gate every spell runs retires the
> class and makes spell #9 inherit it for free.**
>
> **So: sprint 05 is likely, and it should be the GATE, not more lanes.** Sprint
> 04 finishes the family; sprint 05 makes the family unrepeatable. That is the
> light at the end, and it is two sprints out rather than indefinite.

---

## The roster — redraw at convene, ruled by Cole 2026-08-08

**Two halves with opposite lifetimes. Do not treat them as one decision.**

### Durable — the gate has no owner

Measurement design has been unowned for **two sprints** while producing most of
sprint 03's value. `thoth`'s reframe: **the collisions were never about scope,
they were about the gate, and no seat owns it.** Every phase has a gate, so this
does not expire.

### Phase-scoped — and this is CONTEXT, not a prediction

`circe` has been unseated five consecutive rounds; `daedalus` took 5 of 6 lanes
a third sprint running. **Cole's reading, recorded here because a future reader
will otherwise misdiagnose it:**

> The last several sprints have been **foundational CLI standardization** —
> triggered by other teams actually deploying these spells, using the CLIs hard,
> and reporting the footguns their own processes surfaced. Before that, the work
> was **building new spells**, which is UI-heavy and used the full team. **A
> surface seat idling through an engine phase is not a misfit; it is a seat
> correctly not inventing work.** The focus is expected to shift back, and the
> roster may want redrawing again when it does.

**Deliberately NOT written here: a revival trigger.** A repeal criterion belongs
on a **rule** — something applied repeatedly by people who were not there. A
roster is a **state**, re-evaluated from scratch every session by
`anthill:finalize-session` step 4, which is a ritual beat and not a remembered
discipline. **It needs provenance, not a prediction.** Cole's argument, and it
corrected the author's: _pay attention to the current state rather than try to
predict the future state._

**This is the anthill thesis working as designed** — the ants shape the anthill
and the anthill shapes the ants. The redraw is the structure responding to the
work, not a correction of a mistake.

---

## Open questions — for the ratify round

1. **Is `#82` genuinely a prerequisite, or a parallel lane?** The whole ordering
   rests on it. **Falsify this first.**
2. **Is `#87` (imago mints an id and discards it) in the family?** Left out on
   purpose. An id that is minted and discarded is a _lost value_, not an
   _ambiguous absence_ — or is it the same thing seen from the producer's side?
3. **Should `C1` be cut to its own sprint?** It has a named counterparty waiting
   and it dilutes the thesis. Two goods in tension.
4. **Is `B6` real?** Established by grep only. `cli.ts` sends `?lean=1` at two
   sites and `server.ts` mentions it in a header comment with no handler —
   **which means `state` and `state --full` may return identical payloads.**
   Nobody has run it.
5. **Does the conformance-gate end condition survive contact?** It is the most
   load-bearing claim in this document and the least evidenced.
6. **What does the gate seat actually own?** "Measurement design" is a name, not
   a scope. It needs a boundary before it needs a handle.

## Not the agent's to do

- **`#82`'s ruling** — Cole's, explicitly, and the sprint is blocked on it.
- **The push of `develop`** (26 commits unpushed) and any release.
- **The `mind-mapper` roster question.**
- **The final roster redraw**, at convene, with the seats present.
