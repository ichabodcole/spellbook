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
> **Inputs since the first draft:**
>
> - ✅ **The `#64` investigation CONCLUDED 2026-08-08** —
>   [the document](../../../../investigations/2026-08-08-bounty-daemon-idle-death.md),
>   _Proposal Recommended, for a different defect than `#64` names._ The idle
>   framing is falsified; **P1e and P1f below are what `#64` becomes.**
> - ✅ **A live-team validation beat is IN**, ruled by Cole 2026-08-08 — see
>   [its section](#the-live-team-validation-beat--and-it-is-a-lane-not-a-checkbox).
>   The whole scope above was established by **subagents in isolation**, and
>   three of these defects are not reachable in that regime.
> - ✅ **The destructive-close family STAYS in this project**, ruled by Cole
>   2026-08-08, over spinning up a separate `bounty snapshot lifecycle` project.
>   **This widens the project's thesis beyond honest reporting to durability** —
>   the README is amended to match.
> - ✅ **P1d, P1e and P1f are NOT filed as issues**, ruled by Cole 2026-08-08.
>   **They are tracked in this document and nowhere else**, which makes this
>   plan load-bearing in a way the previous two were not.

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

| lane                        | issue                  | what it is                                                                                                                                                                                                                     | why now                                                                                                                                                              |
| --------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1a + P1b — one lane**    | `#73`, `#74`           | `close` writes live state over the on-disk snapshot unconditionally; respawn+close can destroy a keyed board's snapshot                                                                                                        | **The only remaining DATA-LOSS defects.** The team has designed around them three times rather than fix them                                                         |
| **P1c**                     | `#79`                  | `bounty list` lists **boards**, not tasks — an empty result reads as "no cards"                                                                                                                                                | The purest remaining instance of this project's own thesis, and small                                                                                                |
| **P0f-remainder**           | —                      | the ~30 remaining in-function `process.exit(` sites, the `die()` family, the SIGINT handlers                                                                                                                                   | **Ruled by Cole 2026-08-08: sprint 03 finishes it.** Two deferrals is enough                                                                                         |
| **P1d — tracked here only** | _no issue, by ruling_  | `bounty add --size <bogus>` returns `ok:true` at exit 0 and **silently discards the size**                                                                                                                                     | Found 2026-08-08. See below — it is the sprint's own defect class, still live                                                                                        |
| **P1e — tracked here only** | _re-scoped from `#64`_ | **The SSE keep-alive has never once fired.** `Bun.serve` is called with no `idleTimeout`, so Bun's **10 s** default severs the connection **5 s before** the 15 s heartbeat                                                    | Reproduced at HEAD; the severing line appears **29 times in the production log**. Explains the reporter's read-heavy-dies / write-heavy-survives clue                |
| **P1f — tracked here only** | _re-scoped from `#64`_ | **A dead board is indistinguishable from a quiet one, forever.** The terminal `closed` frame reaches only clients connected at that instant; SIGTERM/SIGINT/`uncaughtException` never emit it — **156 of 224 recorded deaths** | **The purest instance of this project's thesis yet** — `tail` prints _"no session yet, retrying…"_ indefinitely at a board that is gone. Observed running **6 days** |

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

### P1e / P1f — what the `#64` investigation actually found

[`docs/investigations/2026-08-08-bounty-daemon-idle-death.md`](../../../../investigations/2026-08-08-bounty-daemon-idle-death.md)
— **Outcome: Proposal Recommended, for a different defect than `#64` names.**

**The idle framing is dead, three independent ways.** `~/.bounty/daemon.log`
holds 30 days and 224 matched birth→death pairs; across **all 32 `timeout`
exits, `subscribers` was 0 — 32 of 32.** The idle logic never once closed a
board with somebody connected. That joins the arithmetic (re-verified at
`d8e5b6f`) and a controlled experiment.

> **⚠ The instrument built for `#64` post-dates `#64` by 64 minutes.** `e10c994`
> landed `2026-07-09T01:14Z`; the issue was filed `2026-07-09T00:09:52Z`.
> **Every death the reporter actually experienced is pre-instrument and
> permanently unrecoverable.** We are not diagnosing the reported deaths — we
> cannot. We are diagnosing two defects found while looking for them.

**Recommendation carried forward: re-title and re-scope `#64`, do not close
it.** P1e and P1f are what it should become.

---

## The live-team validation beat — and it is a LANE, not a checkbox

**Ruled by Cole 2026-08-08.** Everything above was established by **subagents in
isolation**. That is the wrong regime for three of these defects, and the gaps
are specific rather than theoretical:

| what was NOT reachable in isolation                                                                       | why a live team reaches it                                                      |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `#73` / `#74` were marked **NOT TESTABLE SAFELY** — reproducing them requires running the destructive act | A **disposable** board can be destroyed on purpose                              |
| `#64`'s original conditions: several seats tailing one board **for hours**                                | That is literally what a convened team does                                     |
| **P1e** is masked by `cli.ts tail`, which silently reconnects                                             | Real seats hold **browser tabs** and long-lived consumers that do not reconnect |
| **P1f** needs a client that was **not** connected at the moment of death                                  | Seats join and leave at different times by nature                               |

**The claim being tested is not "does the bug exist" but "does subagent testing
replicate the real multi-agent experience."** If the live run reproduces what
the subagents found, the isolated method is validated for next time — **which is
worth as much as the bug findings.** If it does not, we have learned that our
cheapest instrument does not see this class, and that is worth more.

> **⚠ This beat also carries the only remaining route to `#64`'s central
> question.** `#64` was filed **by an agent, not by Cole**, so the reporter
> cannot be asked what their keep-alive actually was — and that fact decides
> whether P1e is cause or coincidence (see Open question 6). **Run both consumer
> shapes deliberately: a `cli.ts tail`, which reconnects and masks the severing,
> and a non-reconnecting consumer, which does not.** If only one regime produces
> a death resembling the report, that is the answer we cannot get any other way.

> ### ⛔ The isolation requirement, and it is not optional
>
> **This beat deliberately destroys boards while a live team is coordinating
> over a board.** That is the exact shape of sprint 01's **P0e** — _"the
> project's own gate destroyed the live team board twice in forty minutes."_ We
> would be doing it on purpose this time, which makes it a controlled experiment
> rather than an accident **only if the isolation is mechanical.**
>
> - **The test board MUST NOT be the team's coordination board.** Redirect
>   `BOUNTY_HOME` **and** `TMPDIR` into scratch for every test invocation.
> - **`anthill convene` writes `.bounty-session` at the repo root**, which is
>   `resolveSession` level 5 — so **convene itself creates the ambient binding**
>   this beat must escape. Every test command passes an explicit
>   `--session-key`, and per G1 that key **is** the isolation only if it
>   precedes any `--`.
> - **Never run `close` against an un-redirected board.** `#73` is unfixed for
>   the duration of the lane that fixes it.
> - The investigation's own probe **overwrote the machine-global
>   `bounty-latest.json`** before it isolated `TMPDIR` — a first-hand demo of
>   the defect, from the agent sent to study it. **Isolate before the first
>   command, not after the first surprise.**

**Sequencing:** run this beat **before** the fixes, not after. A validation pass
that only ever sees the fixed world cannot tell you whether the instrument would
have caught the broken one — the inverted-control problem (G2) at the level of a
whole method.

---

## Not in this sprint

Stated explicitly, because sprint 01's outcome proved that **deferred work with
no name comes back as a surprise.**

| out                                                             | where it goes instead                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#82`, `#85`–`#88`                                              | [the CLI-contract investigation](../../../../investigations/2026-08-06-spell-cli-contract-investigation.md), **Active**. It decides what right looks like; a lane comes after                                                                                         |
| `#64` **as filed** — "the daemon idle-dies"                     | **Investigated and falsified 2026-08-08.** The idle logic is exonerated 32/32. The issue should be **re-titled and re-scoped**, not closed; P1e and P1f are what it becomes. **The reported deaths themselves are unrecoverable** — no instrument existed at the time |
| `#72` (size affordance), `#11` (wordmark), `#75` (bounded tail) | Not this defect family. Backlog                                                                                                                                                                                                                                       |
| A CLI-process harness for glamour · imago · magpie              | Still out of scope. Still the reason 3 of 5 P0f sites are driven rather than pinned                                                                                                                                                                                   |
| The narrower `/cmd` contract (_"did state CHANGE"_)             | Ruled out in sprint 02 (A12) and **left explicitly unclaimed** — `t-d7a3fa14`                                                                                                                                                                                         |

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

1. ~~**Does the destructive-close family belong in spell-hardening at all?**~~
   **✅ RULED BY COLE 2026-08-08 — it stays here. Fold it in.** _"I'd rather
   that than add another project, plan etc."_ The option not taken was a
   separate `bounty snapshot lifecycle` project; its cost is a second proposal,
   a second plan, and a second gate law to keep in sync, **to buy a cleaner
   thesis and nothing else.** **⚠ The consequence, stated rather than absorbed:
   the project's one-sentence thesis is now wider than its README says.** _"A
   command that cannot do the thing returns something shaped like success"_ does
   not cover `close`, which does the thing and destroys your data doing it. The
   README is amended alongside this ruling — **a scope decision that leaves the
   project's own description behind is how a project quietly becomes something
   else.**
2. ~~**Is P1d filed, folded in, or ruled out?**~~ **✅ RULED BY COLE 2026-08-08
   — folded in, NOT filed. Same for P1e and P1f.** _"I'd skip the issues for the
   Ps, I don't think it really buys us anything, but issues to then close."_ An
   issue opened by us, worked by us, and closed by us in the same sprint is
   bookkeeping wearing tracking's clothes. **⚠ Two consequences, and the first
   one bites at release time:**
   - **This sprint will ship fixes that close NO issue.** That is not new —
     sprint 02's P0f closed none either _("it has no number because this project
     found it")_ — but with four such lanes it becomes the norm rather than the
     exception. **Do not let the release note imply the issue count measures the
     sprint.**
   - **The plan is now the only record of P1d–P1f.** Nothing external will
     survive it. **That makes this document load-bearing in a way the previous
     two plans were not**, and it is an argument for freezing it carefully at
     close rather than letting it rot as a superseded artifact.
3. ~~**What does the `#64` investigation say** — lane, park, or dissolve?~~
   **ANSWERED 2026-08-08: re-scope.** The idle framing is falsified; P1e and P1f
   are what `#64` becomes.
4. **Is the sprint 02 flake carding (G7's 15s liveness budget) in scope**, or
   does it stay carded? It is an instrument defect, and this sprint depends on
   that instrument.
5. **What does "finishes it" mean for P0f, exactly** — all 35 code sites, or all
   sites minus a named and justified remainder? **Sprint 01 and 02 both shipped
   "done" over an unenumerated remainder. Define the denominator before
   starting, not at the release.**
6. **⛔ NOT ANSWERABLE — the reporter cannot be asked.** The one fact that would
   decide whether **P1e is cause or coincidence** is what the "host keep-alive
   tail" was in the reported sessions: `cli.ts tail` reconnects silently and
   masks the severing, so P1e would be incidental; a browser tab or any
   non-reconnecting consumer makes it very likely causal. **`#64` was filed by
   an agent, not by Cole, so there is no reporter to ask** _(established
   2026-08-08)_. **Consequence, and it is the reason the live-team beat is a
   lane rather than a checkbox: the question can only be settled by
   RECONSTRUCTION.** Run real seats against a disposable board with **both**
   consumer shapes — a `cli.ts tail` and a non-reconnecting one — and see which
   regime produces a death that looks like the report. **Do not resolve this by
   reasoning about the code; that is what two sprints already did.**
7. **The ~20-minute number in `#64` matches nothing in the code** — no floor, no
   interval, no backoff. The investigation **declined to invent a mechanism for
   it.** Does the live-team beat try to reproduce a ~20-minute death
   specifically, or do we record the number as permanently unexplained? **⚠ With
   the reporter unavailable, "unexplained" may be the only honest terminal
   state** — say so rather than fitting a mechanism to a number.
8. **Does the live-team beat run inside this sprint, or as its own session?** It
   needs a convened team, hours of wall-clock, and deliberate board destruction
   — a different rhythm from a build lane.

---

## Not the agent's to do

- **Cutting the release and pushing.** The agent stages and stops.
- **Convening the team** for the live-team validation beat, and deciding when.

_(Filing issues for P1d–P1f was here until 2026-08-08. **Ruled out** — see Open
question 2. They are tracked in this document and nowhere else.)_
