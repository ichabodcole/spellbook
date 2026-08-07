# Sprint 02 outcome — Success-shaped lies

**Sprint:** 02 · `sprints/02-success-shaped-lies/` **Ran:** 2026-08-06 (targeted
ratify → build → release beats) **Closed:** 2026-08-07 **Plan:**
[`plan.md`](./plan.md) — **frozen; do not edit it, and do not act on it**
**Decisions:** [`decisions.md`](./decisions.md) — written live, not
reconstructed **Branch:** `fix/spell-hardening-02`, **named merge** to `develop`
at **`a0d8c17`** **Released:** **spellbook v2.0.0** (`39fd787`, PR #93, tag
`spellbook-v2.0.0`)

> ## The honest headline
>
> **All four lanes shipped, six issues closed, and the release went out as
> `v2.0.0` — a MAJOR bump this sprint did not earn and did not predict.**
>
> The lead forecast `v1.17.0` by counting `feat:`/`fix:` and **never checking
> for a `!`**. A single unrelated `feat(mind-mapper)!:` on the same train forced
> the major. **The version number on this release does not describe this
> sprint's work** — and a reader who infers "2.0.0, so something big and
> breaking landed in the hardening lanes" would be wrong.
>
> **Two of the six closed issues (`#77`, `#78`) are sprint 01's work**, fixed
> then and never closed. This release closed them. **Sprint 02 closed four.**

---

## What the sprint was

One session, one plan, by the anthill team — `prospero` leading, `daedalus`
engine, `cassandra` verify, `thoth` grimoire (`circe`, surface, **unseated for
the third consecutive round** — see the carry-forward).

| round               | scope                                                        | outcome                                                                                                |
| ------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| **targeted ratify** | only P0d's replacement gate, P0f's five cells, P0b's control | **P0f's lane table wrong on 2 of 5 rows**; the UNDETERMINED split resolved → **2 pinnable · 3 driven** |
| **build**           | all four lanes, in order P0b → P0d → P0f → P0c               | **all four shipped**                                                                                   |
| **release beats**   | `SKILL.md` re-read · ward · cold gate · consumer rehearsal   | all discharged; **two beats correctly identified as downstream of the cut**                            |

**Gate at close:** **1336 pass · 0 fail · 102 files**, biome 338 clean, exit 0.
The total reconciles: 1327 + 9 (thoth's ward, now tracked) = 1336; 101 + 1 = 102
files.

**69 commits** — **55 docs, 11 code-shaped.** Per seat: `prospero` 37 ·
`daedalus` 14 · `thoth` 5 · `cassandra` 4. As in sprint 01 the docs commits are
**not commentary — they are the rulings**, which is why the branch was merged
with a **named merge** rather than squashed: 10 of its shas are cited by name in
this project's living documents, and four seats' `Anthill-Seat:` attribution
would have collapsed to one.

---

## Planned vs shipped

**Four lanes planned. Four shipped.** The interesting column is the third.

| lane                        | shipped                                                                                                                                                              | what it does NOT reach                                                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0b** — inert `--restore` | `bounty open` **refuses** rather than silently discarding `--restore`/`--timeout`/`--title` on the idempotent-attach path. Exit 2, `restoreSkipped` present-and-null | **Names no corrective verb** — deliberate (A3). The obvious suggestion **destroys the user's snapshot** (#73)                                      |
| **P0d** — writes that lie   | `bounty add` checks `applied`; `/cmd` in glamour · imago · magpie returns a **verdict** instead of unconditional `ok:true`                                           | The verdict means **"was the type RECOGNISED"**, not "did state change". The narrower contract is **named and left UNCLAIMED** (A12, `t-d7a3fa14`) |
| **P0f** — the `tail` slice  | `tail` **drains its terminal frame before exiting**, at five sites: bounty · astrolabe · glamour · imago · magpie                                                    | **Only the five `tail` pairs.** ~30 other in-function exits, the SIGINT handlers, and `bounty/join.ts`'s hang are **filed, not fixed**             |
| **P0c** — `--flag=value`    | **Six hand-rolled parsers replaced** with `node:util` `parseArgs` at **parser altitude**: `=` support, unknown-flag rejection, `--` terminator                       | **6 converted · 10 already conformant · 16 total**                                                                                                 |

### The release sentence this sprint earned

**Lead with the harm, not the mechanism:**

> **`bounty close --help` used to CLOSE YOUR BOARD.** `--help` was unrecognised,
> the hand-rolled parser discarded it, and the verb ran anyway. `state --help`
> dumped the board; `tail --help` opened the stream and never exited. **The
> three verbs that refused did so by accident** — they demanded a positional.

**Not** _"unknown-flag rejection now works across the house"_ — 10 of 16 entry
points were already conformant, and that phrasing **reads as false to anyone who
greps.**

### PINNED ≠ VERIFIED, again

**P0f: `2 pinned · 3 driven`.** Pinned (red-pre-fix cell, mutation-verified):
**bounty · astrolabe**. Verified by drive only: **glamour · imago · magpie** —
65536 pre-fix, complete post-fix, precondition valid at each. **No CLI-process
harness exists in those three**; building one was explicitly out of scope.

**Do not write "5 of 5 gated."** Five sites are **fixed**; **two** are pinned.

---

## What was falsified

**22 corrections, indexed in [`decisions.md`](./decisions.md) §B**, each landed
as its own commit in `plan.md`. Not restated here — that file is their single
source of truth. **18 decisions with their options-not-taken are in §A.**

Four are worth surfacing because they change how the next sprint reads its own
instruments:

1. **`strict: true` guards the flag NAME, not the TYPE** (B16). The lead
   asserted otherwise; `thoth` measured four arms. **This was a false
   reassurance, which the seat correctly named as the worst class** — a wrong
   fact is corrected by the next person who looks; a false reassurance gets no
   corrective feedback.
2. **45 exit sites are grep hits; 35 are code** (B11) — ten are **our own
   sprint-01 remediation comments**, textually indistinguishable from the defect
   they document. **Every site we fix increments the count of sites that look
   unfixed.** This inverts every other denominator row.
3. **G7's termination cell cannot report the hang it exists for** (B12). Under a
   one-word change it does not go red — it becomes **unreachable**, degrading
   from _"a red cell naming the hung verb"_ to _"a slow suite."_ It works today
   **by accident**.
4. **The P0f fixture spec is necessary and NOT sufficient** (B17) — a cell built
   exactly to it **passes against the bug**.

> **The count that belongs in the retro, not as anecdotes:** ~8 instrument
> failures across 4 seats in one session, **all one shape** — a **lexical**
> instrument standing in for a **structural** question.

---

## What this outcome could NOT confidently classify

**Recorded as unresolved rather than guessed, per the standing rule.**

1. **The flake attribution.** The figures **0-of-4 pre-P0d / 1-of-4 post-P0d**
   stand. **The attribution of the 1 does NOT** — it was first pinned on a
   "known flake" that explained neither of the session's two unnamed reds. Root
   cause, found post-stand-down: a **G7 liveness budget of 15s** in `runOpen`. A
   hang is unbounded; a slow boot is bounded, and under concurrent suites
   `bounty open` legitimately exceeds 15s. **A false hang finding, manufactured
   by load, from the instrument built to catch hangs.** Carded, not patched.
2. **Whether the flake figure travels.** Ambient load was **not** controlled —
   14 daemons live throughout, **12 predating the session**. So it is partly a
   statement about **one machine on one day** and **does not travel to CI.**
   Leaving them was deliberate (A16): killing them first would have manufactured
   the difference and attributed it to P0d.
3. **The discovery-pointer denominator.** Three counts are on record — **22 · 19
   · 10** — and **none has a stated denominator.** Not reconciled here.
4. **Whether glamour / imago / magpie can be closed by DRIVE at acceptable
   cost.** Established only that **no CLI-process harness exists in any of the
   three.**
5. **`grapevine send`'s positional channel under `--`.** Flagged, **unmeasured,
   deliberately not driven mid-release** — grapevine is the wire the team
   coordinates on. **A wrong-channel post is its own kind of bad.** Check before
   or after a cut, never during.
6. **`snapshotBackedUp` and `hydrated`** — zero code hits. **Zero hits means
   zero opportunities to diverge, not a pass.**

---

## CARRY-FORWARD → sprint 03

**This is the handoff.** Sprint 03 **restates** each item in its own words with
its own references. It does not reach back and amend sprint 02.

### Lanes

| item                             | what carries                                                                                                                                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The rest of P0f**              | **~30 in-function exits** (35 code sites minus the 5 `tail` pairs), the `die()` family rule-outs, the SIGINT handlers. **Re-measure; do not inherit the number** — B11 says the grep over-counts by ~10                                       |
| **`bounty/join.ts`'s hang**      | `process.exit` there is **load-bearing on a live WebSocket**. The honest fix is a socket-lifecycle change. **Shipping a hang to fix a truncation is a bad trade**                                                                             |
| **P1 / P2 / P3**                 | **ALL STILL UNRATIFIED.** `#73` `#74` `#79` are P1; `#72` `#76` are P2/P3. **P0's round falsified six things and P0's targeted round found two more — assume these will too**                                                                 |
| **The `--` terminator docs gap** | **0 of 6 `SKILL.md` files mention it**, and it is **new user-facing behaviour P0c introduced**. Discoverable at FAILURE time, not at COMPOSITION time — which is the gap that matters for an agent. **One line per affected spell closes it** |
| **The narrower `/cmd` contract** | _"did state CHANGE"_ — ruled OUT of sprint 02 and **left explicitly unclaimed** (`t-d7a3fa14`). ~38 per-site judgements in imago alone                                                                                                        |
| **`#64`**                        | **Genuinely unexplained.** Needs its own investigation, not a lane                                                                                                                                                                            |
| **`#85`–`#88`**                  | Out of scope with the CLI-contract investigation, which decides what right looks like                                                                                                                                                         |

### Traps that must survive into sprint 03

**A builder reading only sprint 03 must not walk into a trap sprint 02 already
paid for.**

- **G1–G8, all eight**, plus sprint 02's ~10 amendments. G1 now covers a
  **WRITE** route (`--pin` writes `<cwd>/.bounty-session`), and its clause that
  the explicit `--session-key` is only isolation **if it precedes any `--`**.
- **`--` eats flags, silently, at exit 0.** Anything after the terminator is
  text **including a flag**. Worst form: it can eat the flag that **isolates
  you**. **Three seats found this edge from three directions in one session.**
  Bounded — the severe form is **bounty-only** (the only spell with an ambient
  env binding); the weaker machine-global-pointer form affects four others.
- **`strict: true` catches unknown NAMES only.** Not types.
- **A label is a claim about a measurement** and cannot be assigned before the
  measurement is taken (G2, with its expiry clause). Countable metric: cells
  that **changed label** when arm 2 ran. First datapoint: **1 of 9.**
- **The P0f fixture spec is necessary, not sufficient.**
- **Never silence a fixture step**, and **announce-then-`ps`** — an announcement
  is a record, not a lock. **Two full suites ran concurrently, twice**; the lead
  scheduled the second one.
- **Artifact decay:** re-run the instrument at the consuming sha. _"A published
  absence claim has no listener. Reading a fact does not propagate it to the
  claims you have already published."_
- **Name the owner by measurement, not by the routing that sent you** (B15). A
  lead's routing is a **claim**, and it arrives wearing the authority of an
  assignment. One `git log` answers it.

### Explicitly NOT carried

- **A process-spawning harness for glamour · imago · magpie** — still out of
  scope, and still the reason 3 of 5 P0f sites are driven rather than pinned.
- **The four backlog items ruled _"not among the fourteen"_** — the performed
  `--restore` silence, `tail`'s full-history replay, the machine-global
  discovery pointer (**Cole ruled: file, don't fix**), and `bounty message`
  leaving no durable trace. **All stay in the active backlog.**

### Held for the retro, deliberately not promoted

**The artifact-decay rule as a team PRINCIPLE.** It is standing law in `plan.md`
for this sprint — a gate-law act. Promoting it to `principles.md` is a different
act and **the SOP forbids doing it mid-session**: the pressure to generalise
peaks exactly when you have just been burned. `thoth` called this and was right;
the lead was drifting toward promoting it. **`cassandra` owns it** — the
instant-axis/time-axis cut is hers.

---

## Release beats — all discharged

| beat                             | status                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SKILL.md` re-read               | ✅ 3 of 4 clean; one gap (the `--` terminator), carried forward                                                                                   |
| thoth's **ward**                 | ✅ landed `bbc61c2` — **a test over 16 entry points**, plus 6 `SKILL.md` doc lines. **2 findings, both the milder class. ZERO dark flags**        |
| cassandra's **cold gate** of P0c | ✅ passed at `e7504cf` — 7 red cells, all red pre-fix and green post-fix                                                                          |
| final assembled gate             | ✅ **1336 / 0 / 102**, biome clean                                                                                                                |
| **consumer rehearsal**           | ✅ **6 of 6**, driven from a `git archive` extraction — **not** a working-tree copy, which carries gitignored artifacts a consumer never receives |
| archive closed backlog items     | ✅ **1** — `2026-08-05-cli-stdout-truncation-on-pipe.md`, archived **with its unmet fourth AC stamped on it**                                     |
| comment + close the issues       | ✅ **6** — `#77` `#78` `#80` `#81` `#83` `#84`, each verified as shipping in v2.0.0, each comment carrying its caveats                            |

**The rehearsal's own bounds, stated rather than left absent:** **bounty only**
(the other five converted entry points are unverified by it) · **not a drain
check** · **not the `dist/` half of Contract 4** · **not the marketplace
mechanism** — `git archive` simulates the copy; installing through Claude Code
is **UNVERIFIED-BY-CONSTRUCTION** and only the real cut tests it.

**Two beats were correctly identified as downstream of the cut**, not upstream:
archiving and issue-commenting **cannot honestly happen before a release
exists**. Doing them early would have been this project's own defect class
committed in the filing system.

---

## The release machinery, because it failed silently and the diagnosis is reusable

**The `v2.0.0` release did not fire on merge.** No release-please run since
2026-07-10, despite an active workflow, valid YAML, an unchanged file, Actions
enabled, and a public repo.

**Root cause: the repository's `default_workflow_permissions` was `read`** — a
**ceiling** the workflow's own `permissions:` block cannot widen past. Nothing
errored; the workflow simply never ran. Cole flipped it and the release fired.

**`workflow_dispatch` was then added** (PR #92) so a missed release is
recoverable by hand rather than by pushing an empty commit.

> **A permissions ceiling is invisible from inside the file it silences.** Every
> artifact a reader would check — the workflow, its syntax, its triggers, the
> branch — was correct.

---

## Left for Cole (not the agent's call)

- **Filing the candidate issues** reported and deliberately not fixed, including
  `glamour style archive --restore foo` **archives instead of restoring, exit
  0** (dissolved by A9's rename, but the filing is still his).
- **Whether a stderr warning on a post-terminator positional that exactly
  matches a recognised flag name is worth the false positives** (A18, carded as
  a candidate, not dismissed).
- **Whether `kill -9` may appear in a user-facing refusal message** (inherited
  from sprint 01, still unanswered).
- **The 14 daemons.** Two must survive: the **team board** (closing it flushes
  live over the snapshot) and **Cole's mind-mapper on `:60700`**. Flagged, not
  killed.
- **An orphaned `lint-staged` stash from 2026-06-10** still sits in
  `refs/stash`.
