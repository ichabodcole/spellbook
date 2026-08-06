# Sprint 02 — Success-shaped lies

**Created:** 2026-08-06 **Status:** ACTIVE, building **Project:**
[Spell Hardening](../../README.md) · [proposal.md](../../proposal.md)
**Predecessor:** [sprint 01 outcome](../01-drained-exit/outcome.md) — read it
before this **Frozen predecessor plan:**
[`../01-drained-exit/plan.md`](../01-drained-exit/plan.md) — **a record, not an
instruction. Do not act on it.**

> ### 📋 Decisions live in [`decisions.md`](./decisions.md), beside this file
>
> **This plan says what to build. The decision log says what was CHOSEN, what
> the alternatives were, what each would have cost, and WHO RULED.** They are
> different questions and neither answers the other.
>
> **Read it before you argue with a ruling in this plan** — Cole's `--unarchive`
> rename, P0b's no-corrective-verb refusal, and the scope lines that were
> deliberately left unclaimed are all there **with the options that were not
> taken.**
>
> _Added after `thoth` measured that `decisions.md` was reachable from nothing:
> `grep -rln "decisions.md"` over the whole project returned **zero files**. The
> link ran one way only. **An out-of-band record nobody routes to is out-of-band
> in the way that does not help** — the same defect this sprint's own session
> anchor had, ninety minutes earlier, conceded by the same author._

> ## All `file:line` references in this document are at `7a32677`
>
> That is `develop` after sprint 01's merge. Read any of them with
> `git show 7a32677:path/to/file.ts`.
>
> **This is a live plan, so its references are expected to move as you build.**
> Pinning happens at freeze time, when this sprint closes. **What is stated here
> is where each site was when the sprint was scoped** — if you land on something
> that does not look like the quoted line, the tree moved and the **shape** is
> authoritative, not the number.
>
> **Sprint 01 paid for this rule in cash:** 6 of 9 references in its audit table
> went stale **within one session**, moved by the very fixes the table
> commissioned. Commit `82ec61c` pinned the table to `5dfbb0d` rather than
> renumber, because renumbering is a losing race. **One reference in sprint 01
> is stale and is deliberately left stale:** `glamour/cli.ts:481` is now
> **`:500`**, moved by `62a5972`. It is re-pinned below.

---

## Read these before you start

**This plan is not the whole inheritance.** Sprint 01's team wrote down what it
learned somewhere else, and a builder who reads only this document never learns
those documents exist — **which makes the retro mechanism write-only.**

- [`.anthill/retro.md`](../../../../../.anthill/retro.md) — **nine hypotheses,
  each with its falsifier named, written for the next round specifically.** That
  is this round. Falsify them where you can; several bear directly on the lanes
  below.
- [`.anthill/principles.md`](../../../../../.anthill/principles.md) — the team's
  standing principles, including the ones the gate law below is an instance of.

**Also: lane order is not free.** See
[Lane order — build in this sequence](#lane-order--build-in-this-sequence)
before you pick up a lane.

---

## Lane order — build in this sequence

> **P0b → P0d → P0f → P0c.** **P0c is an integration pass and goes LAST.**

**The reason is edit-site invalidation, not preference.** P0c's likely correct
fix **deletes `bounty/cli.ts`'s `parseArgs` and reshapes `main()`** — so if it
lands first it invalidates P0b's attach-path edit site (`cli.ts:388-397`), P0d's
write-verb sites (`:793`, `:821`, `:838`, `:864`, `:883`, `:897`, `:918`) and
**shifts every line in P0f's five-site table.** The other three lanes touch
narrow, stable regions and do not disturb each other.

**Treat P0c as its own integration pass**: it rebases onto the three landed
lanes, and its gate re-runs theirs. **A lane whose edit sites moved under it is
a lane whose gate has to be re-read, not re-run.**

---

## The arc: one sentence, four mechanisms

> **A spell command that cannot do the thing no longer returns something shaped
> like success.**

Sprint 01 fixed the case where a command _did_ the thing and lost the answer on
the way out — the drained exit. **This sprint is the other half: commands that
cannot do the thing, do not do it, and say `ok` anyway.**

| lane    | the lie                                                                                                         | issue       |
| ------- | --------------------------------------------------------------------------------------------------------------- | ----------- |
| **P0b** | `open` silently discards `--timeout`, `--restore` and `--title` and exits 0                                     | #80.1       |
| **P0c** | an unrecognized flag is not ignored — **the verb executes anyway**, and `--flag=value` silently corrupts writes | #81         |
| **P0d** | a write verb reports success without checking the write applied                                                 | #83, #84    |
| **P0f** | `tail` writes the event that says the stream ended, then throws it away on exit                                 | (P0f slice) |

**They are four different mechanisms — control flow, argument parsing, result
propagation, stdout draining — and one defect class.** Do not merge their fixes
into one commit; do ship them under one story.

**The single most important user-facing fix in this sprint is inside P0c step
2:** unknown-flag rejection is what stops **`bounty close --help` from CLOSING
THE BOARD.** Lead with that.

## Not in this sprint

Stated exhaustively, because an unenumerated remainder is how this project has
shipped "done" three times already.

- **The rest of P0f** — the ~39 other in-function exits, the SIGINT handlers
  (`const stop = () => process.exit(0)`), the `if (grounded)` session-gone
  paths, and the `die()` family rule-outs. **Only the five `tail` pairs.**
- **`bounty/join.ts`'s hang.** `process.exit` there is doing double duty:
  force-terminating a live WebSocket is load-bearing. The one-liner makes
  `join.ts > idle timeout` time out at 15s. **The honest fix is a
  socket-lifecycle change, not P0's shape.** Carded separately. **Shipping a
  hang to fix a truncation is a bad trade.**
- **A process-spawning test harness for magpie / imago / glamour.** It is the
  reason four of sprint 01's nine P0 sites are _verified by drive_ and not
  _pinned by test_. Real, wanted, not this sprint. **⚠ But do not read this
  bullet as "all three lack one" — magpie and imago each have a spawning
  integration test whose reach is unmeasured. See P0f's three verdicts.**
- **P1 / P2 / P3.** **All three are still UNRATIFIED.** Run a ratify round on
  each before building it — **P0's round falsified six things; assume these will
  too.**
- **The discovery-pointer production defect.** Ruled **file, don't fix**:
  shipped-source sites at `join(tmpdir(), "<spell>-latest.json")` in bounty,
  glamour, imago and magpie. It belongs with the CLI-contract investigation
  beside #85–#88. **Fixing it here means fixing it twice.**

  > **⚠ The site count is UNVERIFIED — do not pick a number.** Three counts of
  > this set disagree: **22**, **19** and **10**. They cannot all be right, and
  > nobody recorded a denominator, so there is no way to tell which question
  > each one answered. **Re-measure it with its denominator stated** — the glob,
  > whether test files are included, whether `src/` counts — **before the figure
  > appears in a release note or an issue.** _This is this project's own
  > bounded-check rule applied to itself: an unqualified count is a
  > success-shaped number._

- **#85–#88 and the structured failure envelope.** Same reason — **and the risk
  half matters more than the cost half.** The cost argument ("fixing it twice")
  is right but it is not what settled this. **The envelope's shape is
  known-incomplete — nine members were omitted from the draft** — so folding it
  in **blocks a data-corruption fix on an open investigation.** _That was right
  about the cost and wrong about the risk._ **Ruled: fix the drain only; accept
  touching the exit path twice.** This binds sprint 02 hardest, because sprint
  02 touches **both** the exit paths (P0f) **and** the envelope
  (`restoreSkipped`, `applied`).
- **#64.** Genuinely unexplained — the idle-timeout framing is dead on
  arithmetic. Needs its own investigation, not a lane.
- **Minting any new field name** beyond `restoreSkipped`. Use `applied`, which
  **already exists in the code** (`bounty/server.ts:266`). **It is NOT
  documented** — see P0d step 4, which budgets the `SKILL.md` edit.

---

## Inherited state — what is already true, restated

**Do not re-derive these. Falsify them if you can.** Every one was measured in
sprint 01 and carries its evidence.

### The suite frame

**1297 pass / 0 fail, biome clean, under a private `TMPDIR`.** That frame did
not exist when sprint 01 opened; it had to be built. **Every green in this repo
recorded before 2026-08-06 under a shared pointer is void** — including two
independently-agreeing 1291/0 baselines that were read as corroborating each
other and were two draws from one distribution.

### The drained exit, at the entry points only

Nine sites were patched by `c29aa4e` + `ec33378`; **eight of them were ruled
in** (`magpie/discover.ts` was patched and then ruled OUT — its large payload
goes to a FILE, not the pipe). **The streaming verbs' terminal exits were never
touched. That is P0f, and its `tail` slice is this sprint's fourth lane.**

**Denominator, re-measured at `7a32677`: 45 non-test `process.exit(` sites**
under `plugins/spellbook/skills/*/scripts/`. Sprint 01's plan says **44**; it
was measured before `62a5972`, which took `glamour/cli.ts` from 5 to 6.
**Neither number is wrong; they are measurements at different shas.**

### G5's repeal status

**Repealed per spell, and only bounty is green.**

| spell          | status                                                                        |
| -------------- | ----------------------------------------------------------------------------- |
| bounty         | ✅ `d650c97`                                                                  |
| glamour        | ❌ its suite reaches the in-process pointer write at `server.ts:405-415`      |
| imago · magpie | ❓ **UNVERIFIED** — both have a TMPDIR-handling test file, which is not proof |

**One of four. G5 stays for everyone until all four are green.** _The glamour
case is the one to remember: it writes the pointer **in-process**, so a
`Bun.spawn` grep sees nothing. **"Does this suite spawn?" is not the question.
"Does this suite reach the code that writes the pointer?" is.**_

---

## Gate law — binds EVERY gate in this sprint

**A gate that omits any of these is not merely risky; it is invalid.** Five of
them are sprint 01's G1–G5, restated in their amended form. The three below them
were paid for during sprint 01's build round and are new law.

### G1 — the explicit `--session-key` IS the isolation

Every gate here drives real CLI verbs, so every gate inherits
`BOUNTY_SESSION_KEY` from the shell it runs in. **A gate that attaches to a
stranger board measures the stranger, silently, exit 0.**

Run every gate with **`env -u BOUNTY_SESSION_KEY -u BOUNTY_SESSION`**, a
**unique `BOUNTY_HOME`**, and an **explicit throwaway `--session-key`**.

**⚠ The scrub is NOT the isolation — the explicit key is.** `resolveSession`
(`bounty/cli.ts:164-192`) has **five** precedence levels and only the middle two
are environment:

```
1. --session-key   2. --session   3. $BOUNTY_SESSION_KEY
4. $BOUNTY_SESSION 5. .bounty-session (walking UP from cwd)
```

**The latest pointer is a sixth route to a board, but it is NOT a level of
`resolveSession`** — it lives in a different function. Do not count it here; G5
is what governs it.

**Level 5 is a file this repo WRITES but does not track** — `.bounty-session` is
gitignored (`.gitignore:50`) and `git ls-files` errors on it. When it is
present, it holds the team board's id, **byte-identical to what level 3
derives.** So `env -u BOUNTY_SESSION_KEY` does not isolate a process whose cwd
is under a working copy that has one; **it demotes one route to another route
with the same destination. A gate that scrubs and omits the explicit key is not
partially isolated — it is not isolated at all, and it looks more careful than
one that does neither.** _Three people mis-ran this in the same direction in one
evening._

**⚠ And because it is untracked, level 5 is ABSENT in a fresh clone and in a
`git worktree`** — which is how this repo spins up build agents. **A builder who
checks "there is no `.bounty-session` here, so I'm safe" is reasoning correctly
from a false premise**, and drops the explicit key that levels 3, 4 and 6 still
require. **The requirement does not vary with the file's presence.** Pass
`--session-key` every time.

**This is not a precaution. It is proven:** the project's own test suite
attached to the live team board and called `close` on it, twice, on 2026-08-06.

> ### ⚠ G1 covers the READ routes. `--pin` is a WRITE route, and it was missing.
>
> **Added 2026-08-06 (sprint 02) by `daedalus`, hit while building P0b's
> cells.**
>
> **`--pin` writes `<cwd>/.bounty-session`.** A cell that spawns a CLI **without
> an explicit `cwd`** inherits the repo, writes that file at the **repo root**,
> and **rebinds the team's own board** — because that file is `resolveSession`
> **level 5**, and its contents are byte-identical to what level 3 derives.
>
> **Every route enumerated above is something the gate READS. This one is
> something the gate WRITES**, and it survives the run — so the damage is not to
> the measurement, it is to the next process that resolves a session anywhere
> under this working copy, including a peer seat.
>
> **Pin `cwd` to a throwaway directory in any cell that passes `--pin`.** The
> unique `BOUNTY_HOME` does **not** cover it: the pin is written relative to
> **cwd**, not to `BOUNTY_HOME`.
>
> _Generalises past `--pin`: when you enumerate the ways a gate can reach the
> wrong board, enumerate the writes as well as the reads. The read list was
> complete and it was half the question._

### G2 — a gate must be FALSE pre-fix **and TRUE post-fix**

| failure mode                                            | behaviour                              | why it is bad                                    |
| ------------------------------------------------------- | -------------------------------------- | ------------------------------------------------ |
| **Decoration** — no failing result exists               | passes silently forever                | tells you nothing                                |
| **Inverted control** — fails the CORRECT implementation | **red gate that looks like diligence** | **dispatches the builder to break working code** |

An inverted control cannot be caught by asking _"could this fail?"_, because it
can — that is precisely the problem. **Evaluate every gate's assertion twice:
once against the buggy world, once against the world after the intended fix.**
The second check is the one nobody runs, and **it found the only defective gate
of sprint 01's four — P0d's, which is in this sprint.**

#### Every cell carries ONE of two labels. There is no third state and no blank.

| label                  | means                             | pre-fix behaviour        |
| ---------------------- | --------------------------------- | ------------------------ |
| **RED PRE-FIX**        | **proves the fix does the thing** | **must fail today**      |
| **BLAST-RADIUS GUARD** | proves the fix broke nothing else | **already passes today** |

**Both are legitimate. Conflating them is not.** A blast-radius guard that is
green pre-fix is doing its job; **demanding it be red sends a builder to
manufacture a failure that should not exist.** And labelling a guard as
discriminating produces a report like _"3/3 discriminating"_ when the true
figure is 1 — **which is precisely the success-shaped lie this sprint is named
after, committed by the instrument meant to catch it.**

**A cell that asserts neither — one that establishes the fixture the other cells
depend on — is labelled `PRECONDITION` and is never counted in either column.**
It is not evidence about the fix; it is what makes the evidence readable. It is
still asserted, still printed, and still fails the run when it degenerates
(P0b's `VALID-CONTROL` / `DEGENERATE` cell is the worked example).

**Every cell in every gate below carries its label.** When you add a cell, label
it. When you report, **report the counts separately** — _"1 red pre-fix, 2
blast-radius guards, 1 precondition"_ — never a single total.

> ### ⚠ G2 AMENDED 2026-08-06 (sprint 02) — WHEN a label may be assigned, and when it EXPIRES
>
> **Two mislabelled cells shipped in one session, from two seats in opposite
> roles.** The rule earned by them:
>
> > **A label is a claim about a measurement, so it cannot be assigned before
> > the measurement is taken — and it EXPIRES when the cell's assertions are
> > edited.**
> >
> > **Enforcement: no cell carries a label until BOTH arms have run. A cell
> > whose assertions changed since its last two-arm run is UNLABELLED, not
> > still-labelled.**
>
> **⛔ Do NOT cite this as "two seats found it independently." That is FALSE and
> its own author killed the claim.** `cassandra` had **read `daedalus`'s report
> of the defect, including his mechanism for it, forty minutes before she
> committed the same class.** It is one seat reporting and a second committing
> anyway, having read the report.
>
> **That is the stronger argument, not the weaker one:** a **fresh, explicit,
> peer-delivered, written** warning did not prevent the second instance. **This
> is `principles.md`'s entry firing exactly as written** — the failure mode is
> the FEELING of having covered it — **which is precisely why the remedy is a
> mechanical gate and not anyone's awareness.**
>
> **The two are DIFFERENT sub-mechanisms, and the first half of the rule catches
> only one of them:**
>
> |         | `daedalus`                                              | `cassandra`                                        |
> | ------- | ------------------------------------------------------- | -------------------------------------------------- |
> | cell    | pre-existing, **correctly** labelled                    | new                                                |
> | fault   | **an edit changed the class; the label did not follow** | **the label was never derived from a pre-fix run** |
> | symptom | RED wearing GUARD                                       | GUARD wearing RED                                  |
>
> **His label WAS assigned after a measurement — just a different one, then
> silently invalidated by an edit. That is why the EXPIRY clause is not a
> flourish: without it the rule is satisfied by his original cell and still lets
> his defect through.**
>
> **Why an enforcement clause and not just the principle:** the principle is
> about epistemics and **can be agreed with while changing nothing** — both
> seats agreed with it before breaking it. **The enforcement clause is checkable
> by someone who has not understood the argument**, which is the only kind of
> rule that outlives the session that wrote it.
>
> **It also makes the pre-fix arm non-optional, which is the real prize.**
> cassandra's arm 1 came back 6/6 green and **she nearly stopped**; the finding
> came only from running an arm she expected to learn nothing from. **Under this
> rule, skipping an arm is VISIBLE as an unlabelled cell instead of invisible as
> a confident one.**
>
> **The metric that shows the rule working — and it is countable:** _how many
> cells CHANGED label when arm 2 ran._ **First datapoint, cassandra's P0b cold
> gate: 1 of 9** (labelled 7 red / 1 guard before running; reported 6 red / 2
> guard / 1 precondition after).
>
> **FALSIFIED IF** a session runs both arms on every cell, labels only from arm
> results, re-runs both arms after every assertion edit — **and a mislabelled
> cell still ships.** **NOT falsified by** a session with no mislabels: that is
> the base rate, and it looks identical to a week when nobody wrote a tricky
> cell.

### G3 — pin board identity OUT-OF-BAND, because the envelope cannot

**There is no session id, key, port or board identity anywhere in a
`bounty state` response.** So "assert which session answered" cannot be
satisfied from the payload. Capture `session_id` from `open`'s stdout and bind
every subsequent call to an explicit `--session-key` under a unique
`BOUNTY_HOME`.

### G4 — enumerate; never write "for each spell" or "an over-buffer payload"

**An unenumerated target set lets the implementer pick the fixture, and a
fixture the code already satisfies makes the gate pass trivially.** Every gate
below names its sites, its literal invocations, and its byte thresholds.

**Sprint 01's own G4 violations, for calibration:** P0b enumerated one flag of
three; P0's audit enumerated one exit per file; P0e's gate asserted the board
survives and never that the suite is green.

> ### ⚠ A FILENAME IS NOT EVIDENCE OF A CAPABILITY — `cli.test.ts` is a coin flip
>
> **Added 2026-08-06 (sprint 02) by `cassandra`. Measured across the whole
> roster:** _of files named `cli.test.ts`, how many actually spawn a process?_
> **Glob: `find plugins/spellbook/skills -name "cli.test.ts"` → 6 files, all
> inspected.**
>
> ```
> astrolabe/scripts/cli.test.ts     spawn-primitives=1     real harness
> grapevine/scripts/cli.test.ts     spawn-primitives=3     real harness
> mind-mapper/scripts/cli.test.ts   spawn-primitives=19    real harness
> glamour/tests/cli.test.ts         spawn-primitives=0   ← NO harness
> imago/tests/cli.test.ts           spawn-primitives=0   ← NO harness
> magpie/tests/cli.test.ts          spawn-primitives=0   ← NO harness
> ```
>
> **3 of 6.** All three empty ones are **legitimate unit tests of CLI helper
> functions** — which is exactly why this is a trap and not a bug.
>
> > **Ask _"does this file SPAWN a process?"_, never _"is this file NAMED after
> > the CLI?"_ — and answer it BY CALL SITE.**
>
> **This is the mechanism that would have marked magpie PINNABLE**: the plan
> named `magpie/tests/daemon.integration.test.ts`, and anyone reaching for the
> more obvious `magpie/tests/cli.test.ts` would have found a CLI-named test
> file, matched it against _"does a harness exist?"_, and been wrong. **That one
> was caught by opening the file. The rule is cheaper than the catch.**

### G5 — every gate POSITIVELY ASSIGNS a private `TMPDIR`

**`TMPDIR=$(mktemp -d)`, not `env -u TMPDIR`.** A scrub is insufficient: an
unset `TMPDIR` still resolves to the shared machine default.

Session discovery does **not** go through `BOUNTY_HOME` — it goes to a
machine-global singleton at a fixed path. If a second bounty daemon boots inside
the test's ~200ms write→read window, the joiner resolves **someone else's
board.** Proven causally with a labelled tracer: injected daemons named
`inj-<pid>-<run>-<iter>` produced a suite failure **whose own expectation
contained the injected id.**

**The magnitude, which a coin-flip race cannot produce:** the same 1291-test
suite ran **1125s shared** and **107s private**, and the shared run's slowest
test consumed 1,020s before dying on `ConnectionRefused` to its own `/state`.

> **⚠ A green from a shared-pointer run is not weak evidence. It is NO
> evidence.**

**Repeal is per-spell and structural** — no pointer **written BY THE SUITE** at
the top level of the ambient `TMPDIR` **and** the pointer present in the
per-suite dir — **never by a sibling spell's fix landing.** See the status table
above.

> **⚠ The criterion is a property of the SUITE, not of the DIRECTORY, and the
> earlier wording said the directory.** Amended 2026-08-06 (sprint 02) after
> `thoth` nearly filed a false regression off it and killed the finding himself.
>
> A `bounty-latest.json` sitting at the top level of the ambient `TMPDIR` right
> now is **the live board daemon's**, written by `bounty/scripts/server.ts:1187`
> **by design** — a shipped-source site, which `d650c97` never touched and which
> the release section at the bottom of this plan explicitly says remains. **The
> repeal ranges over the TEST-SIDE channel.** Read as a directory property, the
> criterion pattern-matches perfectly and reports a regression that is not
> there.
>
> **Same shape as the glamour note two entries up:** _"does this suite spawn?"_
> was the wrong question and _"does this suite reach the pointer write?"_ was
> the right one. **Here: "is there a pointer in the directory?" is wrong and
> "did the suite put one there?" is right.** Both times the wrong question is
> the one you can answer without running anything.

> **⚠ G5 does NOT belong in `.anthill/config.json`'s gate string. Sprint 01
> tried exactly that and reverted it.**
>
> **A workaround left in place after its fix lands is a second, quieter source
> of truth.** Specifically: **a config-level scrub hides a regression in the
> harness fix from every seat at once** — the pointer defect could come back and
> every suite in the repo would stay green, because the shared gate is silently
> papering over it. The scrub belongs where it can be seen and removed: **in the
> gate that needs it, per gate.**
>
> **This sprint imposes per-gate hygiene on ~20 cells across four lanes, so
> hoisting it into the shared gate string is the obvious labour-saving move.**
> It is also the one already proven harmful. **Pay the repetition.**

### G6 (new) — a gate driven through `Bun.spawn` CANNOT FAIL on the drain defect

**"Through a pipe" names two different things and only one reproduces the bug.**
Measured on one board with the defect present, three readers:

```
shell pipe   cli state | wc -c                ->   65536   TRUNCATED
Bun.spawn    stdout:"pipe" + Response.text()  ->  114042   COMPLETE
sh -c        cli state | cat                  ->   65536   TRUNCATED
```

**`Bun.spawn({stdout:"pipe"})` is how `runCli` and every harness in this repo
drives a CLI.** The engine seat wrote exactly that gate, it passed, **he
restored the bug, and it passed again.**

**Use this construction verbatim** — verified in both directions (green with the
fix, RED under the mutation):

```
Bun.spawn({ cmd: ["sh", "-c", `bun run ${CLI} <verb> | cat`], stdout: "pipe" })
```

**Binds P0f directly.** Any P0f gate drafted against `runCli` needs **REWRITING,
not re-running.**

> **⚠ COROLLARY, added 2026-08-06 (sprint 02) by `cassandra`: _"does a process
> harness exist?"_ is the WRONG QUESTION — ask it once PER CAPABILITY.**
>
> **A drain cell and a termination cell have different harness requirements, and
> they come apart at the site under test.** Termination is satisfiable under
> `Bun.spawn({stdout:"pipe"})` — awaiting an exit works fine there. **Drain is
> not, by this very rule.**
>
> So a single `PINNABLE` verdict per site **flattens two capabilities into one
> word**, and the flattening is invisible: the harness genuinely exists, the
> verdict is genuinely true of one cell, and nothing in the word says which.
> **astrolabe is the worked example** — a real CLI-process harness at
> `cli.test.ts:15`, spelled `stdout: "pipe"`, **pinnable for cell 6 and useless
> for cells 1–5.**
>
> **Record the verdict per capability —
> `PINNABLE (termination) · DRIVEN-ONLY (drain)` — never one label per site.**
> _Same family as the count rule: a true word that answers a narrower question
> than the one being asked._

### G7 (new) — every drain gate asserts the process **EXITS**

**A drained-exit fix trades a truncation for a HANG wherever `process.exit` was
load-bearing.** `ec33378` did exactly that at one site and **it shipped.**

`glamour open` post-fix ran for **23 minutes** and never returned. Mechanism,
measured in isolation, both directions:

```
spawn(detached, stdio ["ignore","pipe","inherit"]); child.unref(); natural return
   -> STILL RUNNING after 6s        HANGS
same + release the child's stdout handle before returning
   -> exited                        CLEAN
```

**`unref()` releases the CHILD HANDLE. The piped stdout is a separate reffed
stream and a daemon never closes it.** Under `process.exit(code)` the parent
force-exited and the held handle was invisible.

⚠ **The shipped fix is `child.stdout.unref()`** (`62a5972`), not the
`child.stdout.destroy()` sprint 01's plan prescribed. Both were measured clean
in a synthetic repro of the exact spawn shape; `unref` is the conservative
spelling, leaving the stream usable and only stopping it from holding the loop.
**Sprint 01's plan was never amended to match. `62a5972` is the truth.**

**The lesson, which outlives the instance:** the suite was green, both P0 gates
were green, and **a 23-minute hang in a shipped spell's entry verb was invisible
to every one of them, because nothing asserts that a CLI RETURNS.**

> ### ⚠⚠ G7 AMENDED 2026-08-06 (sprint 02) — asserting the exit is not enough. The assertion must be REACHABLE when the process does not exit.
>
> **Found by `thoth` in the H7 judgement audit, driven both directions outside
> the repo. This is G8's vacuity rule turned on G7 itself:**
>
> > **Every _"the process returned"_ needs _"and my instrument could have
> > observed it NOT returning."_**
>
> **The mechanism.** A termination cell that **reads both pipes to completion
> BEFORE awaiting exit** puts its own assertion downstream of an EOF it may
> never get. `proc.kill("SIGKILL")` at the budget releases pipes held by
> **`proc`** — it does **not** release a pipe held by a **detached grandchild**,
> and `bounty open` spawns exactly such a grandchild (`cli.ts:534-540`,
> `detached: true` + `unref()`).
>
> **Measured, minimal repro, only the grandchild's stderr mode differing:**
>
> ```
> mode=file     (today's bounty)     {"ms":20,"code":0,"reachedAssertion":true,"returnedOnItsOwn":true}
> mode=inherit  (a ONE-WORD change)  exit=137 — killed at 20s, NOTHING printed
> ```
>
> **Under the change the cell does not go RED. It becomes UNREACHABLE** — and
> **the failure MODE changes with it: from a red cell naming the hung verb, to a
> bare suite timeout with no diagnosis.** A red cell tells you which verb hung.
> A timeout tells you the suite is slow. **The instrument built to catch a
> 23-minute hang would itself hang, and report nothing.**
>
> **⛔ And the reason it works TODAY is an accident of an unrelated decision.**
> `bounty/cli.ts:522-529` gives the daemon
> `stdio: ["ignore","ignore", fd→daemon.log]`, so **it holds none of the
> harness's three handles** — which is why EOF ever arrives. **That property is
> documented as being about #64 crash-trace capture. It is load-bearing for G7
> as a SIDE EFFECT, and nothing asserts it.** _(`daemon.log` appears twice in
> `server.test.ts`, both times asserting its CONTENTS, never the daemon's handle
> shape.)_ **An engineer improving #64 by inheriting stderr would break G7
> house-wide and see only a slow suite.**
>
> **BOTH remedies are required, and they do different jobs:**
>
> 1. **Make exit observable independently of the pipes** —
>    `Promise.race([proc.exited, timer])` resolved **before** the reads.
>    **Structural: removes the dependency.**
> 2. **A `PRECONDITION` cell asserting the daemon's handle shape** — that
>    `open`'s spawned daemon holds no pipe from the harness. **It goes red at
>    the moment of the one-word change, naming the reason.**
>
> **1 alone leaves the next harness author to rediscover this. 2 alone leaves
> the harness able to hang.**
>
> ### ⛔ BLAST RADIUS WALKED — 7 of 7 CLIs, by call site. **`glamour` has the hazard LIVE in its source.**
>
> **`thoth`, same session, having marked it UNVERIFIED himself.** And the
> discriminating property turned out **not** to be `Promise.all` in the harness:
> it is **whether the DETACHED daemon inherits a handle the harness can be
> holding.** So the enumeration is over every `detached: true` spawn in every
> spell's `cli.ts`, not over the test files.
>
> | spell                                  | daemon stdio                            | hazard                                             |
> | -------------------------------------- | --------------------------------------- | -------------------------------------------------- |
> | **glamour** (`cli.ts:326-331`)         | `["ignore", "pipe", "inherit"]`         | **⛔ YES — stderr INHERITED by a detached daemon** |
> | bounty                                 | `["ignore", "ignore", <fd→daemon.log>]` | no                                                 |
> | astrolabe · imago · magpie · grapevine | `["ignore", "ignore", "ignore"]`        | no                                                 |
> | mind-mapper                            | `"ignore"`                              | no                                                 |
>
> **Denominator: 7 CLIs enumerated, 7 produced a spawn site, 1 hazard.** A zero
> anywhere would have been the instrument, not the answer.
>
> **It is LATENT, not live — and that is exactly why it is written here.**
> glamour's suite contains **ZERO subprocess spawns** (enumerated by call site,
> not name-grepped); its daemon runs in-process. **So nothing hangs today.**
>
> **⚠⚠ BUT P0c CONVERTS `glamour/cli.ts` AND P0f'S TAIL SLICE TOUCHES GLAMOUR —
> and neither can be gated without a subprocess harness glamour does not have.**
> The natural move is to copy `runOpen`, the reference harness every P0b cell
> uses.
>
> > **A `runOpen`-shaped harness pointed at `glamour open` does not FAIL. It
> > HANGS past its own budget and prints NOTHING** — the exact
> > `exit=137 / nothing printed` from the driven repro above.
> >
> > **And the builder will read that as glamour being slow to boot** — its own
> > comments warn the first React bundle "can take tens of seconds cold" and
> > default the handshake to **45s**. **The most plausible wrong diagnosis
> > available is sitting in the same file.**
>
> **This is the sprint's own thesis, in a gate: a cell that cannot do the thing,
> does not do it, and does not say so.**
>
> **THE FIX FOR WHOEVER WRITES GLAMOUR'S CELL — do not copy `runOpen`
> unchanged.** Either resolve exit independently of the pipes (remedy 1 above),
> **or spawn glamour's CLI with `stderr: "ignore"` in the harness** so there is
> no pipe for the daemon to hold. **The second is one word and it is enough for
> a gate cell.**
>
> **NOT ruled: whether `glamour/cli.ts`'s `"inherit"` should change.** glamour
> is the only spell that pipes its daemon's stdout for a handshake line, so its
> stderr handling plausibly has a reason nobody has found yet. **Engine's call;
> backlog candidate either way.**
>
> ---
>
> ### ⛔⛔ AT GLAMOUR, FOUR HAZARDS STACK — and each one ALONE is fine
>
> **`cassandra`, amending her own P0f ratify. Read before writing glamour's P0f
> or P0c cell.**
>
> 1. **Shape D is the fix most likely to be reached for** — and this plan
>    already rules it **presumptively wrong** at these five sites, because
>    setting `exitCode` inside three nested loops falls through and loops again.
> 2. **glamour is DRIVEN-ONLY** — no CLI harness exists, so **one gets
>    written.**
> 3. **The obvious harness to copy is `runOpen`** — and pointed at
>    `glamour open` **it does not fail. It HANGS past its budget and prints
>    nothing.**
> 4. **glamour's own source pre-supplies the wrong diagnosis** —
>    `cli.ts:335-337` comments the first React bundle _"can take tens of seconds
>    cold"_, and the handshake defaults to **45s** for that reason.
>
> > **The one site where a shape-D hang is most likely to be INTRODUCED is also
> > the site whose new harness CANNOT REPORT a hang, in the spell whose own
> > source hands the builder a ready-made innocent explanation.** A 45-second
> > no-output run, in the spell that documents slow cold boots, reads as
> > **slow** — not **hung**.
>
> **NONE of the four is a defect. The STACK is** — and it is invisible from
> inside any one of them, which is why it took three seats, none of whom were
> looking for it.
>
> **⚠ The feasibility estimate is AMENDED with it.** glamour's
> `DRIVEN-ONLY — write a harness, or close by drive` read as though _"write a
> harness"_ were the cheap option. **At glamour it is the TRAPPED one.**

### G8 (new) — the vacuity rule, in its general form

> **Every _"X is not there"_ needs _"and the thing that would have put X there
> ran."_**

**It has bitten this project four times:** P0's sub-64KiB fixture, P0b's
degenerate precondition, the ward's empty documented-set, `probe-help2`'s
exit-127 cells. Concretely, for any drain cell: assert
`expect(bytes).toBeGreaterThan(65_536)` **before** asserting the parse, so a
fixture that silently shrinks fails loudly instead of passing vacuously.

### Standing preconditions

- **`git status` before every gate.** A gate is uninterpretable in **both**
  directions while a peer has uncommitted work **in code the gate executes**.
  _The lead published a false finding off a dirty tree and broadcast it as a
  measured result; both greens on record ran on a clean tree, both reds on a
  dirty one, across four runs._ The SOP documents the green half; **a RED is
  equally uninterpretable, and a red is far more likely to be published as a
  finding.**

  **Docs-only dirt does NOT void a gate.** Uncommitted changes confined to
  `*.md` — including this plan, the proposal beside it and any `SKILL.md` no
  gate below reads — **cannot change a measurement**, and a rule that voids on
  them is a rule that gets waived by hand, which is how the real condition stops
  being checked. **State which files were dirty when you record the run**, so
  the judgement is auditable rather than remembered. **Anything under
  `plugins/spellbook/skills/*/scripts/` voids the gate, full stop.**

- **🎲 A SINGLE RED IS NOT A FINDING — the full suite is ~1-in-4 FLAKY,
  MEASURED.**

  **Added 2026-08-06 (sprint 02) by `daedalus`, who got a red on a tree whose
  only commit was a MARKDOWN FILE and measured instead of diagnosing.**

  ```
  full suite, IDENTICAL tree, 4 runs:   1315/0 · 1315/0 · 1314/1 · 1315/0   -> 1 red in 4
  imago suite ALONE, same tree, 4 runs:  109/0 ·  109/0 ·  109/0 ·  109/0   -> 0 red in 4
  ```

  **The cell is `imago > marksUnseen freshness flag`, `ConnectionRefused` to its
  own daemon's `/state`. It fails ONLY under the full 101-file parallel suite,
  never in isolation** — daemon/port pressure, the same family as the
  shared-`TMPDIR` race this plan already documents.

  **The precondition above covers a red on a DIRTY tree. This is a red on a
  CLEAN tree that was equally uninterpretable, and nothing covered it.**

  > **RULE: re-run before you report. A red is a finding only if it
  > REPRODUCES.**

  **⛔ AND THE SECOND HALF, WHICH IS THE DANGEROUS ONE — a known flake gives
  every future red an innocent explanation.** The first-order risk is a false
  red wasting an hour. **The real risk is a REAL regression dismissed as
  _"probably the flake."_** **So: NAME the flaky cell, every time.** A red in
  `imago > marksUnseen freshness flag` is the known flake. **A red in any other
  cell is a FINDING and the flake rate does not excuse it.** _"The suite is 25%
  flaky"_ launders everything; _"this one cell is"_ launders nothing. **Record a
  non-reproducing red WITH ITS CELL NAME rather than discarding it** — a second
  sighting of the same cell is data, and a second sighting of a different cell
  is a new flake.

  _This is the THIRD time this session that an innocent explanation was
  pre-supplied to the wrong diagnosis:_ glamour's _"tens of seconds cold"_
  comment for a hang, sprint 01's remediation comments reading as defects, and
  now a measured flake rate standing ready to excuse any red. **The pattern is
  worth more than any of the three.**

  **⚠ UNVERIFIED — the PRE-P0d rate.** P0d added two more spawned daemons to
  imago's integration suite, and the rate was not measured before that change.
  **`daedalus` declined to guess, which is correct.** To close it: `git stash`
  the suite additions and run the full gate 4× at `8f4d92d`. **This is a
  RELEASE-BEAT prerequisite** — _"did we make the suite worse?"_ is a question
  the release note cannot answer with an unmeasured number.

- **📣 ANNOUNCE A FULL GATE WHEN YOU _START_ IT, NOT ONLY WHEN IT LANDS — and
  `uncheckedAgainst` CANNOT SEE THIS.**

  **Added 2026-08-06 (sprint 02) by `cassandra`, after two seats ran two full
  101-file parallel suites concurrently on one machine with 14 spell daemons
  live.** Neither seat did anything wrong: **both announce LANDS and neither
  announces RUNS.**

  > **`uncheckedAgainst` records dirty FILES. NOTHING records CONCURRENT LOAD.**

  **And this sprint measured two things that are properties of the MACHINE
  rather than of the tree** — the **flake rate** (daemon/port pressure) and the
  **drain timing** (scheduler). **For those, _"what else was running"_ is a
  precondition of the same rank as _"was the tree clean"_, and we have an
  instrument for one and nothing for the other.**

  **The asymmetry decides what to do about a run caught under load:**

  | outcome under contention | verdict                                                                                                     |
  | ------------------------ | ----------------------------------------------------------------------------------------------------------- |
  | **GREEN**                | **stands** — contention manufactures false REDS, not false passes                                           |
  | **RED**                  | **uninterpretable** — and worse, _"probably the flake"_ is pre-supplied and would be wrong for a NEW reason |

  **A measurement OF machine pressure taken UNDER machine pressure is void, not
  weakened.** _`cassandra` killed her own flake measurement rather than report
  it: she had serialised against herself, and the machine is shared._

  **⛔⛔ AND THE ANNOUNCE RULE IS NECESSARY AND NOT SUFFICIENT — IT FAILED ON
  ITS FIRST OUTING, BY TEN SECONDS.** `daedalus` followed it faithfully and
  announced — **but he announced AT the start, not BEFORE it**, so his offer
  _"say so and I will hold"_ was unactionable: by the time it was read he was
  already running, and `cassandra`'s flake re-run was contaminated **a second
  time.**

  > **An announcement is a RECORD, not a LOCK.**

  **THE MECHANICAL HALF, which does not depend on a peer being awake, reading,
  and fast:**

  ```
  ps -eo pid,etime,command | grep "[b]un test"      # if it returns anything: WAIT
  ```

  **CHECK first · ANNOUNCE second · START third — AND THEY MUST BE THREE
  SEPARATE ACTS.**

  > **⚠ THE EXACT MECHANISM, `daedalus`: he put the announcement and the gate in
  > ONE shell invocation.** The law cannot work that way — **a message that
  > leaves at the same instant as the process it warns about warns nobody.** Not
  > bad luck, not slowness: **structural.**

  **AND ANNOUNCE WITH THE OBSERVATION, NOT THE INTENT** (`cassandra`, applied to
  herself first): paste the `ps` output into the message. **A stated intent
  cannot be falsified by a reader; a pasted observation can be, in one
  command.**

  **⚠ KILLING A RUNNER SCRIPT DOES NOT KILL THE SUITE IT SPAWNED.** `pkill` on
  the wrapper left `bun test` **reparented to init and still loading the
  machine**, showing in `ps` with no obvious owner. **A seat who yields by
  killing their script and walking away is still contending. Check for orphans
  after you yield.**

  ### ⛔ AND MOST OF THIS PROBLEM IS NOT REAL — the asymmetry applies to the SCHEDULE, not only the verdict

  **`cassandra`'s reframe, which dissolves the scheduling constraint rather than
  managing it:**

  > **Contention manufactures false REDS, not false PASSES. So an arm that comes
  > back GREEN under load is a VALID GREEN — measured under MORE adverse
  > conditions than a quiet run, not fewer.**

  **Therefore a measurement does NOT need an exclusive window. It needs _k_
  greens, plus a quiet re-run for each RED.** _We ratified this asymmetry for
  reading results and never applied it to planning runs._

  **THE ONE CONDITION THAT KEEPS IT TRUE, and it is free (`thoth`):**

  > **A green under contention is valid PROVIDED THE TOTAL IS THE EXPECTED
  > ONE.** The asymmetry holds because a contended failure is a **hard fail that
  > gets counted**. It stops holding if contention could make a test **not run
  > at all** — that green is a **PARTIAL** run, and it says nothing about the
  > part that never executed.
  >
  > **Cite `pass / fail / files`. NEVER `0 fail` alone.** `1326 / 0 / 101` is a
  > valid green under any load; `1300 / 0 / 99` is **not the same claim**, and
  > the difference is invisible if you read only the fail count.
  >
  > **A RED needs a quiet machine; a GREEN needs its denominator.**

  ### ⛔ A RED UNDER CONTENTION IS NOT AUTOMATICALLY NOISE — the rule needed this clause and did not have it

  **`daedalus`, having been one step from re-running a red that was REAL.**

  > **A red under contention is uninterpretable WHEN ITS CAUSE IS ONE CONTENTION
  > COULD PRODUCE** — a timeout, a refused connection, a port collision. **A red
  > that NAMES A DETERMINISTIC CAUSE and REPRODUCES IN ISOLATION is
  > interpretable**, and re-running it burns a quiet window to re-learn
  > something you already know.

  **His red was `Unknown option '--text'` — a specific flag, in a specific file,
  reproducible in 17ms alone. Contention cannot manufacture that.**

  **⚠ THE FAILURE MODE THE UNQUALIFIED RULE INVITES IS THE MIRROR OF THE ONE IT
  PREVENTS: it pre-supplies _"probably contention"_ as the innocent explanation
  for a red that is a FINDING.** That is the **fourth** pre-supplied innocent
  explanation this sprint — and **the first one pointing AT a green rather than
  away from one.** _The others excused a symptom; this one would have DISCARDED
  a finding._

  ### ⭐ AND THE WHOLE THING COLLAPSES — a red does NOT need a quiet machine. It needs ONE CELL.

  **`cassandra`, retiring her own remedy as the expensive one:**

  > **The first move on ANY red is to RE-RUN THE FAILING CELL IN ISOLATION — not
  > the suite, and not on a quiet machine.**

  **The argument is `daedalus`'s own number: 17ms.** A single-cell re-run needs
  **no quiet window, no coordination, no announcement** — and it discriminates
  immediately:

  | isolated re-run | cause shape                       | verdict                                                              |
  | --------------- | --------------------------------- | -------------------------------------------------------------------- |
  | **fails**       | any                               | **FINDING.** Contention cannot make a test fail in isolation.        |
  | passes          | timeout · ECONNREFUSED · port     | contention-or-flake — **now** a quiet full run is worth its cost     |
  | passes          | deterministic, names a flag/value | **suspect your FIXTURE or a test-order dependency**, not the machine |

  > **Sequence: ISOLATE THE CELL (free) → only then consider a QUIET SUITE
  > (expensive).**

  **This sprint paid the expensive step first, twice.** _"The cheap step was
  available and I did not name it, which is why my rule read as 'reds are
  costly' when reds are mostly cheap."_ **The scheduling problem this rule was
  written to manage largely does not exist.**

  **⚠ `UNVERIFIED` — nobody has observed bun dropping files under pressure and
  nobody has tested it.** The guard is kept **because it costs nothing and does
  not depend on the answer**: if bun never drops a file the check is free and
  always passes; if it ever does, the check is the only thing between a partial
  green and a full one. **Same shape as the whole sprint — a green that is true
  about a smaller population than the reader assumes.**

  **This is G1's correction in the process layer:** the scrub was necessary and
  the **explicit `--session-key`** was the isolation. **Here the announcement is
  the scrub and `ps` is the explicit key.** _Same necessary-and-not-sufficient
  shape as the P0f fixture spec, three hours later, one layer up._

  **⚠ The scheduling error was the LEAD's.** I sent her to measure daemon
  pressure with the board showing P0c `doing` in front of me, and called it
  _"the only clean window it will get."_ **A window is not clean because nothing
  has landed; it is clean because nothing is RUNNING** — and the board shows
  lands, not runs. **The same blind spot the rule above names, in the surface I
  was reading it from.**

- **🌳 A BARE `git worktree` HAS NO `node_modules` — AND IT FAILS AS A PLAUSIBLE
  RESULT, NOT AS AN ERROR.**

  **Added 2026-08-06 (sprint 02) by `cassandra`, against the instrument SHE
  introduced to this team the same day.** A worktree checks out **tracked**
  files; `node_modules` is gitignored, so it is **absent**, and every surface
  test dies on module resolution:

  ```
  error: Cannot find module 'react/jsx-dev-runtime' from …/surface/GraphCanvas.tsx
  error: Cannot find package 'micromark'            from …/surface/state/markdown.ts
  ```

  **⛔ THE SHAPE OF THE FAILURE IS THE HAZARD.** `bun test` reports these as
  _"unhandled error between tests"_ **and keeps going** — so the run still emits
  pass/fail numbers that a summary parser will happily scrape.

  > **It would have produced a clean, well-formed `k of 4` in which the pre-P0d
  > suite looked catastrophically broken — and the conclusion drawn from it
  > would have been that P0d IMPROVED the suite.** Plausible, reproducible,
  > release-note-bound, **and wrong in the direction that exonerates the change
  > under test.**

  **What caught it was a BYTE COUNT TOO SMALL** — a 985-byte log where a full
  suite is hundreds of times that. **Not care, not review.** A full-length log
  with a few extra failures would have shipped.

  **Fix, and it is the MORE correct instrument rather than a workaround:**

  ```
  ln -s <repo>/node_modules <worktree>/node_modules
  ```

  The post-change figure was measured against the main repo's `node_modules`; a
  worktree with its own freshly-installed tree **differs in exactly the
  dimension nobody is controlling for.** **The symlink makes the two runs
  comparable on the only axis that matters.**

  **⚠ Scope, checked rather than assumed:** the P0b / P0d / P0f **drives** were
  unaffected — they drive spell CLIs and daemons under
  `plugins/spellbook/skills/`, which are Bun-native `.ts` with **no third-party
  imports** (Contract 3, backends ship as source). **The dependency-free backend
  is why, and that is a property of those spells, NOT of worktrees.** Anything
  reaching `src/*/surface/` needs the symlink.

  _`cassandra`'s seat doc has carried "a dev-mode daemon cannot be stood up in a
  bare git worktree" since the mind-mapper rounds. **She introduced the pattern
  to this team without carrying the caveat across.** The lesson was in the doc,
  in her own words, and it did not fire._

- **🔇 NEVER SILENCE A FIXTURE-BUILDING STEP.** `2>/dev/null` on a step you are
  about to assert nothing about is fine. **`2>/dev/null` on the step that
  CREATES the thing you measure discards the only evidence that distinguishes
  _"the fixture failed"_ from _"the fixture worked and the mechanism is
  elsewhere."_** Those two demand opposite responses, and a silenced step cannot
  tell them apart.

  _Added 2026-08-06 (sprint 02) by `cassandra`, against her own drive: she ran
  `say … >/dev/null 2>&1`, hit a degenerate precondition, and had **no
  diagnosis** — she had to re-run `say` with stderr visible to learn it had
  **succeeded**, which is what redirected her from the write to the stream._

- **Reproduce the reporter's exact spelling, not a reasonable paraphrase.** **A
  paraphrase of the input is a control that cannot come out differently, because
  it removes the variable under test while still looking like the same test.**
- **A bulk mechanical edit is where recognition fails.** Sprint 01's costliest
  defect was not a measurement whose question was too narrow — **there was no
  measurement.** A one-liner was applied across eight files as one edit, and a
  per-site precondition was never surfaced **because nobody opened the file.**
  The same engineer caught the identical pattern at `join.ts` _because he opened
  it._ **Do not treat N files as one edit. Better instruments do nothing here.**
- **A gate arm that cannot be driven is written down as a VERDICT, never left as
  an absence.** A silent 2-of-3 reads as full coverage. _And an arm that looks
  unfixturable is often an arm nobody has tried hard enough to fixture —
  glamour's `/cmd` arm was ruled `UNVERIFIABLE-PRE-FIX` and dissolved the moment
  someone booted the daemon a different way._
- **Assume the next version is wrong too.** Sprint 01 earned this on P0b's one
  control: **three separate attempts at it were degenerate, in a single
  evening**, each written by someone who had just read why the previous one
  failed. **A control that has been corrected once is not thereby correct.**
  Re-derive its pre-fix and post-fix behaviour from scratch every time it
  changes — **the correction is a new control, not a repaired one.**
- **A count travels with its denominator, or it does not travel.** **Four counts
  in this project have now been corrected for denominator reasons:**

  | count                        | what happened                                                                                                                     |
  | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
  | discovery-pointer sites      | **22 vs 19 vs 10** — three greps, three unstated globs, still unresolved                                                          |
  | `process.exit(` sites        | **44 vs 45** — same glob, two shas                                                                                                |
  | conformant parsers           | **9 vs 10** — `Bun.argv` invisible to a `process.argv` sweep                                                                      |
  | spells with a spawning test  | **"none of three"** — glob stopped at `scripts/`; the suites live in `tests/`                                                     |
  | P0c flag count               | **112 vs 118 vs 119** — five accumulators · all six entry points · **and +1 after Cole's `--unarchive` rename minted a new flag** |
  | **`process.exit(` sites #2** | **45 GREP HITS vs 35 CODE SITES** — ten hits are COMMENTS, and they are our own remediation notes                                 |

  > **⚠ The sixth row is a NEW MECHANISM and it inverts the other five.**
  > **Added 2026-08-06 (sprint 02) by `daedalus`, found while re-deriving P0f's
  > sites independently — he never reached the five; the denominator broke
  > first.**
  >
  > **The first five rows are all MISSES — a glob asking something narrower than
  > the sentence built on it. This one is a false POSITIVE.**
  >
  > Sprint 01's fix left a
  > `` // `process.exitCode` + a natural return, NEVER `process.exit(code)` ``
  > comment **at every site it repaired**. So **every site we FIX increments the
  > count of sites that look unfixed** — the remediation's own documentation is
  > textually indistinguishable from the defect it documents.
  >
  > **Two files' ONLY hit is that comment, i.e. they contain zero actual
  > calls:** `digestify/scripts/review.ts` (raw 1 · code 0) and
  > `magpie/scripts/discover.ts` (raw 1 · code 0). **Both opened by hand, not
  > trusted to a stripper.**
  >
  > **`magpie/discover.ts` is the one that stings:** it was patched, then ruled
  > **OUT** of sprint 01 — and it still answers the audit's own grep. **A future
  > enumeration re-finds a site that was correctly excluded and re-litigates a
  > closed ruling.**
  >
  > **Carry `35`, not `45`, and state which you mean.** Method:
  > `find … -name "*.ts" ! -name "*.test.ts"`, then strip lines beginning `//`
  > or `*`. _(Never a `scripts/` glob — that is row four.)_

  **The common factor is not carelessness. It is a GLOB STANDING IN FOR A
  QUESTION.** Every one of those greps was an honest measurement of something —
  just not of the thing the sentence built on it claimed. **Before you write a
  number, write the question it answers and the glob that answered it, in the
  same breath.** A figure with no denominator is a success-shaped number: it
  looks like evidence, it survives review, and it is the shape this whole sprint
  exists to stop shipping.

- **⏱ AN ARTIFACT DECAYS AS THE SPRINT IT SERVES LANDS COMMITS — and the
  sprint's own fixes are the fastest-moving invalidator of the sprint's own
  measurements.**

  **Added 2026-08-06 (sprint 02) by `cassandra`. This is a TIME AXIS and it is
  NOT the same failure as the rows above.** Every one of those is a glob asking
  the wrong question **at one instant**. Here **the measurement was right, the
  question was right, and the world moved under it — by our own hand, in the
  same week, to serve the same goal.**

  **The evidence is one commit invalidating two artifacts:** `8f4d92d` (P0b's
  land) simultaneously
  - added a `process.exit(2)` **in prose**, taking the exit-site count 45 → 46;
  - added the **first computed-key read** in the roster (`bounty/cli.ts:450`,
    `ATTACH_LOST_FLAGS.filter((f) => Boolean(flags[f]))`), **falsifying the P0c
    artifact's "zero computed-key reads" absence claim.**

  **`git log -S "Boolean(flags[f])"` returns `8f4d92d` and only `8f4d92d`.**
  **Neither artifact was re-derived, and neither would have been.**

  > **RULE: any artifact a later lane CONSUMES has its ABSENCE CLAIMS re-run at
  > the sha that CONSUMES it, not at the sha that DERIVED it.**

  **And the sha stamp is what makes the correction sayable at all.** The claim
  was **true at `f77ae33`** — its stamped derivation sha — and **false at
  HEAD**. Without _"derived at `f77ae33`"_ there is no way to distinguish
  _"thoth was wrong"_ from _"the world moved"_, and **those two demand opposite
  responses.** **Put the sha in the CLAIM, not only in the footer.**

  _Same clock as `magpie/discover.ts` re-answering an audit that ruled it out —
  but running on the ARTIFACTS rather than on the code._

---

## Lane P0b — the early return that discards a flag set (#80.1)

**Owner:** engine · **Verify:** verify seat · **D3 ruled:** non-zero exit
**and** an envelope field

### The mechanism (fact, not claim)

`bounty/cli.ts:388-397` — when `--session-key` resolves to a board that is
already live, `cmdOpen` takes the idempotent-attach branch and **returns**. The
daemon's argument list is not even constructed until **line 412**, past that
return. Nothing reports the skip.

```
412  const args = ["run", SERVER_SCRIPT];
413  if (flags.title)      args.push("--title", …)
414  if (flags.timeout)    args.push("--timeout", …)
415  if (flags.restore)    args.push("--restore", …)
416  if (flags["no-open"]) args.push("--no-open")
417  if (forcedId)         args.push("--id", forcedId)
```

**⚠ Do not enumerate the discarded set positionally.** See _"The boundary is not
a line number — it is LOST EFFECT"_ below: the obvious spelling of that
enumeration is wrong in **both** directions.

### ⚠ The lane is the FLAG SET, not `--restore` alone

**The early return silently discards `--timeout`, `--restore` AND `--title`** —
every flag appended after it. Verified against the live process, not the CLI's
own echo:

```
open --session-key K --timeout 14400   ->  "# attached to existing board"   exit 0
ps -o args= of the daemon:  server.ts --timeout 30 --no-open --id k-dae2-…
```

**The caller asked for four hours and got thirty seconds, silently.**

Sprint 01's plan enumerated **one** flag — a G4 violation inside the phase that
cites G4. **`--restore` was never the bug. The bug is an early return that
discards everything after it**, and we had been describing one of its three
symptoms.

### ⚠ The boundary is not a line number — it is LOST EFFECT

> **Enumerate by _"flag whose effect is LOST on the attach path,"_ never by
> _"flag appended past line N."_** They look like two spellings of the same set.
> **Only one of them is the set.**

Read positionally — _"anything appended past line 414"_ — the enumeration is
wrong in **both directions at once**:

| flag        | appended at | honoured on attach? | positional reading | **correct**    |
| ----------- | ----------- | ------------------- | ------------------ | -------------- |
| `--title`   | 413         | ❌ lost             | **MISSED**         | **gate it**    |
| `--timeout` | 414         | ❌ lost             | **MISSED**         | **gate it**    |
| `--restore` | 415         | ❌ lost             | gate it            | **gate it**    |
| `--no-open` | 416         | ✅ vacuously        | **WRONGLY GATED**  | **EXCLUDE it** |
| `--pin`     | **395**     | ✅ really           | never considered   | **EXCLUDE it** |

**It under-includes `--title` and `--timeout` — two of the three flags this
lane's own headline names** — because they are appended _before_ 415, not after
it. **And it over-includes `--no-open`.**

**`--no-open` must be EXCLUDED, and the reason is semantic, not positional: on
the attach path there is nothing to open, so `--no-open` is _vacuously
honoured_, not discarded.** The caller asked for a thing that is already true.
Refusing there refuses a request that was satisfied.

**⛔ This is not hypothetical, and the counter-example is quoted IN THIS
DOCUMENT.** `bounty open --session-key K --pin --no-open` appears verbatim in
P0c's caller audit — under the heading that anthill's callers **clear**. A
literal implementation of step 1 would make **every seat rejoining a live team
board exit non-zero**: a self-inflicted instance of this sprint's own thesis,
manufactured by the lane written to cure it. **The two sections must be read
together; that is why each now points at the other.**

**`--pin` is honoured too** — `cli.ts:395`, `if (flags.pin) writePin(forcedId);`
runs **inside** the attach branch, before the return. It does exactly what the
caller asked. It was absent from every earlier enumeration of this lane, in
either direction, because a positional reading never reaches a line _above_ the
return.

**The general lesson, which outlives this lane:** a line number is a proxy for
an effect, and **the proxy and the effect disagree here in both directions
simultaneously.** Cite the line when it helps a reader find the code. **Decide
by the effect.**

### ⚠ P0b is NOT covered by D1.3 (hydrate-by-default)

**D1.3 is live and ratified, so a reviewer will reasonably ask whether P0b
becomes redundant once hydration lands. Measured answer: no.**

**Hydrate-by-default addresses the DEAD-daemon respawn** — it restores a board
that is not there. **The reported failure was a board that was LIVE and EMPTY.**
Hydration never fires on that path, because there is a daemon and it is
answering. **`--restore` was the only lever, and it is the lever that is
silently discarded.**

**This is the reason P0b is a lane at all.** Do not fold it into D1.3 and do not
wait for D1.3 to land first.

### ⛔ The refusal names NO corrective verb

**D3 originally ruled the refusal should name `--fresh --restore`. That is
FALSIFIED and must not ship — the failure mode is data loss.**

```
PRECONDITION   live=0  snapshot=2     <- asserted as its own cell: VALID CONTROL

open --session-key K --restore <id>
  EXIT 0 · occurrences of "restore" in stdout+stderr: 0
  live AFTER = 0     -> --restore was INERT                       RATIFIED

open --session-key K --fresh --restore <id>
  EXIT 0
  live AFTER = 0     -> did NOT restore                           FALSIFIED
  snapshot AFTER = 0 -> AND THE SNAPSHOT IS GONE
```

**Mechanism — this is our own #73, load-bearing.** `bounty/cli.ts:398-408`, the
`live && flags.fresh` branch, tears the board down by sending
**`POST /cmd {type:"close"}`** — and **`close` writes the snapshot.** The board
being closed is the _empty_ one, so close flushes **live(0) over snapshot(2)**.
`--restore` _is_ then appended at line 415 and the new daemon _does_ restore —
**from a snapshot emptied 200ms earlier.**

> **A user in the exact situation this message is written for — live board
> empty, real data only in the snapshot — would follow the instruction and
> destroy the only copy.**

**Ruled: the refusal names no corrective verb.** The only measured sequence that
preserves the snapshot is `kill -9 <pid>` + a plain keyed `open`, and naming a
`kill -9` in a user-facing refusal is Cole's decision, not a default. **An
honest refusal that names no fix beats a helpful one that names a destructive
fix.**

### Steps

1. On the attach path, detect that **any flag whose EFFECT IS LOST** was passed.
   **The set is exactly `--restore`, `--timeout` and `--title`.** **Gate the
   SET, not one member** — and **exclude `--no-open` and `--pin`, which the
   attach path honours** (vacuously and really, respectively). **Derive the set
   by walking each flag and asking "does the attach path do what this asked?" —
   never by a line-number cutoff.** See the boundary section above for why the
   positional spelling is wrong in both directions.
2. **Exit non-zero** (D3, ratified). **Name no corrective verb.**
3. **Announce in the envelope** (D1.2's convention):
   `restoreSkipped: {requested, reason} | null` — **`null` when nothing was
   skipped, never absent.** The exit code is what a `set -e` wrapper or a
   Monitor catches; the field is what an agent parses.
4. **`SKILL.md` names the field and stops** (D1.4). Two lines at most.
5. **Pin the two load-bearing snapshot facts in `server.test.ts` as part of this
   lane** — not as a follow-up. See the construction below; **both were measured
   on 2026-08-06 and neither is guarded by any test today.** _A doc claim drifts
   under its own code and fails no gate._

### ⚠ Do not build the divergence by mutating the live board

Snapshots are **not** close-only: **`snapDirty = true` at
`bounty/server.ts:708`** marks the snapshot dirty on every board mutation, and a
flush timer drains it on a **~1s debounce**. (`:650-651` is the comment
describing this and `:1235` is the flush timer — **neither is the mark**; cite
`:708` if you cite a line at all.) So emptying live flushes an **empty
snapshot**, and the divergence the gate depends on destroys itself. "Live
unchanged after restore" is then consistent with **both** _inert_ and _restored
the same contents_.

**Reading the snapshot "immediately before the restore" does not fix it** — that
is the moment most likely to land **inside** the debounce window of the setup
step before it, and a stale read is indistinguishable from a true one. _The
reporter hit exactly this: they re-read diligently, got
`snapshot 102 / live 103`, and the number was an artifact of the race that
**arrived as evidence for the wrong model.**_

### Verified race-free construction — use this

```
1. open --session-key K --no-open ; add x2
2. poll the snapshot file until it reads 2   <- deterministic; never a fixed sleep
3. kill -9 the daemon                        <- NOT close; close writes the snapshot (#73)
4. open --session-key K --no-open            -> live 0, snapshot 2
5. assert live == 0 AND snapshot == 2        <- its own cell, before the measurement
6. open --session-key K --restore <id>       <- the measurement
```

**⚠ Where the snapshot file IS**, because steps 2, 4, 5 and 7 all read it and
none of them may guess: **`$BOUNTY_HOME/snapshots/<id>.json`**
(`bounty/server.ts:73`). **Under G1's unique-`BOUNTY_HOME` rule this is the one
path a gate must not infer** — a gate that looks in the default home polls a
file that this run never writes, sees the count it expected from some earlier
run, and reports a precondition it never established.

Step 4 respawns **empty without mutating**, so nothing is dirty and nothing is
in flight — measured stable at live `0` / snapshot `2` after 3s idle. **The
precondition in step 5 therefore has no race to lose**, rather than a race that
usually resolves in time.

**⚠ `kill -9` must not read the PID from the discovery file.** That file carries
`url`/`port`/`session_id`/`title` and **no PID** — a kill built on it silently
no-ops, step 4 "respawns" onto the still-live board, and the precondition
degenerates to live=2/snapshot=2. Step 6 then shows "live unchanged," which is
consistent with both inert and restored-same-contents. **This happened on the
first attempt and the run looked clean.** Use
`pgrep -f -- "--id <unique-session-id>"` — safe because the id is unique, unlike
the shared `scripts/server.ts` argv that once cost this repo a live daemon.

**What caught it: printing the precondition as an asserted `VALID-CONTROL` /
`DEGENERATE` cell** rather than treating step 4 as a step that obviously worked.

### Gate — subject to G1–G8

1. **`PRECONDITION`** — build the divergence with the six-step construction,
   **asserting the precondition (live `0`, snapshot `N`) as its own cell**,
   printed as `VALID-CONTROL` or `DEGENERATE`.
2. **`RED PRE-FIX`** — `open --session-key K --restore <id>` against the
   **live** board **exits non-zero** and carries `restoreSkipped`. Throwaway
   board only. _Today it exits 0 and says nothing._
3. **`RED PRE-FIX` — the `null` arm.** A normal `open` that skips nothing must
   emit the field **present and `null`**:
   ```
   assert "restoreSkipped" in envelope     // NOT the same assertion as:
   assert envelope.restoreSkipped == null  // this one passes when the key is absent
   ```
   **Only the first catches it.** A fix that emits the field only when it skips
   passes without this cell and violates the ruling.
4. **`RED PRE-FIX`, one cell per discarded flag** (`--timeout`, `--title`,
   `--restore`) — G4. A fix that refuses on `--restore` alone must fail this
   gate.
5. **`BLAST-RADIUS GUARD`, one cell per HONOURED flag** — `--no-open` and
   `--pin` on the attach path **still exit 0**, and `--pin` still writes the
   pin. **These pass today and must keep passing.** They are the cells that
   catch the over-inclusive implementation described above, in which every seat
   rejoining a live board starts failing. **Pin
   `open --session-key K --pin --no-open` as a LITERAL invocation** — it is a
   real caller, quoted in P0c's audit below.

> **⛔ Do NOT add the cell that says "then confirm `--fresh --restore` actually
> restores."** It asserts a capability that does not exist, **and running it
> destroys the fixture** the rest of the gate depends on. Whoever ran it would
> then read the resulting empty board as a failed restore rather than as the
> gate eating its own fixture.

**⚠ Task-count evidence does not travel.** A task count is admissible **only
inside a construction that pins live `0` against snapshot `N`** — that is what
makes it discriminating. Reusing a count check outside this construction is the
reporter's original error.

**Field note:** the **success** path is exactly as silent as the skip path — a
performed `--restore` prints `{url, port, session_id, title}` and nothing else.
**A positive twin of `restoreSkipped` is a real question, but do not mint a name
for it here.** It goes to the contract investigation with #85–#88.

---

## Lane P0c — the unparsed `--flag=value`, and the verb that runs anyway (#81)

**Owner:** engine · **Verify:** verify seat · **D4 ruled:** support `=` **and**
reject unknown flags **Prerequisite artifact:**
[`artifacts/p0c-recognized-flag-sets.md`](../../artifacts/p0c-recognized-flag-sets.md)
— **the builder CONSUMES this; do not re-derive it.**

**Build LAST** — see [lane order](#lane-order--build-in-this-sequence). This
lane reshapes edit sites the other three lanes own.

**House-wide, widest blast radius, and the only lane that silently corrupts
writes.**

### ⛔ BLOCKED — the prerequisite artifact carries NAMES, NOT TYPES

**This lane cannot start against the artifact as it stands, and the plan
previously did not know that.** `p0c-recognized-flag-sets.md` records **which
flags each entry point recognizes. It records no types.** `node:util`
`parseArgs` requires `{type: "boolean" | "string"}` **per option** — so the
artifact answers half of what step 2 needs, and the half it does not answer is
**~112 individual judgement calls the plan believed were already made.**

> **⚠ COUNT CORRECTED 2026-08-06 (sprint 02) by `thoth`, who re-derived it with
> an independent instrument: the figure is 118, not 112 — and the two numbers
> below answer different questions.**
>
> | figure  | question it answers                                             |
> | ------- | --------------------------------------------------------------- |
> | **112** | flags across the **five accumulator** parsers                   |
> | **118** | flags across **all six converted entry points**, at derivation  |
> | **119** | **after `--unarchive` was minted by Cole's rename** — see below |
> | **169** | **LINES** matching a `flags.` read in the five accumulators     |
> | **249** | **READ EXPRESSIONS** across all six                             |
>
> **This document said "112 flags at the 6 converted entry points" — which glues
> two denominators together.** `glamour/server.ts` is the sixth and contributes
> **6** (`intent port project restore timeout title`); the 112 excludes it.
>
> **⏱ AND THE FIGURE HAS ALREADY DECAYED, BY THIS PLAN'S OWN RULE — 118 → 119.**
> **Cole's `--restore`/`--unarchive` ruling MINTED A FLAG that did not exist
> when the table was derived.** `thoth` caught it on his own artifact,
> proactively, **by applying the decay rule he had landed two hours earlier** —
> the first time that rule has fired on the seat who wrote it, and the first
> time it has fired **before** anyone consumed a stale row.
>
> **⚠ A RULING IS AN INVALIDATOR TOO.** The decay rule was written about
> **commits** moving the tree under an artifact. **A human decision that mints a
> name moves it just as hard, and nothing about it looks like a commit** — it
> arrives on the wire, not in `git log -S`.
>
> **And "169 consumption sites" is LINES, not reads.** A type derivation done
> per-LINE misses **80 read expressions**, and several conflicts live on shared
> lines. **Per-flag counts reproduced the artifact exactly in all five
> accumulators (22/25/26/20/19) by a different instrument** — that pair is
> corroboration; the totals were not.

**Getting one wrong is not a no-op.** The two failure shapes, both silent enough
to ship:

```
--mine   declared "string"   ->  swallows the NEXT POSITIONAL as its value
--owner  declared "boolean"  ->  `--owner alice` breaks; alice becomes a positional
```

**The first is the dangerous one** — it is the same class this lane exists to
fix, re-introduced by the fix, and on `add`/`message` it eats prose.

> ### ⛔⛔ `strict: true` GUARDS THE NAME, NOT THE TYPE. There is NO automatic discriminator for a wrong row.
>
> **Measured by `thoth`, `node:util` `parseArgs`, Bun 1.3.14, four arms —
> falsifying a claim the LEAD made without measuring it:**
>
> ```
> --mine typed STRING,   positional follows        -> NO ERROR  {values:{mine:"t-abc123"}, positionals:[]}
> --owner typed BOOLEAN, value follows             -> NO ERROR  {values:{owner:true}, positionals:["alice"]}
> --owner typed BOOLEAN, allowPositionals:false    -> THREW     "Unexpected argument 'alice'"
> UNKNOWN flag under strict:true                   -> THREW     "Unknown option '--nosuchflag'"
> ```
>
> **Both wrong-type cases parse SILENTLY AND WRONGLY, exit 0.** The `--mine`
> case is the worse half exactly as stated above: **the positional is swallowed
> and `positionals` comes back EMPTY** — on `add`/`message` that is the task
> title vanishing.
>
> **So a wrong type row does NOT show up as a red test on its own.** It shows up
> only if **a cell asserts the PARSED RESULT.**
>
> **⚠ The discriminator IS available — but not where the harm is.** With
> `allowPositionals: false`, the boolean-typed-value case **does** throw. **The
> entry points that take free prose cannot use it:** `bounty add` (`cli.ts:775`)
> and `bounty message` (`:895`), both `pos.join(" ")` — **and those are the two
> verbs this plan already identifies as the live write-corruption sites.**
>
> > **The mechanism that would catch a wrong type is unavailable precisely on
> > the verbs where a wrong type corrupts a write.** Not irony — the same
> > structure twice: **free positionals are what make the corruption possible
> > AND what disable the guard.**
>
> **REQUIRED REPORT WHEN P0c LANDS — THREE buckets, never two:**
>
> | bucket                                                                    | status                                     |
> | ------------------------------------------------------------------------- | ------------------------------------------ |
> | exercised by a cell asserting the **parsed result**                       | **genuinely guarded**                      |
> | exercised only by a cell asserting **exit code / unknown-flag rejection** | **guarded against the NAME, not the TYPE** |
> | unexercised                                                               | **unguarded**                              |
>
> **The middle bucket is why this is written down: it looks like coverage in any
> count that has two buckets.**
>
> **⚠ And the class of the lead's error is worth more than the error.** `thoth`
> named it: **a sentence telling a reader something need not be checked.** A
> wrong fact is corrected by the next person who looks. **A false reassurance
> gets no corrective feedback — it is read while planning, and only tested by
> someone who tries to reach the thing it told them not to check.** Left
> standing, it would have told this lane that its 119 unverified rows were
> self-checking.

> ### ⛔ RULED BY COLE 2026-08-06 — `glamour/cli.ts --restore` is renamed, because it CANNOT be typed
>
> **`thoth` found a flag with no correct type, and both spellings are PUBLISHED
> in `glamour/SKILL.md`** — so this is not an internal inconsistency, it is two
> shipped contracts `parseArgs` cannot both honour from one `options` map.
>
> | site                         | semantics                              | documented at  |
> | ---------------------------- | -------------------------------------- | -------------- |
> | `cli.ts:254` `style archive` | `flags.restore !== true` — **BOOLEAN** | `SKILL.md:180` |
> | `cli.ts:317` `open` spawn    | `String(flags.restore)` — **STRING**   | `SKILL.md:167` |
>
> **Both failure modes are silent:** declare `boolean` and `open --restore <id>`
> drops the id into positionals, forwarding `--restore true` so the daemon hunts
> a snapshot named `true`. Declare `string` and `style archive <id> --restore`
> either throws _"argument missing"_ or **swallows the next positional as its
> value — this sprint's own defect class, re-introduced by the fix.**
>
> **RULING: rename the BOOLEAN one.** `style archive <id> --restore` becomes
> **`--unarchive`**.
>
> ```
> parseArgs options:  restore: {type:"string"}   unarchive: {type:"boolean"}
> :254 becomes:       archived: !flags.unarchive
> ```
>
> **Why that one and not the other:** `--restore <id>` is the **house-wide**
> spelling — bounty, imago, magpie, glamour's own `open`, and
> `glamour/server.ts` all mean _restore a session from an id_. **`style archive`
> is the sole outlier**, `--unarchive` is a better name for the inverse of
> archive, and the rename **kills the live bug below by construction**.
>
> **⚠ A live bug sits underneath this, independent of P0c, reported by `thoth`
> and deliberately NOT fixed by him:** `:254` reads `flags.restore !== true`, so
> if `restore` holds a **string** the expression is `true` and
> **`glamour style archive <id> --restore foo` ARCHIVES instead of restoring —
> exit 0, no signal.** The rename dissolves it. **Candidate issue; filing is
> Cole's.**
>
> **`glamour/SKILL.md:180` must be updated in the same change.** A doc that
> teaches the old spelling after the rename is a second, quieter source of
> truth, and it is the one an agent reads.

**Prerequisite step 0 (blocking):** **derive and record the type of every flag
at every one of the six converted entry points**, into the same artifact, **read
off the code that consumes the flag** (`typeof flags.x === "string"`,
`String(flags.x)`, bare truthiness) — **not off `SKILL.md` and not off the
flag's name.** **The lane is BLOCKED until that file exists.** A type table
derived during the edit, flag by flag, is 112 unreviewed decisions distributed
across a bulk change — **exactly the shape the bulk-edit precondition forbids.**

### The mechanism (fact, not claim)

`bounty/cli.ts:291-313`'s `parseArgs` splits on whitespace only, so
`--owner=forager` yields a flag literally named `owner=forager` with value
`true`, and `flags.owner` stays `undefined`. Downstream,
`typeof flags.owner === "string"` is false → `scope.owner` is undefined →
`cmdState`'s `if (scope.owner || scope.mine)` block never runs → **the
unfiltered board prints, exit 0.** `--mine` is unaffected only because it is
boolean and takes no value — that asymmetry is what disguised this as an
`--owner` defect.

Reproduced on a 5-task board (no large or recovered board needed):

```
state --owner forager        → 3 tasks  ["forager"]                     correct
state --owner=forager        → 5 tasks  ["forager","maestro","None"]    whole board
state --owner=zzz-nobody-zzz → 5 tasks  ["forager","maestro","None"]    whole board, exit 0
add "x" --owner=maestro      → {"ok":true,"sent":"task.add"}            stored owner = NONE
add "y" --status=doing       → {"ok":true,"sent":"task.add"}            stored status = todo
state --totally-bogus-flag z → exit 0, stderr empty
```

### ⚠⚠ Step 2 is what stops `close --help` from closing the board

**Lead with this. It is the most important user-facing fix in the sprint.**

**`bounty close --help` CLOSES THE BOARD.** `--help` is unrecognized, the
hand-rolled parser discards it, and **the verb runs.** `state --help` dumps the
board; `tail --help` opens the stream and never exits. The three verbs that
reject do so **by accident** — they demand a positional.

**The harm statement belongs in #81, and #81 currently leads with the wrong
half:** _an unrecognized flag is not ignored — the verb executes anyway, so on a
destructive verb it is a destructive act with no signal._

**Making `--help` actually print help is NEW BEHAVIOUR and is not in scope.**
Step 2 fixes the destructive half by construction.

### The target set — by ENTRY POINT, never by spell

**16 arg-parsing entry points across 8 spells.**

| parser                                          | count  | `=` support      | unknown-flag rejection |
| ----------------------------------------------- | ------ | ---------------- | ---------------------- |
| `node:util` `parseArgs`, **all `strict: true`** | **10** | **YES — native** | **YES — already**      |
| hand-rolled                                     | **6**  | no               | no                     |

**The 6 hand-rolled parsers are the ENTIRE fix:** `bounty/cli.ts`,
`glamour/cli.ts`, **`glamour/server.ts`**, `grapevine/cli.ts`, `imago/cli.ts`,
`magpie/cli.ts`.

**The 10 already correct — MUST NOT BE TOUCHED:** `astrolabe/cli.ts`,
`astrolabe/server.ts`, `bounty/server.ts`, `bounty/join.ts`,
`digestify/review.ts`, `imago/server.ts`, `magpie/server.ts`,
`magpie/discover.ts`, `mind-mapper/cli.ts`, `mind-mapper/server.ts`.

**⚠ "Already conformant" is a claim, and it has ONE drive behind it — not ten.**
The drive, recorded so the arm is not merely asserted:

```
astrolabe/scripts/cli.ts nosuchverb --port=9999   ->   Unknown option '--port'
```

**That is D4's target behaviour, already shipping, in a sibling.** It proves the
`strict: true` shape does what step 2 wants and gives the six converted parsers
a reference answer to match. **It does not prove the other nine.** Those are
covered by the regression half of the gate — **`ALREADY CONFORMANT` is a
blast-radius label, never evidence the fix works** (see the partition below).

> **⚠ How this table was got wrong once, because the same instruments are still
> lying around.** An earlier version said 15 / 6 / 9 and filed
> `magpie/discover.ts` as hand-rolled.
>
> | detector                                   | could not see                             | consequence                                  |
> | ------------------------------------------ | ----------------------------------------- | -------------------------------------------- |
> | `grep 'from "node:util"'` (classifier)     | a **dynamic** `await import("node:util")` | `discover.ts` misfiled as hand-rolled        |
> | `grep "process.argv"` (entry-point finder) | **`Bun.argv`**                            | **`glamour/server.ts` never counted at all** |
>
> **`glamour/server.ts:486-497` is a hand-rolled parser that was missing from
> the set entirely** —
> `args.indexOf(\`--${name}\`)`, so no `=`, no rejection, no positionals. **It parses `--restore`.\*\*
>
> **The hand-rolled count staying at 6 is a COINCIDENCE** — `discover.ts` left
> the set and `glamour/server.ts` entered it. **A number that did not move makes
> this look like a one-word edit. It was a re-derivation.** _Both greps were
> honest measurements. The failure was not "did you check" but **"what can the
> check not see."**_

**Two shapes, not one job done six times.** `glamour/server.ts` is a **lookup**
parser — recognized set already enumerable, exactly six literals
(`intent port project restore timeout title`), mechanical, low risk. The other
five are **accumulators** —
`for (a of args) if (a.startsWith("--")) flags[key] = …` — where **no recognized
set exists to convert. Step 2 must AUTHOR it.**

**⚠ Once `strict: true` lands, a missing flag becomes a caller-facing hard
error.** `--no-open` appears in four of the five and is used by the spells' own
daemon spawns — **a naive derivation breaks four spells' internal machinery.**

### The corruption is LIVE today — this changes the lane's justification

Sprint 01's plan, its HANDOFF and its convene brief all said
`add write the --draft section` "becomes a hard error the moment step 2 lands."
**All three were wrong in the way that matters.** The shipped `parseArgs`, run
verbatim:

```
["write","the","--draft","section"]        -> pos.join(" ") = "write the"       flags {draft:"section"}
["fix","the","--stdin","handler","later"]  -> pos.join(" ") = "fix the later"   flags {stdin:"handler"}
```

**Both exit 0 today.** The first silently truncates a task title. The second
**deletes two words from the middle of a sentence and simultaneously flips a
real behavioural flag (`--stdin`)** — on `message`, the verb `SKILL.md`
advertises for conversational use.

> **Step 2 does not break these callers. They are already broken, silently, and
> step 2 is what makes an existing corruption audible.**

The `--` terminator is **not** a mitigation for a behaviour change we are
choosing to make — **it is the fix for a live write-corruption bug.** It also
hands the gate a control it could not otherwise have: **a
positional-preservation test asserting `"fix the --stdin handler later"`
survives FAILS ON TODAY'S CODE.** Every other P0c assertion can only be written
against post-fix behaviour.

### Steps

1. **Support `--key=value`** — split on the **first `=` only**, so values
   containing `=` survive.
2. **Reject unrecognized flags** (D4): non-zero exit, **the offending flag named
   in the message.** Do it **once at parser altitude**, not per verb. Resolve
   the prose-positional collision in the same change — a `--` terminator is the
   conventional answer, and `--stdin` already exists as the escape hatch for
   both affected verbs.

   **⚠ The likely correct fix is not "add a registry to the bespoke parser," it
   is "DELETE the bespoke parser."** Replacing `bounty/cli.ts:291-313` with
   `node:util` `parseArgs({strict: true, options})` yields `=` support,
   unknown-flag rejection **and** the `--` terminator — all three from the
   standard library, in the shape ten siblings already use. **That makes "three
   spellings of one idea" impossible by construction rather than by
   discipline.**

   **But it is real per-verb work:** `node:util` strict **throws** where the
   hand-rolled parser **returns**, and the `allowPositionals` interaction with
   `add` (`bounty/cli.ts:775`) and `message` (`:895`) free prose — both
   `pos.join(" ")` — is exactly where the reference implementation broke seven
   tests.

3. **Apply to all SIX hand-rolled entry points.** Track by **entry point, never
   by spell** — a per-spell checklist marks a spell done with a live defect
   still in it, because `glamour`'s `cli.ts` and `server.ts` are two different
   parsers.
4. **Regression tests on three axes** — see the gate.
5. **The ward, held until the whole lane lands** (owner: grimoire seat):

   > **Every flag named in a spell's `SKILL.md` is in the recognized set of the
   > ENTRY POINT that actually parses it, and every recognized flag across all
   > of a spell's entry points is documented.**

   **⚠ The naive "that CLI" version is worse than no ward.** bounty's `SKILL.md`
   documents three entry points — `--port`/`--host` belong to `server.ts`,
   `--url` to `join.ts`, and neither appears in `cli.ts` — so a doc-vs-`cli.ts`
   check reports **three false positives on bounty today**, and **a check that
   cries wolf on correct code gets switched off.**

   **Ruled: HOLD the whole ward until P0c lands, then add all 16 at once.** A
   ward covering 10 while six known-broken parsers sit outside it is a checklist
   item that passes and **reads as coverage.**

   **⚠ Scope by CLI, not by regex.** The only `=`-form examples under the plugin
   are four lines in `imago/references/mediaforge.md`, and **`media-forge` is an
   external tool that is legitimately `=`-spelled.** A regex-driven sweep would
   "correct" them and **corrupt correct documentation.**

**The recognized set is CODE, not prose.** The registry lives in the parser;
`SKILL.md` documents it; the ward checks they agree. **Do not derive the
recognized set from `SKILL.md`, and do not let the doc become the registry.**

### Reference implementation

**anthill's `define.ts`** landed this exact fix for the positional version of
the same class, across 21 commands: split on `=` at parse time
(`if (!arg.includes("=") && isValueFlag(...))`) plus rejection at **parser
altitude**. **Two scars come with it, both paid for:**

- **Fix at parser altitude, not per-verb.** Their first attempt scoped the guard
  to one verb's `run()` and reached **1 of 13** leaves.
- **Positionals are what break.** Their first guard broke **seven tests**.
  Bounty is more exposed than anthill, not less — there is no `--` terminator
  anywhere in `bounty/cli.ts` today.

  **And the remedy that stopped it recurring is the part worth copying:
  `define.ts` pins THREE positional controls, one per shape of positional it
  has.**

  ```
  commit -- <paths>       trailing-list positional, behind the terminator
  comms send <body>       free-prose positional
  join <handle>           single-token positional
  ```

  **They are pinned as literal invocations and they run on every change to the
  parser.** That is the worked example for this lane's cell 5, which asks for
  positional preservation **per affected verb** — anthill's answer to "which
  verbs?" was **one per positional SHAPE, not one per verb**, which is why three
  cells hold thirteen leaves. **Copy the shape, not the count:** bounty's shapes
  are free prose (`add`, `message`) and single-token ids.

**anthill's caller audit clears.** Their complete invocation set is four calls
(`bounty state`, `bounty sessions`,
`bounty open --session-key … --pin --no-open`, `grapevine who <channel>`), all
space-separated, and they call neither `add` nor `message`. **The check is still
ours to run for every other caller.**

> **⚠ The third call is load-bearing for P0b, not just for this audit.**
> `bounty open --session-key K --pin --no-open` is **how every anthill seat
> rejoins a live team board** — so it hits P0b's idempotent-attach path, with
> two flags, on every session. **P0b must NOT refuse it**: `--no-open` is
> vacuously honoured there and `--pin` is really honoured (`cli.ts:395`). See
> _"The boundary is not a line number"_ in P0b. **A P0b implementation that
> enumerates its refusal set positionally breaks this exact invocation, and this
> plan quotes it in one section as proof the callers are fine while instructing
> the failure in another.** Read the two together.

### Gate — subject to G1–G8

1. **`RED PRE-FIX` — `--owner=zzz-nobody-zzz` → ZERO tasks.** **Not**
   `--owner=alice` → some tasks. **A bogus value through the `=` form is the
   discriminating cell; a valid one is the paraphrase that hid this bug for a
   round.**
2. **`RED PRE-FIX` — unknown flag exits non-zero, naming the flag.**
3. **`RED PRE-FIX` — `close --help` does NOT close the board** — the destructive
   arm, stated as its own literal invocation.
4. **`RED PRE-FIX` — write path: `add --owner=<name>` stores the owner.** A
   read-only gate misses the worse half.
5. **Positional preservation, per affected verb, pinned as LITERAL invocations —
   SPELLED WITH THE `--` TERMINATOR.**

   ```
   RED PRE-FIX   add -- write the --draft section
                   -> title survives verbatim: "write the --draft section"
   RED PRE-FIX   message -- fix the --stdin handler later
                   -> body survives verbatim: "fix the --stdin handler later"
   ```

   > **⚠ The un-terminated spellings are an INVERTED CONTROL and can never
   > pass.** This cell used to pin `add write the --draft section` and
   > `message fix the --stdin handler later` bare, and post-fix **both are
   > REQUIRED to fail**:
   >
   > - `--draft` is unrecognized, so **cell 2 requires a non-zero exit** while
   >   this cell required the positional to survive. **A direct contradiction
   >   between two cells of the same gate.**
   > - `--stdin` **is** recognized (`bounty/cli.ts:895`), so post-fix it parses
   >   as a legitimate boolean, `message` reads an empty stdin, and the verb
   >   dies on usage. **Recognized is worse than unrecognized here**, because it
   >   fails inside the verb rather than at the parser.
   >
   > **Both are the fix WORKING, not a regression.** Step 2 mandates the `--`
   > terminator and the old literals never adopted it — the gate was written
   > against a spelling the fix abolishes.

   **This is not a paraphrase and the no-paraphrase precondition still binds.**
   It is the **corrected spelling of the same test**: same prose, same embedded
   flag-lookalikes, same verb — the terminator is the interface the fix provides
   for exactly this input. **Do not re-soften the prose to something with no
   `--` in it; that would be the paraphrase.**

   **Also assert the un-terminated forms FAIL** (`RED PRE-FIX`: today they exit
   0 and silently corrupt) — one cell each, asserting non-zero exit for
   `--draft` and a usage failure for `--stdin`. **That pair is what makes the
   terminated pair discriminating**, and it is the only place in P0c where
   today's behaviour is directly pinned.

6. **`BLAST-RADIUS GUARD` — enumerate the ENTRY POINTS, and PARTITION them.**

**⚠ A green across all 16 entry points is ~60% VACUOUS and reads as the
opposite.** The 10 `node:util` entry points pass this gate **before the fix and
after it** — no result they produce can fail. **Report the two populations
separately:**

```
CONVERTED (6, discriminating): bounty/cli.ts glamour/cli.ts grapevine/cli.ts
                               imago/cli.ts magpie/cli.ts glamour/server.ts
ALREADY CONFORMANT (10, regression-only): astrolabe/cli.ts astrolabe/server.ts
                               bounty/server.ts bounty/join.ts digestify/review.ts
                               imago/server.ts magpie/server.ts magpie/discover.ts
                               mind-mapper/cli.ts mind-mapper/server.ts
```

**The 10 are worth running as a regression check that the change did not break
them, but they must not be counted as evidence the fix works. A single "16/16
green" is a true number that means far less than it looks like.**

Pre-fix baseline, measured on a throwaway board:

```
--owner alice           -> 1 task  ["alice"]                correct
--owner=alice           -> 2 tasks ["alice","maestro"]      whole board
--owner=zzz-nobody-zzz  -> 2 tasks ["alice","maestro"]      whole board
--totally-bogus-flag z  -> exit 0
```

---

## Lane P0d — writes that report success without applying (#83, #84)

**Owner:** engine · **Verify:** verify seat · **No decision needed** — these are
defects against an existing contract, not a new convention.

### #83 — `bounty add` is the only write verb that ignores `applied`

`bounty/server.ts:266` declares
`type ApplyResult = { ok: true; applied?: boolean; error?: string }` and returns
`applied:false` when `validateTask` rejects the task or `applyTaskAdd` refuses
it. **`bounty/cli.ts:793` discards the result:**

```ts
await postCmd(session, { type: "task.add", task }, { as }); // no `const res =`
```

**It is the odd one out** — `update` (`:821`), `claim` (`:838`),
`block`/`unblock` (`:864`) and `remove` (`:883`) all check. **So this is an
oversight, and the fix is to match its four siblings, not to invent anything.**

⚠ `message` (`:897`), `close` (`:918`) and the generic (`:914`) also ignore it.
**`close` ignoring a failed apply belongs in the same pass** given what P1 says
about `close`.

### #84 — `/cmd` answers `ok:true` before it knows

**⚠ This is NOT an `await` bug, and `imago` is the disproof:**

```ts
// glamour server.ts:359  — not awaited …          returns {ok:true}
handleAgentMsg(b as AgentCommand);
return Response.json({ ok: true });

// imago server.ts:1182-1190  — AWAITED, correctly … returns {ok:true} anyway
await handleAgentMsg(body as Record<string, unknown>);
return new Response('{"ok":true}', …);
```

**`imago` already does the thing the original fix was going to instruct.** The
defect is that **the route returns `ok:true` unconditionally, and
`handleAgentMsg` hands it nothing to report.** Adding `await` to glamour makes
glamour resemble imago — **which is also broken.**

`magpie/server.ts:635` is the same shape. **In those three spells `ok` means _"I
parsed your JSON."_ In bounty and astrolabe it means _"the write took effect."_
One word, two meanings, five spells.**

### Steps

1. #83: capture the result and **fail loudly, naming the id and the reason.**
2. #83: do the same for `close`; **decide `message` and the generic explicitly
   and record the decision either way.**
3. #84, two parts — **and the first part is the one an `await`-shaped fix
   hides:**
   - **`handleAgentMsg` must RETURN a verdict** in all three spells. Today it
     returns nothing, so there is **no decision for the route to propagate.**
     This is the real change and it is **inside the handler, not at the route.**
   - **The route must propagate that verdict** instead of returning a literal
     `ok:true`. `await` is necessary here but nowhere near sufficient.

   ⚠ **Gate on the VERDICT, not on the presence of an `await`** — an
   `await`-shaped check passes against imago **today, unfixed.**

4. **Do not invent a new field name. Use `applied`** — it exists in the code at
   `bounty/server.ts:266`. The vocabulary question is #82's and is **on hold.**

   > **⚠ `applied` is NOT documented in `bounty/SKILL.md`.** This plan cited
   > `:228` and `:680` as documentation; **both use "applied" as an ordinary
   > English verb.** The citation is withdrawn.
   >
   > **It is worse than an absence — `SKILL.md:679-681` documents the BUG as the
   > contract and teaches the workaround:**
   >
   > > _"A `cli.ts add`/`update` returns `{ok:true, sent:…}` — that's a
   > > transport ack, not proof the daemon applied your intent. When it matters,
   > > follow with `cli.ts state`."_
   >
   > `:228` repeats it. **P0d changes that contract**, so those two passages
   > become false the moment step 1 lands.

   > **⚠ The vocabulary freeze guards the WRONG direction, and this matters
   > here.** `restoreSkipped`, `snapshotBackedUp` and `hydrated` have **zero
   > repo hits** — so "mint no new names" is trivially satisfiable and protects
   > nothing. **The real hazard is the inverse: they all get written for the
   > FIRST time, in different lanes and possibly different sessions — and a
   > first spelling has no prior spelling to disagree with, so no grep, no test
   > and no reviewer catches a divergence.** The grimoire seat holds the three
   > spellings and checks them **at each land.**

5. **Budget a `bounty/SKILL.md` edit as part of this lane** — not as release
   tidy-up. Rewrite `:679-681` and `:228` so they describe the post-fix
   contract, **and document `applied` for the first time.** _A doc that teaches
   a workaround for a fixed bug is a second, quieter source of truth, and it is
   the one an agent reads._ This lane is the only place in the sprint that knows
   what the new contract says.

### Gate — REPLACES a defective original. Subject to G1–G8

> **⛔ Do NOT run the old gate.** It said: _"`add` with a duplicate `--id` exits
> non-zero **and** a subsequent `state` does not show the task."_

**Why it was defective — an INVERTED CONTROL, the failure mode G2 exists to
catch.** `applyTaskAdd` (`bounty/server.ts:410`) is
`if (state.tasks.some(t => t.id === task.id)) return false;` — it does **not**
overwrite and does **not** push. **On a duplicate id the board is completely
unchanged, and the original keeps that id by construction.** So _"a subsequent
`state` does not show the task"_ **fails against a correct fix**: the only way
to satisfy its literal reading is a fix that also destroys the original.

**A gate whose plain reading fails the correct implementation is worse than a
decorative one.** Decoration passes silently; this one produces a **false FAIL**
and sends the builder to "fix" `applyTaskAdd`, which is already right.

**Replacement — three cells: ONE red pre-fix, TWO blast-radius guards.**

> **⚠ The earlier draft of this gate labelled all three "discriminating" — and
> then explained, two paragraphs later, exactly why two of them cannot be.**
> That is a **`3/3 discriminating` report where the true figure is 1**: the
> success-shaped lie this sprint is named for, produced by the instrument built
> to catch it. **The labels below are the fix.** See G2's two-label rule.

1. **`RED PRE-FIX`** — `add` with a duplicate `--id` **exits non-zero** and the
   envelope reports **`applied: false`**. _Today it exits 0 with
   `{"ok":true,"sent":"task.add"}` — see the baseline below. **This is the only
   cell of the three that proves the fix.**_
2. **`BLAST-RADIUS GUARD` — the surviving row is unchanged** — `title`, `owner`,
   `status`, `enteredStatusAt` are all still the ORIGINAL's. **Already true
   pre-fix**, because `applyTaskAdd` (`bounty/server.ts:411`) returns `false`
   without touching state. **Do not try to make it red.** It catches a fix that
   silently overwrites — the failure mode the old literal reading could not see
   at all — and that failure mode is introduced only by the change itself.
3. **`BLAST-RADIUS GUARD` — task count unchanged AND `cursor` unchanged.**
   **Also already true pre-fix** — the baseline below prints
   `cursor 2 → 2 (unchanged)` **before any fix lands.** Cursor is the cheapest
   strong tell that the daemon refused rather than applied-then-reverted, and it
   is worth keeping for exactly that; it is not evidence the fix works.

**Report it as `1 red pre-fix + 2 blast-radius guards`, never as
`3 cells green`.** _Both categories are legitimate. Conflating them either
wastes a builder's day manufacturing a failure that should not exist, or ships a
coverage claim three times its true size._

Pre-fix baseline, measured on a throwaway board:

```
add "ORIGINAL TITLE" --id dup-probe --owner alice -> {"ok":true,...} exit 0
add "IMPOSTOR TITLE" --id dup-probe --owner bob   -> {"ok":true,"sent":"task.add"} exit 0   <- #83
state -> 1 task: id=dup-probe title="ORIGINAL TITLE" owner=alice   cursor 2 -> 2 (unchanged)
```

**Second half — all three arms MEASURED, none inferred.** The fixture is a bogus
`type` on `/cmd`:

| spell     | answer to a command it silently drops |
| --------- | ------------------------------------- |
| `imago`   | **`{"ok":true}`**                     |
| `magpie`  | **`{"ok":true}`**                     |
| `glamour` | **`{"ok":true}`**                     |

```
glamour  {"type":"zzz-not-a-real-command"}  ->  {"ok":true}
glamour  {"type":"say","text":"probe"}      ->  {"ok":true}
glamour  malformed JSON                     ->  {"error":"bad json"}
```

**The third row is what makes the first discriminating:** the daemon _can_
reject, so `{"ok":true}` to a command it drops is a real answer rather than an
everything-is-fine stub.

**Labels for the three cells this half becomes:** _"a bogus `type` on `/cmd`
answers non-`ok`"_ is **`RED PRE-FIX`** in each of the three spells (the table
above is that red, measured). _"a valid `{"type":"say"}` still answers `ok`"_ is
a **`BLAST-RADIUS GUARD`** in each — green today, and the cell that catches a
verdict propagation that rejects everything.

⚠ **Do not extend this lane to #85–#88.** Same family, deliberately out of
scope.

---

## Lane P0f (slice) — the five `tail` `write→exit` pairs

**Owner:** engine · **Verify:** verify seat · **THIS IS A SLICE. The rest of P0f
stays deferred — do not fold it back in.**

**P0's audit enumerated ONE exit per FILE — the `main()` wrapper. The defect's
unit is the SITE.**

### The five sites, pinned to `7a32677`

**The invariant shape is the PAIR — a terminal `write` on one line, a
`process.exit` on the next:**

```ts
process.stdout.write(`${payload}\n`); // ← may carry a scope guard, or none
if (ev.type === "closed") process.exit(0);
```

**⚠ The scope guard is NOT part of the shape.** **THREE of the five sites are
bare**, not one:

| spell         | file                       | line at `7a32677` | write spelling      |
| ------------- | -------------------------- | ----------------- | ------------------- |
| **bounty**    | `bounty/scripts/cli.ts`    | **595**           | guarded             |
| **magpie**    | `magpie/scripts/cli.ts`    | **280**           | **BARE — no guard** |
| **astrolabe** | `astrolabe/scripts/cli.ts` | **222**           | guarded             |
| **imago**     | `imago/scripts/cli.ts`     | **281**           | **BARE — no guard** |
| **glamour**   | `glamour/scripts/cli.ts`   | **500**           | **BARE — no guard** |

_The numbers pin the `process.exit`; the write is the line above it — glamour's
is `:499`, imago's `:280`, magpie's `:279`._

> **⚠ CORRECTED 2026-08-06 (sprint 02) by `cassandra`. The earlier table said
> four guarded and glamour alone bare, and built a search instruction on it:**
> _"glamour is the one site a builder must find by shape."_ **That sentence was
> wrong and it was load-bearing.**
>
> **Measured at `f77ae33` by two methods sharing no mechanism** — an adjacency
> scan pairing each `stdout.write` with the `process.exit` on the next line, and
> a symbol-presence count. **`inScope` and `selfEcho` occur ZERO times in
> imago's and magpie's `cli.ts`.** Corrected: **2 guarded (bounty, astrolabe) ·
> 3 bare (glamour, imago, magpie).**
>
> **All five LINE NUMBERS were correct. Only the spelling column was wrong**, so
> no gate cell changes — the cells enumerate by site and the sites are right.
>
> **The rule the section argues for is UNHARMED — it is three times better
> supported than the sentence that argued for it.** A builder told glamour was
> the sole exception would reasonably search the guarded spelling for the other
> four and **silently find two**. **Search by SHAPE, and do not treat any guard
> spelling as the invariant.**

**⚠ glamour was `:481` in sprint 01's plan.** `62a5972` added 19 lines above it.
**Sprint 01's number is not corrected there** — a frozen record is not amended —
**so this table is the live one.** And the general rule that does not decay:
**search by SHAPE** — by `process.exit` on the line after a `stdout.write` —
**not by line number, and not by the guard.**

### Why these five and not the other 40

**Write the terminal event, then exit on the next line.** A `tail` is _always_
on a pipe. **The events a consumer loses are the ones saying the stream ended**
— and `tail` is the verb agents leave running for hours.

### ⛔ The obvious helper is a TRAP

**Measured, Bun 1.3.14, 300KB per write, real shell pipe:**

| #     | shape                                                      | bytes      | verdict                    |
| ----- | ---------------------------------------------------------- | ---------- | -------------------------- |
| A     | `write(big); process.exit(0)`                              | **65536**  | the defect                 |
| B     | `write(big, () => process.exit(0))` — cb on the SAME write | 300001     | ✅                         |
| C     | `await Bun.write(Bun.stdout, big); exit`                   | 300001     | ✅                         |
| D     | `write(big); process.exitCode = 0` (natural return)        | 300001     | ✅                         |
| **F** | **`write(big); write("", () => process.exit(0))`**         | **65536**  | ❌ **as broken as no fix** |
| **G** | **5× `write(big)`, then `write("", cb → exit)`**           | **327680** | ❌ **exactly 5 × 65536**   |
| I     | 5× `write(big, cb)`, await the LAST cb, exit               | 1500005    | ✅                         |

> **F is the helper anyone writes** when the write and the exit are separate
> statements — **which is the situation at all five of these sites. It is
> byte-for-byte the defect and it looks correct. G is why: a drain callback
> covers only its own write. It is not a barrier.**

_Stated as measured behaviour at 1.3.14, not as a claim about Bun's internals._

**⛔ And `D` (natural return) is NOT a drop-in — AT THESE FIVE SITES LEAST OF
ALL.** The table presents it as a one-liner, and at `bounty/join.ts` the
one-liner **hangs** because `process.exit` was doing double duty. **The same
thing happens here, for a different reason, and it is worse because it looks
safe.**

**At all five `tail` sites the exit is nested three deep:**

```
while (!stopped) {              <- bounty/scripts/cli.ts:527
  for await (chunk of reader) {
    for (line of lines) {
      write(payload); process.exit(0);   <- setting exitCode here RETURNS to the
    }                                       for-loop, which returns to the reader,
  }                                         which returns to `while (!stopped)`
}
```

**`process.exitCode = 0` does not return from a `tail`. It falls through and the
loop goes round again — the process never exits.** That is **exactly the G7
failure that already shipped once on this project** (`glamour open`, 23 minutes,
green suite). **Shape D is admissible at a site only if you have traced the
control flow out of every enclosing loop.** At these five, prefer **B or I** —
the callback-on-the-actual-write shapes, which exit from where they are.

**⚠ And G7's termination cell only catches this where a harness can drive the
CLI as a PROCESS** — **confirmed at bounty and astrolabe, absent at glamour, and
UNDETERMINED at magpie and imago** (see _"Pinnable vs driven is THREE verdicts"_
in the gate below). **At glamour, a hang introduced by shape D would be caught
by a human noticing, or not at all** — and at magpie and imago nobody yet knows.
_That is the same instrument gap that let the 23-minute hang ship._

> _"A per-site shape change with a per-site precondition cannot be verified by
> inspecting the shape."_ **Open all five files. Do not do this as one edit** —
> see the bulk-edit precondition in the gate law.

### Steps

1. **Per site, one at a time**, choose from the ✅ shapes against what that
   file's `tail` loop actually does. **Prefer B or I; treat D as presumptively
   WRONG here** — see the shape-D warning above, where setting `exitCode` inside
   three nested loops hangs instead of exiting. **Record the choice and the
   precondition you checked, per site.**
2. **Assert the process exits** at each site (G7). `tail` terminating on
   `closed` is the entire point of the exit; a fix that drains and never returns
   has traded one silent failure for a louder one.
3. **Do not touch the other in-function exits.** They are a later sprint.

### Gate — subject to G1–G8

1. **`RED PRE-FIX` — five cells, one per site, enumerated** (G4). No "for each
   spell."
2. **Driven through `sh -c "… | cat"`, never `Bun.spawn({stdout:"pipe"})`**
   (G6). A P0f gate written against `runCli` **cannot fail on this defect.**
3. **Over-buffer by construction** (G8) —
   `expect(bytes).toBeGreaterThan(65_536)` before asserting the parse — **and
   the fixture is specified, not left to the implementer:**

   > **⛔ ONE EVENT whose payload exceeds 64 KiB. NOT "many small events."**
   >
   > A fixture of many small events through `| cat` is **green pre-fix**: `cat`
   > drains as fast as the daemon emits, the total bytes received clear the
   > threshold, the parse succeeds, **and G8 is satisfied while completely
   > vacuous — because it counts bytes RECEIVED, not bytes AT RISK.** The defect
   > is **per-`write()` truncation**; a fixture whose largest single write is a
   > few hundred bytes cannot express it.
   >
   > **Build it as one `add --notes <70KB>`** — `validateTask` imposes no length
   > cap, so the field takes it — then `tail` that one event. **The gate's own
   > vacuity rule (G8) applied to G8's own threshold.**

   > ### ⛔⛔ THE ABOVE IS NECESSARY AND **NOT SUFFICIENT**. A cell built to it PASSES AGAINST THE BUG.
   >
   > **Measured by `daedalus` 2026-08-06, both directions, after his own
   > correctly-labelled `RED PRE-FIX` cell passed with the bug restored —
   > twice.**
   >
   > ```
   > bug restored, 10 x 1MB tasks, tail --since 0 | cat, close at 0.02s/0.05s/0.15s/0.3s/1.0s
   >    -> 10001074 bytes.  COMPLETE AT EVERY TIMING.
   > with the fix, identical construction
   >    -> 10001074 bytes.  BYTE-IDENTICAL.
   > ```
   >
   > **Five timings, fixed and buggy indistinguishable. The cell CANNOT fail.**
   >
   > **⚠ THE DISCRIMINATING VARIABLE IS THE CONSUMER'S DRAIN STATE, NOT THE
   > PAYLOAD SIZE.**
   >
   > ```
   > same board, 3 x 1MB, tail piped to a NON-draining consumer:  | ( sleep 2; cat )
   >    bug restored -> 65536 bytes       exactly the buffer
   >    with the fix -> 3000440 bytes     complete
   > ```
   >
   > **THAT is the cell. BOTH conditions, and the second one's TIMING is part of
   > it:**
   >
   > 1. the payload is **over-buffer**, and
   > 2. the consumer is **not draining AT THE INSTANT OF EXIT.**
   >
   > **⚠ "At the instant of exit" is load-bearing, not decoration.** A cell that
   > stalls the consumer at the wrong moment gets an indistinguishable pair
   > again and reads as a passing gate. _(Narrowing supplied by `thoth`, who
   > noted the phrase was in the prose and not in the rule line.)_
   >
   > **⛔ THAT PREDICTION CAME TRUE WITHIN THE HOUR, ON A DIFFERENT SEAT.**
   > `cassandra` ran the amended construction on bounty to confirm the law
   > independently, blocked her consumer **2s** and closed the board at **4s** —
   > so **the consumer had resumed draining before the exit fired:**
   >
   > ```
   > [PRE]  200285      [POST] 200286     <- no truncation in EITHER world
   > ```
   >
   > **On its face that reads as _"the amended fixture does not discriminate
   > either"_ — a finding AGAINST a rule landed twenty minutes earlier.** It was
   > her cell. Corrected to block **8s** and close at **1s**:
   >
   > ```
   > [PRE]  65536       [POST] 200286     <- exactly the buffer, then complete
   > ```
   >
   > > **"Non-draining at the instant of exit" is a property of the SCHEDULE,
   > > not of the consumer's SHAPE.** Her cell had the right shape and the wrong
   > > schedule.
   >
   > **The direction of the failure is what earns this the space: a fixture can
   > implement the LETTER of a spec and not its CONTENT, and it then presents as
   > _"the spec is wrong"_ rather than _"my cell is wrong"_ — pointing OUTWARD,
   > at a peer's ruling.** That is the most dangerous direction available.
   >
   > **What caught it: the result CONTRADICTED A MEASUREMENT ALREADY ON THE
   > RECORD** — the same tripwire that caught `daedalus`'s confident zero. **A
   > ratified fact auditing an instrument nobody aimed at it, third instance
   > this session.**
   >
   > **`expect(bytes) > 65_536` before the parse remains correct and remains
   > INSUFFICIENT.**
   >
   > **Why `| cat` cannot express it:** a continuously-draining consumer lets
   > each write complete before the next arrives, so **the write immediately
   > preceding the exit is the small `closed` frame**, which fits under the
   > buffer. **The big-payload-in-flight-at-exit condition does not occur when
   > someone is reading.**
   >
   > **It is realistic, not contrived:** any consumer momentarily not reading is
   > in that state — the field condition for a Monitor-wrapped `tail` whose
   > reader is busy.
   >
   > ### ⚠⚠ THIS DOES **NOT** INVALIDATE SPRINT 01's NINE ENTRY-POINT GATES. Read this before concluding it does.
   >
   > **The two verb classes differ in whether the consumer has TIME to drain,
   > and the fixture spec was correct for the class it was derived from:**
   >
   > | verb class                        | shape                                        | is a big write in flight at exit?              |
   > | --------------------------------- | -------------------------------------------- | ---------------------------------------------- |
   > | **one-shot** (`state`, `pull`, …) | one big `write()`, **then exit immediately** | **ALWAYS** — no time for any consumer to drain |
   > | **streaming** (`tail`)            | many writes over seconds, **consumer-paced** | **ONLY if the consumer is stalled**            |
   >
   > **Sprint 01 measured 65536-vs-114042 on a one-shot verb through a shell
   > pipe, and that discrimination was real.** The fixture spec was then
   > **carried to a different verb class without being re-derived** — and its
   > question changed on the way.
   >
   > **The generalisable form, and it is this session's most-repeated shape:** a
   > correct measurement, carried to a context where the thing it discriminates
   > on is no longer the thing that varies. **Re-derive a fixture when the verb
   > class changes, exactly as you would re-derive a line reference when the
   > tree moves.**
   >
   > **⚠ BINDS EVERY P0f CELL, INCLUDING ONES ALREADY DRAFTED. Like G6, a cell
   > written to the old spec needs REWRITING, not re-running** — it is green
   > against the bug, and **the label discipline cannot catch it**: daedalus's
   > cell was correctly labelled `RED PRE-FIX` and was still not red.

4. **`RED PRE-FIX` — assert BOTH directions in the SAME RUN: the piped form AND
   the file form.** One variable, two destinations:

   ```
   sh -c "bun run CLI tail … | cat"          -> bytes_piped
   sh -c "bun run CLI tail … > out.txt"      -> bytes_file
   assert bytes_file > 65_536
   assert bytes_piped == bytes_file
   ```

   **The file form is what makes the piped measurement discriminating.** Without
   it, a red cell **cannot distinguish "the exit truncated it" from "the fixture
   never produced the bytes"** — and those two are the same number on the same
   run. _Sprint 01's drain gate had this cell; this plan asserts "one variable,
   both directions" as law elsewhere and then dropped it from the only lane it
   applies to._

5. **`RED PRE-FIX` — three consecutive runs, all three asserted.** The original
   defect was **deterministic at exactly 65,536 bytes**, so a single run that
   comes out right is indistinguishable from a fixture that got lucky. **Three
   identical numbers are the evidence; one number is an anecdote.**
6. **`BLAST-RADIUS GUARD` — a termination cell per site** (G7): the process
   **returns**. Green today at every site, and the cell that catches shape D's
   hang. **This cell can only run where a harness drives the CLI as a process —
   see the three verdicts below, and read magpie's and imago's integration tests
   BEFORE you write it.**
7. **Mutation-verify each**: restore the `process.exit`, confirm the new test
   fails **alone**, restore the fix. **Same prerequisite as cell 6.**

### ⚠ Pinnable vs driven is THREE verdicts, not two — and the count is UNVERIFIED

**Step 7's mutation-verify and cell 6's termination check both require a test
that drives the CLI as a PROCESS.** Where that does not exist, the site can be
closed only by a recorded drive — **and a drive is a weaker guarantee than a
mutation-verified test: it proves the behaviour today and prevents nothing
tomorrow.** The two are different guarantees and **must never be folded into one
count.**

**The five sites do not fall into two populations. They fall into three:**

| site                         | verdict         | what is established                                                                                   |
| ---------------------------- | --------------- | ----------------------------------------------------------------------------------------------------- |
| **bounty**                   | **PINNABLE**    | harness confirmed, **and it already holds BOTH halves** — see below                                   |
| **astrolabe**                | **PINNABLE**    | **for cell 6 ONLY** — its harness is `Bun.spawn({stdout:"pipe"})`, which G6 says cannot fail on drain |
| **glamour · imago · magpie** | **DRIVEN ONLY** | **settled** — no CLI-process harness in any of the three. Write one, or close by drive.               |

> ### RESOLVED 2026-08-06 (sprint 02) by `cassandra` — the split is **`2 pinnable · 3 driven-only · 0 undetermined`**
>
> **The prerequisite read was done and the answer went the way the plan warned
> against assuming.** `magpie/tests/daemon.integration.test.ts` and
> `imago/tests/server.integration.test.ts` **spawn the DAEMON, never the CLI** —
> zero occurrences of `cli.ts`, zero of `tail`, and `stdout: "ignore"` in both.
> **They cannot drive `tail` through a pipe without new harness code**, so
> magpie and imago ARE glamour's population after all.
>
> **⚠ And this plan named the wrong magpie file.** `magpie/tests/cli.test.ts`
> exists and references `cli.ts` — but its own first line says _"Pure unit tests
> for cli.ts helpers that don't need a running daemon."_ **It imports; it does
> not spawn.** Anyone who grepped for a CLI-referencing test instead of opening
> it would have marked magpie **pinnable on a file that cannot drive a
> process.**
>
> **⚠ `PINNABLE` was itself flattening two capabilities that come apart at the
> site under test, and astrolabe is where they come apart.** Cell 6
> (termination) is satisfiable under `Bun.spawn` — awaiting an exit works fine.
> **Cells 1–5 (drain) are NOT**, per G6. So _"is there a process harness?"_ is
> the wrong question; **ask it once per capability.** astrolabe's
> `cli.test.ts:15` is a real harness and is **not reusable for the drain cells
> without rewriting to the `sh -c "… | cat"` form.**
>
> **Build bounty FIRST — its `server.test.ts` already contains both patterns**,
> so the bounty cell is a composition rather than new harness work: the
> G6-correct construction at **`:2824`**, a `tail` subprocess harness at
> **`:1741` · `:1780` · `:1840`**, and an existing termination test at
> **`:1733`**. **Lift bounty's shape to astrolabe**, then decide glamour, imago
> and magpie on cost.

**magpie and imago are NOT glamour's population.**
`magpie/tests/daemon.integration.test.ts` and
`imago/tests/server.integration.test.ts` each spawn a process. **That proves
they spawn something. It does not prove either harness can drive `tail` through
a pipe to completion**, which is what this gate needs — and nobody has opened
those two files to find out.

> **Reading those two files is a PREREQUISITE STEP of this lane**, not a
> release-note assumption. Do it before you write cell 6, because the answer
> decides whether you are extending a harness or writing one.

**⚠ Carry the split itself as UNVERIFIED until that read happens** — same rule
as the discovery-pointer figure. **Do not write `2 pinned + 3 driven` and do not
write `4 pinned + 1 driven`.** Write
**`2 pinnable · 1 driven-only · 2 undetermined`** until the files are read, then
replace it with what they say.

**The reason is not pedantry: pinned and driven are different guarantees.** A
split reported with false confidence **overstates what survives into next week**
— it claims regression protection that does not exist. _That is honesty rule #2
of the release note, applied to this document's own number, before it reaches
the release note._

**Say every verdict out loud** — `PINNED`, `VERIFIED BY DRIVE, NOT PINNED`,
`UNDETERMINED` — **never leave one as an absence.** _A silent 3-of-5 reads as
full coverage._

### ⚠ `bounty tail` replays its ENTIRE event history — expect it

**Candidate #8, restated here because this lane will run into it twice.** `tail`
has **no default anchor**: it replays every event on the board from the
beginning before it streams new ones.

- **It is how you BUILD the >64 KiB fixture** — you do not need a live
  high-volume board, just a board with one large event already on it.
- **It is a known pre-existing behaviour, not damage your change caused.** A
  builder who sees a `tail` dump the whole history after touching its exit path
  will reasonably suspect the edit. **It did that before you arrived.** Do not
  fix it here; it is not in this slice.

---

## Release

> ### ⚠ THE RELEASE NOTE IS WHERE THIS PROJECT'S OWN DEFECT CLASS WILL RECUR
>
> **Every honest sentence below was earned by a false one being caught first.**
> This project exists because tools reported plausible, well-formed, wrong
> results. **A release note that overstates does the same thing to a reader who
> cannot grep.**
>
> **0. LEAD WITH THE LOST TERMINAL FRAME, NOT WITH TRUNCATED PAYLOADS — for
> P0f.** **`cassandra` established, on all three spells by file and line, that
> `tail` streams SURFACE→AGENT events and every CLI verb is an AGENT action.**
> So a **>64 KiB payload through `tail` is NOT REACHABLE FROM THE CLI AT ALL** —
> it needs a browser sending a very large message, which bounds that half's
> real-world exposure far more tightly than this plan implied.
>
> **The harm that IS universal is the one the lane was named for: the terminal
> `closed` frame is lost regardless of payload size**, on the verb agents leave
> running for hours. **Say that. A release note leading with truncated payloads
> would be true and overstated, which costs the same trust as false.**
>
> **0b. A TEST DEPENDED ON THE DEFECT — say so, because it bounds what "the
> suite was green" ever meant.** `imago/tests/cli.test.ts` asserted the `=` form
> on **`--text`** — **a flag `imago` does not have.** Not in the artifact's 20,
> not in the source, never a flag: **an arbitrary stand-in name that worked only
> because the old parser accepted whatever it was handed.**
>
> **The test was passing BECAUSE of the permissiveness P0c removes.** It is not
> collateral damage from the fix — **it is a second instance of the same defect,
> sitting in the test suite, invisible until the registry named it.**
>
> **Generalises, and belongs in the note:** a permissive parser lets tests
> accumulate assertions about **flags that do not exist**, and **every one reads
> as coverage.** They cannot be found by inspection — **they look exactly like
> tests of real flags.** _The conversion is what enumerates them._
>
> **Rewritten against a real flag (`--options`, whose values genuinely carry
> `k=v`), property under test unchanged, plus a new cell asserting `--text` is
> now REFUSED BY NAME** — so the stand-in's absence is **pinned** rather than
> merely removed.
>
> **1. Say WHICH HALF, per lane.** For the drained exit across both sprints:
> _"the entry-point exits are fixed across eight files; the streaming verbs'
> `tail` exits are fixed in five spells; the remaining in-function exits are
> filed as P0f"_ — **not** _"the drained exit is fixed."_
>
> **2. Distinguish PINNED from VERIFIED.** A **test** prevents regression
> tomorrow; a **drive** proves it today. Sprint 01 delivered 5 pinned + 4 driven
> and _"9 of 9 gated"_ would assert the first while delivering the second.
>
> **3. Say CONVERTED vs ALREADY CONFORMANT.** For P0c: **6 converted · 10
> already conformant · 16 total.** _"Unknown-flag rejection now works across the
> house"_ implies we built something that mostly already existed and **will read
> as false to anyone who greps.**
>
> **4. Name what a fix does NOT reach.** `d650c97` closed the discovery
> pointer's **test-side** channel; **the shipped-source sites remain**, and
> seats run the **cached** plugin copy, so an in-repo fix does not change
> already-running daemons.
>
> **⚠ Do not put a NUMBER on those sites until it is re-measured.** Three counts
> are on record — **22, 19, 10** — none with a stated denominator. **A release
> note is the worst place to resolve that**, because the reader cannot grep and
> the number will be quoted back. **Either re-measure it and state the glob, or
> write "the shipped-source sites" and leave the count to the investigation.**
> _An unqualified count in a release note is this project's own defect class,
> committed in the paragraph warning against it._
>
> **A true claim that reads as an overclaim costs the same trust as a false
> one.**

### The closable set — mapped, and it is 6 of the 14

**Drafted by the lead ahead of the beats so the count is not improvised at
release time. UNVERIFIED until each is re-checked against what actually
shipped.**

| issue   | closed by                                        | status                    |
| ------- | ------------------------------------------------ | ------------------------- |
| **#77** | sprint 01 P0 (`ec33378`) + gate `59517c3`        | **closable**              |
| **#78** | sprint 01 P0 (`c29aa4e`) + gate                  | **closable**              |
| **#80** | **BOTH halves, across BOTH sprints** — see below | **closable**              |
| **#81** | P0c                                              | **not yet — P0c unbuilt** |
| **#83** | P0d (`14bec41`)                                  | **closable**              |
| **#84** | P0d (`14bec41`)                                  | **closable**              |

**⚠ #80 is the one to get right.** Its title carries **two** defects — _"a
skipped `--restore` **and** a pipe-truncated `state`"_. The truncation half was
fixed in **sprint 01**; the skipped-`--restore` half is **P0b, this sprint**.
**Closing it must cite both, or the comment claims one sprint did work the other
did.**

**⚠ And the release spans TWO sprints, which the note must say.** #77 and #78
were fixed in sprint 01 and **never closed** — its outcome's honest headline is
_"zero of the fourteen are closed."_ **So this release closes sprint 01's work
as well as sprint 02's**, and a note implying sprint 02 fixed them is false.

**The other eight are NOT closable and each has a reason** — not a backlog to
tidy later: **#64** genuinely unexplained, needs its own investigation · **#73 ·
#74 · #79** are P1, **unratified** · **#72 · #76** are P2/P3, unratified ·
**#82** on hold · **#85–#88** deliberately out of scope with the contract
investigation.

**⚠ P0f's tail slice closes NO issue.** It has no number — it was found by this
project, not reported. **Do not let a lane with real shipped code go unmentioned
because the release note is organised by issue.**

1. **Conventional commits throughout** (`fix(bounty)`, `fix(grapevine)`) —
   release-please owns versions, **no hand-edited version.**
2. **Re-read the `SKILL.md` of EVERY SPELL THIS SPRINT CHANGED — DERIVED, never
   a remembered list.**

   ```
   git diff --name-only <sprint-base>..HEAD -- plugins/spellbook/skills | cut -d/ -f4 | sort -u
   ```

   **⛔ NO TRAILING SLASH AND NO `*` — see the instrument warning below.** At
   `f77ae33..HEAD` this yields **FIVE**:
   `astrolabe · bounty · glamour · imago · magpie`. **grapevine returns a
   MEASURED ZERO.**

   > **⚠ The old wording said _"both `SKILL.md` files"_ — bounty and grapevine —
   > and it was wrong in BOTH directions.** `grapevine` changed **nothing** this
   > entire sprint, and **three spells P0d changed were outside its scope.**
   > Found by `thoth`, auditing the release section before the beat ran.
   >
   > **Where it came from is this session's most-repeated shape, for the fourth
   > time:** _"both files"_ was **correct for sprint 01**, whose scope was
   > bounty and grapevine. **It was carried into sprint 02's plan without being
   > re-derived**, and P0d reached four spells sprint 01 never touched.
   >
   > **`thoth`'s framing, which is the retro-worthy half: three of the four
   > instances today were carried across a boundary BY A DOCUMENT rather than by
   > a person.** _Prose carries a denominator forward silently, and **nothing in
   > a doc goes red when its scope changes underneath it.**_
   >
   > **A derived set cannot go stale between sprints. A named one already did.**

   > **⛔⛔ AND THE CORRECTION'S OWN DENOMINATOR WAS SHORT — the set is FIVE,
   > not four.** `thoth` named bounty · glamour · imago · magpie (P0d's
   > `server.ts`) and **missed `astrolabe`**, changed by **P0f** (`cli.ts:222` +
   > its cell at `5dc8377`). **A correction derived from ONE LANE inherits that
   > lane's scope.**
   >
   > **⛔ AND THE LEAD'S CONFIRMING INSTRUMENT WAS BROKEN.** I verified with
   > `-- 'plugins/spellbook/skills/*/'`, which returns **ZERO for every spell**,
   > including ones I knew had changed. It would have "confirmed"
   > grapevine-unchanged **by returning the same empty it returns for
   > everything.**
   >
   > **What caught it: the SECOND glob also came back empty when it could not
   > possibly be.** The zero-guard — _a zero anywhere is the instrument until
   > proven otherwise_ — applied to my own check, one message after I praised
   > two seats for applying it to theirs.
   >
   > **⚠⚠ THE FIRST VERSION OF THIS WARNING BLAMED THE TRAILING SLASH. THAT WAS
   > WRONG AND IT CONDEMNED A WORKING INSTRUMENT.** Corrected by `thoth`, four
   > arms, measured at `82adf9a` and reproduced by the lead:
   >
   > ```
   > 'plugins/spellbook/skills/*/'         ->   0    <- wildcard + trailing slash.  BROKEN
   > 'plugins/spellbook/skills/*'          ->  16    wildcard, no slash            WORKS
   > 'plugins/spellbook/skills/bounty/'    ->   4    literal + trailing slash      WORKS
   > plugins/spellbook/skills              ->  16    bare prefix                   WORKS
   > ```
   >
   > > **A pathspec combining a `*` WILDCARD with a TRAILING `/` silently
   > > matches nothing.** Drop the trailing slash **whenever the pathspec
   > > contains a wildcard**. **A literal path with a trailing slash is
   > > unaffected.**
   >
   > **Why the correction matters more than the original warning:** `thoth`'s
   > own grapevine check used `'…/skills/grapevine/'` — literal plus trailing
   > slash — **which returns a REAL zero and was sound.** The broad wording
   > would have forced him to disown a valid measurement. **A warning that
   > condemns a working instrument costs you the instrument**, and _a wrong
   > warning is worse than a wrong fact: a wrong fact is corrected by the next
   > person who looks; a wrong warning stops them looking._ **This repo's SOP
   > carries the same scar about `anthill status`.**
   >
   > **The durable remedy is unchanged and survives whichever clause is guilty:
   > verify against a CONTROL THAT SHARES NO PATTERN.** Here, the bare prefix.

   **What the three actually need is a SCOPE CALL, not a re-read.** `applied`
   appears **10×** in bounty's `SKILL.md` and **0×** in glamour / imago / magpie
   — **but those three document no `/cmd` response envelope AT ALL.** So it is
   an **ABSENT** doc surface, not a **STALE** one, and the two need opposite
   fixes: stale → correct the sentence; **absent → decide whether they should
   document an envelope at all.** _`thoth` explicitly does not propose that they
   should; their agent surface may simply be smaller. The point is that the old
   beat would never have surfaced the question, because it never opened those
   files._

3. **Cold-gate the assembled release**, not just the lanes.
4. **Move every closed backlog item to `docs/backlog/_archive/`.**
5. **Comment the GitHub issues as they close.** **Zero of the fourteen were
   closed in sprint 01** — this is where that changes, and the count belongs in
   the outcome.
6. **Cole cuts the release and pushes — the agent does not push or release.**

## Open questions

- **Does any fixture's daemon outlive its test?** `mkdtempSync` at
  `bounty/server.test.ts:803` runs once at **module** scope, so `TEST_TMPDIR` is
  per-**file**, not per-**fixture**. **Per-run isolation is not per-fixture
  isolation.** If every daemon dies with its test there is no intra-file
  concurrency and the question closes. **Measure before building for it.**
- **May a user-facing refusal name a `kill -9`?** Cole's call. It is currently
  the only measured sequence that preserves the snapshot, and P0b's refusal
  names no corrective verb until it is answered.
- **Does an envelope field belong on other destructive verbs too?** Note what
  you find; **do not expand scope for it here.**
- **`bounty message` leaves no durable trace** (`bounty/server.ts:950`
  broadcasts with no `events.push`) — same family as #83/#84. **Candidate issue,
  filing is Cole's.** Do not let this lane widen to catch it.
