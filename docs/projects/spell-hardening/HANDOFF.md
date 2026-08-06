# Handoff — read this before ratifying the plan

**Written:** 2026-08-06 **By:** the plan's author (Claude Code, this repo)
**For:** whoever leads `spell-hardening` (`prospero`) and the seats who ratify
the seams they touch.

> ## ⚠ STALENESS RULE — read this before anything below
>
> **Amended 2026-08-06 after the P0 ratify round.** The round this file called
> for **happened**, and it falsified things this file asserts.
>
> **Where this file and [`plan.md`](./plan.md) disagree, THE PLAN WINS.**
>
> This rule exists because a document whose job is to say _"the other document
> is stale"_ needs its **own** staleness rule — otherwise it becomes the stalest
> thing in the project, since it is the one file nobody re-reads, because
> everyone believes they already have. **Two of its claims moved on 2026-08-06
> and this file did not move with them** (both are struck in place below).
>
> **The P0 family is now RATIFIED.** This file describes what the plan needed
> _before_ that round; read it as history plus the corrections marked ⛔.

---

## Why this file exists

`plan.md` was last read by the team on **2026-08-05**. Everything below changed
after that, mostly during one cross-team debugging session with
`ichabodcole/anthill` on 2026-08-06. **Three of the four P0 lanes did not exist
in the version anyone reviewed.**

Ratify the current plan, not the one you remember.

**And the author should not lead the implementation.** The proposal's rulings,
this plan, both gate constructions and the contract investigation were written
by one agent. That session's own central finding is that **verification does not
fire reliably on its own author** — four separate measurements that evening were
degenerate controls, none caught by re-reading, each caught by someone else. The
seat model already separates lead (`prospero`) from cold gate (`cassandra`) for
this reason. Use it. The author is available to answer _"why is this written
this way"_ and should not be the one deciding whether the work is done.

## What changed since 2026-08-05

|                  | change                                                                                                                                | where             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| **NEW**          | **Phase 0b** — the inert `--restore` (#80)                                                                                            | `plan.md`         |
| **NEW**          | **Phase 0c** — unparsed `--flag=value`, house-wide (#81)                                                                              | `plan.md`         |
| **NEW**          | **Phase 0d** — writes that report success without applying (#83, #84)                                                                 | `plan.md`         |
| **RULED**        | **D3** (a skipped `--restore` exits non-zero **and** carries an envelope field) and **D4** (support `=` **and** reject unknown flags) | `proposal.md`     |
| **REWRITTEN**    | **P0**'s regression test — the vacuity trap; the cell must exceed 65,536 **by construction**                                          | `plan.md`         |
| **REWRITTEN**    | **P0b**'s gate — the old "empty the live board" construction was **broken**; see below                                                | `plan.md`         |
| **STRENGTHENED** | **P1/D1.3** — the announcement must name **which** failure occurred, because a consumer provably cannot tell                          | `plan.md`         |
| **ADDED**        | **P3** — `state` reports its applied scope; `sessions` stops emitting prose                                                           | `plan.md`         |
| **REVERSED**     | the structured failure envelope is **not** folded into P0                                                                             | `plan.md` Phase 0 |
| **SCOPE**        | #83, #84 in; **#85–#88 explicitly out**                                                                                               | `proposal.md`     |

Counts moved twelve → fourteen. Anywhere you find "twelve," it is stale — say
so.

## The three things most likely to trip you

**1. P0b's old gate was wrong, and the correct one is counter-intuitive.** The
plan used to say "empty the live board so live is empty while the snapshot is
populated." **Snapshots flush on a ~1s debounce after every mutation, so
emptying live also empties the snapshot** and the divergence destroys itself.
Reading the snapshot "immediately before the restore" does not fix it either —
that is the moment most likely to land inside the previous step's debounce
window. The verified construction builds the divergence by **respawn, not
mutation**, so nothing is in flight and the precondition read has no race to
lose. It is in Phase 0b; use it verbatim.

**2. P0c will break callers, deliberately, and the risky part is not the `=`.**
Rejecting unknown flags is the intended behaviour change. But `add` and
`message` build free prose with `pos.join(" ")` and there is **no `--`
terminator anywhere in `bounty/scripts/cli.ts`** — so
~~`add write the --draft section` becomes a hard error the moment step 2
lands.~~ anthill's own attempt at this guard broke seven positional tests. Pin a
positional-preservation control per affected verb.

**⛔ CORRECTED 2026-08-06 — the struck sentence is wrong in the way that
matters.** Measured on the shipped parser:

```
["write","the","--draft","section"]        -> "write the"       flags {draft:"section"}
["fix","the","--stdin","handler","later"]  -> "fix the later"   flags {stdin:"handler"}
```

**Both exit 0 today.** The second deletes two words from the **middle** of a
sentence and flips a real behavioural flag, on `message`. **These callers are
already broken, silently; step 2 is what makes an existing corruption audible**
— it is a repair, not a regression. See `plan.md` Phase 0c.

**3. Two facts P0b's gate depends on are not guarded by any test.** That a
mutation flushes the snapshot on a ~1s debounce, and that a keyed respawn does
not mutate. Both were measured 2026-08-06 and neither is pinned. **Pin them
inside P0b**, or the gate keeps passing after the behaviour changes and stops
meaning anything.

## What ratification actually needs to decide

The plan is a **skeleton with claims** and the R12/R13 rule still holds: a claim
in a skeleton is a hypothesis until the owning seat confirms it. Specifically:

- **daedalus** — the file references and mechanisms in P0/P0b/P0c/P0d. Several
  are marked _"verified, fact not claim"_ with a date; those were run, not read.
  The rest are hypotheses. ~~One in particular is flagged and **still
  unverified**: that `--fresh --restore` tears down a live board and respawns
  from snapshot. **D3's entire ruling rests on it.** Confirm it on a throwaway
  board before building the refusal message that names it.~~

  **⛔ RESOLVED 2026-08-06 — IT IS FALSE, AND THE FAILURE MODE IS DATA LOSS. Do
  not go "confirm" it; it has been confirmed.** `cli.ts:398-408` tears the board
  down with `POST /cmd {type:"close"}`, and **`close` writes the snapshot** — so
  it flushes the _empty_ live board over the populated snapshot, and `--restore`
  then correctly restores from a file emptied 200ms earlier.

  **`--fresh --restore` DESTROYS the snapshot it is meant to restore from.**
  D3's non-zero-exit + `restoreSkipped` half stands; **its corrective-verb half
  is struck — the refusal names no fix (ruled by Cole 2026-08-06), because there
  is no safe one to name.** See `plan.md` Phase 0b and comms #24.

- **cassandra** — every gate. Each was written by the author, and at least one
  earlier version of the P0b gate was a control that could not come out
  differently. **Ask of each gate: what result would have failed this?** If
  there isn't one, the gate is decoration.
- **prospero** — phase order. ~~Whether P0d belongs in P0 at all.~~ **Ruled by
  Cole 2026-08-06: P0d stays in P0.** The scope-growth counter-argument was put
  to him and declined — it is the same defect class on the write path and it
  ships with the rest of P0. Not open; falsify with evidence if you think it is
  wrong, but do not reopen it as a preference.

## What is deliberately NOT in this project

- **#85–#88** — the other envelope defects. Filed, verified, independent. The
  [CLI-contract investigation](../../investigations/2026-08-06-spell-cli-contract-investigation.md)
  decides what right looks like; fixing them first means fixing them twice.
- **#82** — the cross-tool naming convention. **On hold.** Its two-shape table
  is known-incomplete (nine omitted situations). Do **not** mint new field names
  anywhere in this project; use the ones that already exist (`applied`), or the
  ones already ruled (`restoreSkipped`, `snapshotBackedUp`, `hydrated`).
- **The structured failure envelope.** Same reason, and see the reversal note in
  Phase 0.

## External dependency worth knowing

`ichabodcole/anthill` consumes `bounty` and `grapevine` and its lead has audited
their side: four invocations, all space-separated, no `=`, and they never call
`add` or `message` — so **P0c and P0d break nothing of theirs.** They have also
offered a genuinely recovered 102-card board for P0b's gate post-fix. That offer
stands and the sequence to send them is Phase 0b's six-step construction.

The channel is `anthill-spellbook` (grapevine). **Rulings go to GitHub, not the
vine** — a vine is in neither repo.

## Definition of done, unchanged

All fourteen issues resolved-or-deferred-with-reason, gates green, cold-gate
passed, release cut, `SKILL.md` true — plus the criterion added 2026-08-06:
**every gate was checked with a control that could have failed.**
