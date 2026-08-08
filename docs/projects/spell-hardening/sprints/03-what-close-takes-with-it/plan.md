# Sprint 03 — What close takes with it

**Created:** 2026-08-08 **Status:** 🟡 **SCAFFOLD — proposed scope, NOT
ratified, NOT buildable yet** **Project:** [Spell Hardening](../../README.md) ·
[proposal.md](../../proposal.md) **Predecessor:**
[sprint 02 outcome](../02-success-shaped-lies/outcome.md) — read it before this
**Frozen predecessor plans:**
[`../01-drained-exit/plan.md`](../01-drained-exit/plan.md) ·
[`../02-success-shaped-lies/plan.md`](../02-success-shaped-lies/plan.md) — **a
record, not an instruction. Do not act on either.**

> ## 🟡 THIS IS A SCAFFOLD. DO NOT BUILD FROM IT.
>
> It states **what we propose to do and why**, at the level a ratify round can
> attack. It does **not** yet contain lane steps, gate cells, or acceptance
> criteria — those are written after the scope is ratified, because **sprint
> 01's ratify round falsified six claims in a plan written by one author, and
> sprint 02's much narrower round still found two more.** Writing cells before
> ratify means writing cells against a scope that has not survived contact.
>
> **Two inputs are still outstanding and may change the shape below:**
>
> - **The `#64` investigation** (running 2026-08-08) — its outcome decides
>   whether `#64` becomes a lane, stays parked, or dissolves.
> - **A decision from Cole** on whether the destructive-close family belongs in
>   this project at all — see [Open questions](#open-questions).

---

## The arc: one sentence

**Sprints 01 and 02 fixed commands that lied about what they did. This one fixes
the command that destroys the thing it was protecting.**

Every defect closed so far has been a **misreport** — a truncated payload, a
discarded flag, an unconditional `ok:true`. The user's data survived; only the
account of it was wrong. **`#73` and `#74` are the first defects in this project
where the data does not survive.** That is a different severity class and it is
why this sprint leads with them.

---

## Read these before you start

- [sprint 02's outcome](../02-success-shaped-lies/outcome.md) — the
  carry-forward, the traps, and **the six things it could not classify.**
- [sprint 02's decision log](../02-success-shaped-lies/decisions.md) — 18
  decisions with the options not taken, and the 22 corrections indexed. **A3,
  A4, A12 and A16 all bear directly on this sprint's lanes.**
- [`.anthill/retro.md`](../../../../../.anthill/retro.md) — the previous round's
  hypotheses, each with its falsifier. **Name the ones this sprint tests.**
- [`.anthill/principles.md`](../../../../../.anthill/principles.md).

---

## Proposed lanes

**Order is not free** — P1a/P1b share a mechanism and must be one lane; the P0f
remainder rebases onto everything, so it goes last.

| lane                         | issue        | what it is                                                                                                              | why now                                                                                                      |
| ---------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **P1a + P1b — one lane**     | `#73`, `#74` | `close` writes live state over the on-disk snapshot unconditionally; respawn+close can destroy a keyed board's snapshot | **The only remaining DATA-LOSS defects.** The team has designed around them three times rather than fix them |
| **P1c**                      | `#79`        | `bounty list` lists **boards**, not tasks — an empty result reads as "no cards"                                         | The purest remaining instance of this project's own thesis, and small                                        |
| **P0f-remainder**            | —            | the ~30 remaining in-function `process.exit(` sites, the `die()` family, the SIGINT handlers                            | **Ruled by Cole 2026-08-08: sprint 03 finishes it.** Two deferrals is enough                                 |
| **P1d — CANDIDATE, unfiled** | none yet     | `bounty add --size <bogus>` returns `ok:true` at exit 0 and **silently discards the size**                              | Found 2026-08-08. See below — it is the sprint's own defect class, still live                                |

### Why `#73` and `#74` are ONE lane, not two

An independent audit (2026-08-08) read both and concluded they are **one bug
with one fix**. `saveSnapshot()` in `bounty/scripts/server.ts` is an
unconditional `writeFileSync` — no emptiness guard, no rotation — called at
teardown. `#74`'s respawn path is the same write reached by a different route.

**The repo already documents this bug in a code comment rather than fixing it.**
`cmdOpen` in `bounty/scripts/cli.ts` carries:

> _"close unconditionally writes the snapshot (server.ts:1286), so an EMPTY live
> board flushes empty over a populated snapshot"_

**A defect the code explains to you on the way past is not an unknown. It is a
decision to keep it.** This lane reverses that decision.

### The three accommodations that argue this is overdue

The team has repeatedly designed around `#73` instead of fixing it:

1. **A3** — P0b's refusal message deliberately **names no corrective verb**,
   because the obvious suggestion (`--fresh --restore`) destroys the snapshot.
   **A shipped error message is worse because of this bug.**
2. **A4** — the standing constraint _"do not close this board at teardown."_
3. **Sprint 02's Left-for-Cole** — two of the machine's daemons must survive for
   the same reason.

**When a team writes its own error messages around a defect, the defect has
earned a lane.**

### P1d — the unfiled candidate, and it is ours

Surfaced by the 2026-08-08 audit, **not previously reported**:

```
bun cli.ts add --size ongoing "…"     → {"ok":true,"added":"t-90ec4e76"}  exit 0   ← size DISCARDED
bun cli.ts update <id> --size bogus   → exit 2                                     ← refuses
```

**`add` and `update` disagree about whether a bad `--size` is an error, and
`add` is on the wrong side of the rule sprint 02 established.** This is the same
shape as `#83`/`#84`, which this project just closed — shipped in the release
that fixed its siblings.

**Also:** `update`'s refusal reads
`nothing to change (give --status/--title/--notes/--owner/--tag/--stdin)` —
omitting `--size`, **the flag the caller actually passed.**

⚠ **Filing is Cole's call, not the agent's.** Either file it and pull it in, or
rule it out loud into the contract investigation.

---

## Not in this sprint

Stated explicitly, because sprint 01's outcome proved that **deferred work with
no name comes back as a surprise.**

| out                                                             | where it goes instead                                                                                                                                                         |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#82`, `#85`–`#88`                                              | [the CLI-contract investigation](../../../../investigations/2026-08-06-spell-cli-contract-investigation.md), **Active**. It decides what right looks like; a lane comes after |
| `#64`                                                           | **Under investigation now.** Not a lane until the investigation says what the mechanism is                                                                                    |
| `#72` (size affordance), `#11` (wordmark), `#75` (bounded tail) | Not this defect family. Backlog                                                                                                                                               |
| A CLI-process harness for glamour · imago · magpie              | Still out of scope. Still the reason 3 of 5 P0f sites are driven rather than pinned                                                                                           |
| The narrower `/cmd` contract (_"did state CHANGE"_)             | Ruled out in sprint 02 (A12) and **left explicitly unclaimed** — `t-d7a3fa14`                                                                                                 |

---

## Inherited state — restated, not linked

**A builder reading only this document must not walk into a trap two sprints
already paid for.**

- **G1–G8 all bind**, plus sprint 02's ~10 amendments. G1 covers a **WRITE**
  route (`--pin` writes `<cwd>/.bounty-session`) and requires that an explicit
  `--session-key` **precede any `--`**.
- **⚠ The P0f denominator is NOT ~30 until you re-measure it.** B11: 45 grep
  hits, **35 are code** — ten are our own sprint-01 remediation comments,
  textually indistinguishable from the defect. **Every site we fix increments
  the count of sites that look unfixed.** Re-measure at this sprint's base sha;
  do not inherit.
- **`strict: true` catches unknown NAMES only.** Not types.
- **A label is a claim about a measurement** and cannot be assigned before the
  measurement is taken (G2, with its expiry clause).
- **The P0f fixture spec is necessary and NOT sufficient** — a cell built
  exactly to it passes against the bug.
- **G7's termination cell works by accident** and degrades to _unreachable_, not
  red, under a one-word change. It also carries a **15s liveness budget** that
  produced a false hang finding under concurrent load. Carded, unpatched.
- **Announce-then-`ps`, and never silence a fixture step.** An announcement is a
  record, not a lock — two full suites ran concurrently twice.
- **Re-run the instrument at the consuming sha.** _"A published absence claim
  has no listener."_ **This rule was broken again on 2026-08-07** — the lead
  carried a stale "0 of 6 SKILL.md" claim from a draft into sprint 02's outcome
  without re-running it; it had been closed in-sprint by `bbc61c2`. **Ninth
  instance.**
- **Name the owner by measurement, not by the routing that sent you** (B15).

---

## What this sprint must NOT do

- **Do not test `#73`/`#74` by running `close` on a live board.** That is the
  destructive act itself. The lane needs a **disposable, redirected fixture**
  (`BOUNTY_HOME` + `TMPDIR` into scratch) before any reproduction is attempted.
  The 2026-08-08 audit correctly refused to reproduce these for exactly this
  reason and marked them **NOT TESTABLE SAFELY** instead of guessing.
- **Do not kill the machine's daemons.** Two must survive: the **anthill team
  board** and **Cole's mind-mapper on `:60700`**.
- **Do not ship a rotation scheme wider than the defect.** `#73` is an
  unconditional overwrite; the minimum honest fix is a guard plus a recoverable
  prior copy. A general snapshot-history feature is a different project.

---

## Open questions — for the ratify round and for Cole

1. **Does the destructive-close family belong in spell-hardening at all?**
   `#73`/`#74` are really _bounty snapshot lifecycle_. The case for keeping them
   here: same defect family, same instruments, the gate law is already tuned,
   and the project's own error messages are shaped by the bug. The case against:
   this is the first lane whose subject is **durability**, not **honest
   reporting**, and the project's one-sentence thesis does not stretch to cover
   it. **Unresolved. Cole's call.**
2. **Is P1d filed, folded in, or ruled out?**
3. **What does the `#64` investigation say** — lane, park, or dissolve?
4. **Is the sprint 02 flake carding (G7's 15s liveness budget) in scope**, or
   does it stay carded? It is an instrument defect, and this sprint depends on
   that instrument.
5. **What does "finishes it" mean for P0f, exactly** — all 35 code sites, or all
   sites minus a named and justified remainder? **Sprint 01 and 02 both shipped
   "done" over an unenumerated remainder. Define the denominator before
   starting, not at the release.**

---

## Not the agent's to do

- **Filing the P1d candidate**, and any other candidate this sprint surfaces.
- **Cutting the release and pushing.** The agent stages and stops.
- **Ruling question 1.**
