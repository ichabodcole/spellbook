# Spell Hardening — Implementation Plan

**Created:** 2026-08-05 **Related Proposal:** [proposal.md](./proposal.md)
**Status:** **P0 family RATIFIED 2026-08-06** by the anthill team (`daedalus`
engine, `cassandra` verify, `thoth` grimoire; `prospero` leading). P1–P3 are
**still unratified** and keep the caveat below.

[HANDOFF.md](./HANDOFF.md) is **historical** — it called for the ratify round
that has since happened. Read it for the reasoning behind D1–D4, not for what to
do next.

---

## ▶ START HERE — the next session

**You are picking up a project whose P0 family is RATIFIED and UNBUILT.** As of
2026-08-06, **zero of the fourteen issues are fixed.** Measured, not recalled:

```
process.exit(code)   still at bounty/cli.ts:943, grapevine/cli.ts:262 and :1807   <- P0 live
parseArgs()          still whitespace-only, no `=`, no unknown-flag rejection     <- P0c live
bounty add           still `await postCmd(...)` with no `const res =`             <- P0d live (#83)
```

**~~The one thing that HAS shipped is `Phase 0e`~~ — CORRECTED 2026-08-06:
`Phase 0e` is HALF shipped and was REOPENED.** It is a test-hermeticity fix,
admitted as a prerequisite because the project's own gate was destroying the
team board. It is test-only and changes nothing a user sees — **but it had two
halves and only one landed, and its gate could not see the difference.** See
Phase 0e.

> **⚠ BEFORE YOU MEASURE ANYTHING, read G5 — it is ACTIVE, and `d650c97` did NOT
> repeal it** (it fixed **bounty's** suite; glamour still writes the global
> pointer in-process, imago and magpie are unverified). Every gate must be run
> with `TMPDIR=$(mktemp -d)`. **A green from a shared-pointer run is not weak
> evidence — it is no evidence**, and that voids every baseline in this repo
> recorded before 2026-08-06, including two independently-agreeing 1291/0 runs
> that were read as corroborating each other.

### Build order, and why it is not negotiable

1. **P0** (drained exit) — highest harm, and **blocks P2**.
2. **P0b · P0c · P0d** — independent of each other; any order.
3. **P1 → P2 → P3** — **NOT YET RATIFIED.** Run a ratify round on each before
   building it. **P0's round falsified six things; assume these will too.**

### What is already true and does NOT need re-deriving

Every gate below is rewritten and audited; **G1–G4 bind all of them.** The entry
point sets, the site audits and the mechanism claims were measured on 2026-08-06
and carry their evidence inline. **Falsify them if you can — but do not
re-derive them from scratch as if they were unexamined.**

### What to distrust, stated by the people who wrote it

- **The `~14 return sites` figure for `ApplyResult`** is advisory (actually 16).
- **`proposal.md` was NOT audited** in the review — a stated gap, not a clean
  bill.
- **P1's `#64` root cause is unresolved** and may need its own investigation.

### Read these before you start

[`.anthill/retro.md`](../../../.anthill/retro.md) — **nine hypotheses this round
left for you to test**, each with its falsifier named.
[`.anthill/principles.md`](../../../.anthill/principles.md) — the one principle
the round earned.

**And the standing instruction that produced this plan's corrections, which the
author of this line is now subject to:** the person who wrote a claim is the
worst-placed reader of it. **This plan now has a new author. Treat it
accordingly.**

---

> ### What the ratify round changed — read this before trusting a remembered version
>
> The round did **not** rubber-stamp the plan. It changed content, one gate's
> validity, and one lane's justification:
>
> | change                                                                                          | who found it |
> | ----------------------------------------------------------------------------------------------- | ------------ |
> | **P0d's gate was DEFECTIVE — an inverted control that fails a _correct_ fix.** Rewritten below. | cassandra    |
> | **P0c step 5 swept an EMPTY set**, and in the wrong direction. Re-worded as an invariant.       | thoth        |
> | **P0c's positional corruption is LIVE today, not a future consequence of step 2.**              | thoth        |
> | **The gates were never valid from a seat shell** — they inherit `BOUNTY_SESSION_KEY`.           | cassandra    |
> | **Phase 0e added** — the project's own gate destroyed the team board twice.                     | daedalus     |
> | **"Assert which session answered" is unsatisfiable from the read envelope.**                    | cassandra    |
>
> Three seats produced falsifications the lead did not anticipate, and two
> falsified rulings the lead had already made. **A ratify round that produced
> only agreement would have been the failure mode.**

---

## Overview

Four phases against the shipped spells, ordered by harm and by one hard
dependency (P0 → P2). This plan is a **skeleton with claims**, not blanks to
fill: the file references below were verified during triage, but per the R12/R13
lesson, **a claim in a skeleton is a hypothesis until the owning seat confirms
it.** Falsify anything here that turns out wrong and say so.

**Execution:** the anthill team. `daedalus` owns the CLI/daemon work, `circe`
the board surface, `cassandra` cold-gates each phase, `prospero` leads and
lands. Run `anthill:plan` first so the owning seats ratify the seams they touch.

## Outcome & Success Criteria

Inherited from the proposal. **Definition of done for the project:** all
fourteen issues resolved-or-deferred-with-reason, gate green, cold-gate passed,
release cut, `SKILL.md` true.

**Non-goals:** feature work of any kind; mind-mapper; the primitive
investigations; a shared CLI library (P0 fixes a shape, it does not factor one).

## Approach Summary

**Harm-ordered, with one forced dependency.** P0 before P2 is not a preference —
a bounded dump that exits is the exact shape that loses its tail to the P0 bug,
so P2 before P0 would ship a new way to lose history.

Each phase ends at a **cold gate** (cassandra) before the next begins, because
three of these bugs are invisible to the person best positioned to notice them.

---

## Cross-cutting gate requirements (ratified 2026-08-06 — apply to EVERY gate here)

**These bind all four P0 gates and every gate added later. A gate that omits
them is not merely risky; it is invalid.**

### G1 — Every gate must scrub the ambient session key

Every gate in this project drives real CLI verbs, so every gate inherits
`BOUNTY_SESSION_KEY` from the shell it runs in. **A gate that attaches to a
stranger board measures the stranger, silently, exit 0** — so P0c's and P0d's
assertions would be evaluated against the wrong state and still pass.

Every gate runs with **`env -u BOUNTY_SESSION_KEY -u BOUNTY_SESSION`**, a
**unique `BOUNTY_HOME`**, and an **explicit throwaway `--session-key`**.

**This is not a precaution. It is proven:** the project's own test suite
attached to the live team board and called `close` on it, twice, on 2026-08-06
(see Phase 0e).

### G2 — A gate must be FALSE pre-fix **and TRUE post-fix**

The question _"what result would have failed this gate?"_ finds **decoration** —
a gate no result can fail. It does **not** find the worse failure, and P0d was
the worse failure:

| failure mode                                            | behaviour                              | why it is bad                                    |
| ------------------------------------------------------- | -------------------------------------- | ------------------------------------------------ |
| **Decoration** — no failing result exists               | passes silently forever                | tells you nothing                                |
| **Inverted control** — fails the CORRECT implementation | **red gate that looks like diligence** | **dispatches the builder to break working code** |

An inverted control cannot be caught by asking _"could this fail?"_, because it
can — that is precisely the problem. **So evaluate every gate's assertion twice:
once against the buggy world, once against the world after the intended fix.**
The second check is the one nobody runs, and it found the only defective gate of
the four.

### G3 — Gates pin board identity OUT-OF-BAND, because the envelope cannot

**Measured 2026-08-06: there is no session id, key, port or board identity
anywhere in a `bounty state` response.** So "assert which session answered"
cannot be satisfied from the payload — a gate must capture `session_id` from
`open`'s stdout and bind every subsequent call to an explicit `--session-key`
under a unique `BOUNTY_HOME`.

_(The underlying gap — **a bounty read cannot tell you which board answered it**
— is a candidate issue, not this project's to fix. It is the exact defect that
let a seat's write land on a stranger board during this session.)_

### G4 — Enumerate; never write "for each spell" or "an over-buffer payload"

An unenumerated target set lets the implementer pick the fixture, and **a
fixture the code already satisfies makes the gate pass trivially.** Every gate
below names its sites, its literal invocations, and its byte thresholds.

### G5 — Every gate POSITIVELY ASSIGNS a private `TMPDIR` (added 2026-08-06)

**`TMPDIR=$(mktemp -d)`, not `env -u TMPDIR`.** A scrub is insufficient: an
unset `TMPDIR` still resolves to the shared machine default.

**Why, established causally 2026-08-06 and not by correlation.** Session
discovery does **not** go through `BOUNTY_HOME` — it goes to a machine-global
singleton at a fixed path (`cli.ts:85-86`, `join.ts:84-85`,
`server.ts:1186-1187`, all `join(tmpdir(), "bounty-latest.json")`). If a second
bounty daemon boots inside the test's ~200ms write→read window, the joiner
resolves **someone else's board**. The verify seat proved it with a labelled
tracer: injecting daemons named `inj-<pid>-<run>-<iter>` produced a suite
failure whose **own expectation contained the injected id**.

**The second daemon is us.** 410 of 412 recent pointer writes were `e2e-*` test
fixtures — roughly 40 daemon boots per minute while a gate runs. Cleanup exists
but is **graceful-exit-only**, and test daemons die by kill, so nothing has ever
swept: 2206 stale pointer files, oldest 11 days.

**The magnitude, which a coin-flip race cannot produce:** the same 1291-test
suite ran **1125s shared** and **107s private** — and the shared run's slowest
test consumed 1,020s before timing out and dying on `ConnectionRefused` to its
own `/state`.

> **⚠ A green from a shared-pointer run is not weak evidence. It is NO
> evidence.** The race fires roughly once per run and a saturating injector
> reproduced it only 2 times in 3. **Every green measured under a shared pointer
> before 2026-08-06 is void**, including two independently-agreeing 1291/0
> baselines that were read as corroboration and were two draws from one
> distribution.

**⚠ G5 does NOT belong in `.anthill/config.json`'s gate.** That is the shape
Phase 0e step 2 already deleted — _a workaround left in place after its fix
lands is a second, quieter source of truth._ **The tmpdir belongs in the
harness** (Phase 0e half 2).

> ### ⛔ THE REPEAL CRITERION WAS WRONG AND WOULD HAVE SELF-FIRED. Rewritten 2026-08-06.
>
> **It read: _"repealed the moment the harness does it for you."_ `d650c97` made
> that true — for BOUNTY's harness — so by its own words G5 self-repealed on
> landing, while three other suites still write the machine-global pointer.**
>
> **"The harness" is singular in the sentence and plural in the world.** Same
> unit-of-analysis error as P0's file-vs-site — **placed in a repeal criterion,
> which is the worst possible home for it, because a repeal fires silently and
> removes a protection nobody re-checks.**
>
> **Rewritten, per-spell and measurable:**
>
> **G5 is repealed FOR A GIVEN SPELL when that spell's own suite is proven not
> to write `<spell>-latest.json` to the ambient `TMPDIR`** — proven by the
> structural gate (no pointer at top level **and** the pointer present in the
> per-suite dir), **never by a sibling spell's fix landing.**
>
> | spell          | status                                                                                                                |
> | -------------- | --------------------------------------------------------------------------------------------------------------------- |
> | bounty         | ✅ `d650c97`                                                                                                          |
> | glamour        | ❌ `tests/daemon.integration.test.ts` imports `startDaemon` and `server.ts:405-415` writes the pointer **in-process** |
> | imago · magpie | ❓ **UNVERIFIED** — both have a TMPDIR-handling test file, which is not proof                                         |
>
> **One of four. G5 stays for everyone until all four are green.**
>
> _The glamour case is worth keeping: it writes the pointer **in-process**, so a
> `Bun.spawn` grep sees nothing. **"Does this suite spawn?" is not the question.
> "Does this suite reach the code that writes the pointer?" is.**_

### G1 — amended 2026-08-06: the explicit `--session-key` IS the isolation

`resolveSession` (`cli.ts`) has **six** precedence levels, and only the top four
are environment:

```
1. --session-key   2. --session   3. $BOUNTY_SESSION_KEY
4. $BOUNTY_SESSION 5. .bounty-session (walking UP from cwd)   6. the latest pointer
```

**Level 5 is a tracked file in this repo** containing the team board's id —
**byte-identical to what level 3 derives.** So `env -u BOUNTY_SESSION_KEY` does
not isolate a process whose cwd is under this repo; **it demotes one route to
another route with the same destination.**

**G1 already required an explicit throwaway `--session-key`, and that clause is
what actually protects you.** What was wrong was the rationale: the scrub reads
as the isolation and the explicit key as belt-and-braces. **It is the reverse. A
gate that scrubs and omits the explicit key is not partially isolated — it is
not isolated at all, and it looks more careful than one that does neither.**

_Three people mis-ran this in the same direction on 2026-08-06. That is not
three mistakes; it is one rule whose stated reason was wrong._

---

## Phase 0 — The drained exit (#77, #78, #80.2)

**Owner:** daedalus · **Verify:** cassandra · **Blocks:** P2

The single highest-harm item. Payloads are complete; only the write is lost.

**The mechanism, already diagnosed — do not re-derive it.** Bun's stdout is
asynchronous on a pipe and synchronous on a TTY or file, so `process.exit`
discards whatever has not drained.

**Sites — verified 2026-08-05 (these three are facts, not claims):**

- `plugins/spellbook/skills/grapevine/scripts/cli.ts:351-353` — `printJson`
- `plugins/spellbook/skills/grapevine/scripts/cli.ts:1805-1807` — `main` →
  `process.exit(code)`
- `plugins/spellbook/skills/bounty/scripts/cli.ts:941-943` — identical shape

**⚠ The audit is wider than the two reported spells.** A first-pass
`grep -rln "process.exit(code)"` over `plugins/spellbook/skills/*/scripts/*.ts`
returns **seven files**:

> ### ⚠ EVERY LINE NUMBER IN THIS TABLE IS **AT `5dfbb0d`** (pre-fix). They are STALE against HEAD BY CONSTRUCTION.
>
> **Measured at finalize: 6 of 9 now land on unrelated code.**
> `glamour/cli.ts:628` was `process.exit(code)` when the audit was written; it
> is now `await postCmd(session, {type:"close"})` and the exit moved to `:653`.
> **The fixes this table commissioned are what moved them.**
>
> **A `file:line` reference is a claim about a TREE, and it decays the moment
> anyone acts on it** — which for an audit table is immediately, because its
> whole purpose is to be acted on. **Same rule this session derived for claims
> on the wire: name the layer.** Here the layer is `5dfbb0d`, stated once,
> above.
>
> **Do not renumber these.** They are correct as a record of the pre-fix world
> and that is what the table is for. **To find a site today, search by SHAPE** —
> `process.exit(code)`, `main().then(code => …)`, `process.exit(await main(…))`
> — which is what the audit itself concluded and what does not decay.
>
> _Found by the lead running step 2.5 against a doc he had landed hours earlier.
> It failed no gate, and the table reads exactly as authoritative as it did
> before._

**AUDIT COMPLETED 2026-08-06 (daedalus) — it is 10 sites, not 7, and every CLI
shares the identical shape.** The differentiator is never the shape; it is
**whether a verb can emit >64KiB.** Verdicts, with rule-outs recorded because a
silent skip is indistinguishable from a miss:

| site                              | >64KiB capable?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | verdict       |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `grapevine/cli.ts:1805`           | YES — `pull`/`read`/`grep`/`list` over an unbounded message log                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | **FIX** (#77) |
| `bounty/cli.ts:941`               | YES — `state`/`list` over an unbounded board (the 102-card board is live proof)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | **FIX** (#78) |
| **`mind-mapper/cli.ts:1568`**     | **YES, and the worst of them** — `state` returns the FULL graph (nodes+edges+proposals+conversation+jobs+docs)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | **FIX**       |
| `magpie/cli.ts:886`               | YES — `export`/`extract`/`discover` emit element/bbox sets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | **FIX**       |
| `astrolabe/cli.ts:467`            | YES — a CROSS-PROJECT observatory; it aggregates every project's board                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | **FIX**       |
| `imago/cli.ts:538`                | YES — `state`/`context`/`batch` carry accumulated conversation + proposals                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | **FIX**       |
| `glamour/cli.ts:628`              | YES — `state`/`tray`/`gen-meta` carry generation metadata + tray contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | **FIX**       |
| **`magpie/discover.ts:314`**      | ~~**a 10th site nobody had listed** — third spelling~~ **⛔ RULED OUT 2026-08-06 by its own finder, verified independently.** The original ruling said _"emits element/bbox sets"_ — **true, and they go to `Bun.write(out, …)`, a FILE** (`:288`). Stdout gets a human summary (`:294`, `:296`). **Nothing spawns it**: the only reference outside the file is `tests/discover.test.ts`, a unit **import**. _The audit asked "can this emit a large payload?" The question is "can it emit a large payload THROUGH THE PIPE?" — **the payload and the channel were treated as one thing.** First instance where the error made the set too BIG rather than too small, which is why it survived: an over-inclusive audit looks like diligence and costs only effort._ | **NO FIX**    |
| `digestify/review.ts:430`         | **CANNOT RULE OUT** — emits the human's submitted answers. Rarely 64KiB, but it is a **one-shot** tool: truncation eats the user's only submission with no retry. **The asymmetry of harm decides it.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | **FIX**       |
| `grapevine/daemon.ts:962/965`     | **RULED OUT** — shutdown handler; the daemon's only stdout write is a small boot JSON at `ready`, long before any exit path. Nothing is queued at exit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | **NO FIX**    |
| the 5 `server.ts` exits           | **RULED OUT** — same reasoning: daemons emit a small ready-JSON at boot; their exit paths carry no payload.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | **NO FIX**    |
| **`src/mind-mapper/build.ts:92`** | **RULED OUT 2026-08-06** — an 11th site, carrying the third spelling (`process.exit(await main())`), and it was in **neither** the ruled-in nor the ruled-out list. It is a **build tool**: stdout is human progress text, nothing downstream `JSON.parse`s it. **A truncated build log is visible; a truncated `state` envelope is not** — that asymmetry is what the whole audit turns on. _Recorded rather than skipped, because this is precisely the site a silent skip would have swallowed._                                                                                                                                                                                                                                                                   | **NO FIX**    |

**⚠ The literal grep missed sites because the defect has THREE SPELLINGS:**
`main().then(code => process.exit(code))`, `process.exit(code)`, and
**`process.exit(await main(...))`** — the third is why `mind-mapper/cli.ts` and
`magpie/discover.ts` never matched. **Search by shape, not by string.**

_Superseded first-pass table (`grep -rln "process.exit(code)"`, seven files):_

| File                          | Status                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `grapevine/scripts/cli.ts`    | reported (#77)                                                                 |
| `bounty/scripts/cli.ts`       | reported (#78)                                                                 |
| `astrolabe/scripts/cli.ts`    | **unreported — same shape**                                                    |
| `glamour/scripts/cli.ts`      | **unreported — same shape**                                                    |
| `imago/scripts/cli.ts`        | **unreported — same shape**                                                    |
| `magpie/scripts/cli.ts`       | **unreported — same shape**                                                    |
| `grapevine/scripts/daemon.ts` | **unreported** — check whether a daemon's exit path can carry a payload at all |

**This grep is a starting point, not the audit.** It matches one literal
spelling, so it can miss variants (`process.exit(0)`, an exit inside a handler)
and it over-matches — a site only _bites_ if it can emit a >64KiB payload, which
a daemon or a short help path may never do. Confirm per site rather than
patching all seven blind. mind-mapper did not match this spelling and should be
checked separately (its CLI lives under `plugins/spellbook/skills/mind-mapper/`
with sources in `src/mind-mapper/`).

**Steps**

1. Fix the shape: await the drain, or drop the explicit `exit` and let the
   process end naturally. **Not pagination, not a `--complete` flag.**
2. **Audit the five unreported sites above** (plus mind-mapper and digestify,
   which the grep did not reach). For each, decide whether it can emit an
   over-buffer payload; fix the shape where it can, and record the ones you rule
   out and why — a silent skip is indistinguishable from a miss.
3. Regression test per spell: generate a >64KiB payload, read it **through a
   pipe**, parse it. A test that doesn't pipe cannot catch this bug.

   > ### ⛔ AMENDED 2026-08-06 — "through a pipe" NAMES TWO DIFFERENT THINGS AND ONLY ONE REPRODUCES THE BUG.
   >
   > **The sentence above is true, insufficient, and reads as complete. Measured
   > on one board with the defect present, three readers:**
   >
   > ```
   > shell pipe   cli state | wc -c                ->   65536   TRUNCATED
   > Bun.spawn    stdout:"pipe" + Response.text()  ->  114042   COMPLETE
   > sh -c        cli state | cat                  ->   65536   TRUNCATED
   > ```
   >
   > **`Bun.spawn({stdout:"pipe"})` is how `runCli` and every harness in this
   > repo drives a CLI — so a gate written that way CANNOT FAIL ON THIS
   > DEFECT.** The engine seat wrote exactly that gate, it passed, he restored
   > the bug, and **it passed again.**
   >
   > **Nine ruled-in sites × a gate that cannot fail = nine decoration gates,
   > every one written by someone following this plan correctly.**
   >
   > **Use this construction verbatim — verified in both directions (green with
   > the fix, RED under the mutation):**
   >
   > ```
   > Bun.spawn({ cmd: ["sh", "-c", `bun run ${CLI} <verb> | cat`], stdout: "pipe" })
   > ```
   >
   > **⚠ Any P0 gate drafted against `runCli` needs REWRITING, not re-running.**

   > ### ⛔ AND EVERY P0/P0f GATE NEEDS A CELL ASSERTING THE PROCESS **EXITS**.
   >
   > **A drained-exit fix trades a truncation for a HANG wherever `process.exit`
   > was load-bearing.** `ec33378` did exactly that at one site and it shipped.
   >
   > **`glamour open` post-fix ran for 23 MINUTES and never returned.** Pre-fix
   > returned normally. **Mechanism measured in isolation, both directions:**
   >
   > ```
   > spawn(detached, stdio ["ignore","pipe","inherit"]); child.unref(); natural return
   >    -> STILL RUNNING after 6s        HANGS
   > same + child.stdout.destroy() before returning
   >    -> exited                        CLEAN
   > ```
   >
   > **`unref()` releases the CHILD HANDLE. The piped stdout is a separate
   > reffed stream and a daemon never closes it.** Under `process.exit(code)`
   > the parent force-exited and the held handle was invisible.
   >
   > **Blast radius: `glamour` ONLY** — it is the one spell that pipes a
   > **long-lived detached daemon's** stdout. grapevine's two piped spawns are
   > `ps` and `lsof`, **awaited to exit**, and its daemon spawn is
   > `["ignore","ignore","ignore"]`. _A `grep` for `stdio: ["ignore","pipe"`
   > counts all three and cannot tell them apart; **enumerate by what the spawn
   > IS, not by what it looks like.**_
   >
   > **Fix: read the boot JSON off the pipe, THEN `child.stdout.destroy()`, then
   > return.** Destroying early breaks `open` loudly.
   >
   > **THE GATE LESSON, which outlives this instance:** the suite was green,
   > both P0 gates were green, and **a 23-minute hang in a shipped spell's entry
   > verb was invisible to every one of them, because nothing asserts that a CLI
   > RETURNS.** **Assert the process ended — not only that its payload
   > survived.**
   >
   > _Second per-site precondition invisible to shape inspection; `join.ts` was
   > the first, and the engine seat generalised it correctly at the time._
   >
   > _Why Bun's pipe survives is **UNVERIFIED** — plausibly the parent drains
   > from the first byte so the writer never blocks. **The gate deliberately
   > does not depend on that explanation**, and it was left unpublished rather
   > than asserted: "real symptom, inferred mechanism" is this project's
   > recurring trap._

   **⚠ The vacuity trap — the regression cell must be over 65,536 _by
   construction_.** A test that pipes a small payload and asserts completeness
   **passes in both worlds**, goes green for years, and is still green on the
   day it breaks: a 64KiB truncation of a sub-64KiB payload is indistinguishable
   from success. Put a positive control _inside_ the assertion —
   `expect(bytes).toBeGreaterThan(65_536)` before asserting the parse — so a
   fixture that silently shrinks fails loudly instead of passing vacuously.
   **Mutation-verify it**: restore the `process.exit`, confirm the new test
   fails **alone**, restore the fix.

**Reference control:** `anthill comms read` moves **2.78MB** through a pipe
intact — measured on the same machine, same Bun, in the same session where
`bounty state` truncated at 65,536 (reported 2026-08-06; supersedes the ~983KB
figure from #77). Its success path **returns naturally instead of calling
`process.exit`**. That is the target behaviour, and the reporter notes it is
accidental rather than designed on their side — worth saying out loud in both
repos so nobody later "tidies" a natural return into an explicit exit.

**The mechanism, isolated in a second runtime (reporter, 2026-08-06):**

```
write 300_000 bytes then process.exit(0)   →  pipe 65536    file 300000
write 300_000 bytes, natural return        →  pipe 300000   file 300000
```

One variable, both directions. This is the control the fix should reproduce.

**REPRODUCED IN THIS REPO 2026-08-06 (daedalus, Bun 1.3.14) — no longer an
inherited claim:**

```
write 300_000 bytes then process.exit(0)   ->  pipe  65536   file 300001
write 300_000 bytes, natural return        ->  pipe 300001   file 300001
```

**65,536 on the nose.** Nothing about this is machine- or runtime-specific.

**Still `UNVERIFIED`:** that any specific spell's `state` crosses 64KiB _in
practice_. The per-site verdicts below are from reading each verb's payload
source, not from driving a >64KiB fixture through a real daemon. **That
measurement IS the P0 regression test** (with the vacuity guard, mutation-
verified by restoring the `process.exit`).

**⚠ Do NOT fold the structured failure envelope into this phase — reversed
2026-08-06.** It was briefly recommended here on the grounds that it lands in
the same function P0 rewrites, so touching those lines twice is waste. **That
was right about the cost and wrong about the risk:**
[the contract investigation](../../investigations/2026-08-06-spell-cli-contract-investigation.md)
found the envelope's shape is known-incomplete (nine omitted members), so
folding it in blocks a data-corruption fix on an open investigation. **Fix the
drain only. Accept touching the exit path twice.**

**Gate — REWRITTEN 2026-08-06 (cassandra's audit; two holes closed).** Subject
to **G1–G4** above.

The mechanism is no longer an inherited claim — **it reproduces in this repo**,
one variable, both directions, on a 42-card board:

```
bounty state | wc -c   ->  65536      JSON.parse -> FAILED "Unterminated string"
bounty state > file    -> 127948      JSON.parse -> OK
```

1. **The over-buffer precondition is its own cell, not prose.** Assert
   `bytes > 65_536` **before** asserting the parse. The plan states this vacuity
   trap for step 3's regression test and the old Gate line did not carry it — so
   a fixture drifting under 64KiB would have passed in both worlds, forever.
2. **Assert the piped form AND the file form in the same run** — one variable,
   both directions, as above.
3. **Enumerate every site step 2 rules IN** (G4). The old gate exercised only
   `grapevine pull` and `bounty state --full`, so **a fix that patched the two
   reported spells and skipped all five unreported ones passed cleanly** — the
   phase's widest half was ungated. Either the gate names every site ruled in,
   or **step 2's ruling-out record itself becomes the artifact under audit.**
4. Three consecutive runs (the original bug was deterministic at exactly 65,536
   bytes).

_Note: "`cursor` present" adds almost nothing — a truncated payload fails
`JSON.parse` first. Keep it, but it is not the discriminator it reads as._

**#80 corroborates #78 from a second team** and sharpens the cost: the
truncation did not merely produce bad data, it produced a **false rule** — "our
board is too big to read" — which the reporter published and three agents then
worked under for six messages. Nothing to fix beyond #78; recorded because the
harm statement is better evidence than the original.

---

## Phase 0f — The in-function exits (NEW, 2026-08-06, UNBUILT)

**Owner:** daedalus · **Verify:** cassandra · **Split out of P0 deliberately —
see below. Do NOT fold this back in.**

**P0's audit enumerated ONE exit per FILE — the `main()` wrapper. The defect's
unit is the SITE.** The three-spellings insight was about _how `main()` exits_;
it never asked whether a file has other exits. **It does.**

**Denominator, measured 2026-08-06 by a source-scanning guard over
`plugins/spellbook/skills/**/scripts/\*.ts`: 44 remaining `process.exit(`sites** after`c29aa4e`+`ec33378`
fixed the eight ruled-in entry points (magpie/discover.ts was ruled OUT
2026-08-06). **The guard reaches 35 that a mutation test structurally cannot** —
H5's prediction, confirmed with a number.

**The highest-harm shape, in five spells, on consecutive lines** — `bounty:595`,
`magpie:280`, `astrolabe:222`, `imago:281`, `glamour:481`:

```ts
if (inScope(ev) && !selfEcho) process.stdout.write(`${payload}\n`);
if (ev.type === "closed") process.exit(0);
```

**Write the terminal event, then exit on the next line.** A `tail` is _always_
on a pipe. **The events a consumer loses are the ones saying the stream ended**
— and `tail` is the verb agents leave running for hours. Plus the SIGINT
handlers (`const stop = () => process.exit(0)`) and the `if (grounded)`
session-gone paths.

### ⛔ The shape is NOT the one-liner, and the obvious helper is a TRAP

**Measured (daedalus, Bun 1.3.14, 300KB per write, real shell pipe) BEFORE
anything was written:**

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
> statements — which is the situation at all five `tail` sites. **It is
> byte-for-byte the defect and it looks correct.** **G is why: a drain callback
> covers only its own write. It is not a barrier.**

_Stated as measured behaviour at 1.3.14, not as a claim about Bun's internals._

**⚠ And `D` (natural return) is NOT universally safe.** At
`bounty/scripts/join.ts` the one-liner **hangs** — `join.ts > idle timeout`
times out at 15s — because `process.exit` was doing **double duty**: the drain
was broken **and** force-terminating a live WebSocket was load-bearing. **The
honest fix there is a socket-lifecycle change, not P0's shape.** Carded
separately. **Shipping a hang to fix a truncation is a bad trade.**

**So P0f is a per-site lane with per-site preconditions.** _"A per-site shape
change with a per-site precondition cannot be verified by inspecting the
shape."_

### Why this is a NAMED lane and not folded back into P0

**This project has now shipped "done" three times over an unenumerated
remainder:** P0e held two halves, P0b enumerated one flag of three, P0 counted
files instead of sites. **Each read as complete because the part that shipped
was the part someone had enumerated.**

**The release note must say WHICH HALF.** The honest sentence is _"the
entry-point exits are fixed across eight files; the streaming verbs' terminal
exits are P0f"_ — **not** _"the drained exit is fixed."_ **A true claim that
reads as total costs the same trust as a false one.**

**Also ruled OUT and recorded** (daedalus, 2026-08-06): `grapevine/cli.ts`'s
`die()` — a small stderr write then `exit 2`, no stdout payload pending; and
`mind-mapper/server.ts:1784` — third spelling but a daemon, small boot JSON long
before any exit path. **The `die()` family in the other five CLIs is UNVERIFIED
— rule it in or out by measurement and record the rule-out either way.**

---

## Phase 0b — The inert `--restore` (#80.1)

**Owner:** daedalus · **Verify:** cassandra · **D3 ruled:** non-zero exit
**and** an envelope field

Separate lane from the drained exit: same phase and same defect class (a command
that cannot do the thing and returns something shaped like success), but a
completely different mechanism — control flow, not stdout draining. Do not merge
the two fixes into one commit.

**The mechanism, verified 2026-08-06 (fact, not claim):**
`plugins/spellbook/skills/bounty/scripts/cli.ts:388-397` — when `--session-key`
resolves to a board that is already live, `cmdOpen` takes the idempotent-attach
branch and **returns**. `--restore` is not appended to the daemon's args until
line 415, past that return. The flag is therefore never consulted on the attach
path, and nothing reports the skip.

**Not covered by D1.3.** Hydrate-by-default addresses the **dead**-daemon
respawn. The reported board was **live and empty**, so hydration never fires —
`--restore` was the only lever, and it was inert.

> ### ⚠ SCOPE CHANGED 2026-08-06 — this lane is the FLAG SET, not `--restore` alone.
>
> **The early return at `cli.ts:388-397` silently discards `--timeout`,
> `--restore` AND `--title`** — every flag appended after it. Verified against
> the live process, not the CLI's own echo:
>
> ```
> open --session-key K --timeout 14400   ->  "# attached to existing board"   exit 0
> ps -o args= of the daemon:  server.ts --timeout 30 --no-open --id k-dae2-…
> ```
>
> **The caller asked for four hours and got thirty seconds, silently.**
>
> **This plan enumerated ONE flag — a G4 violation inside the phase that cites
> G4.** An unenumerated set let the fix pick its own scope, which is the exact
> failure G4 exists to stop.
>
> **`--restore` was never the bug. The bug is an early return that discards
> everything after it**, and we had been describing one of its three symptoms.
> **Enumerate every flag the attach path cannot honour, by name, and gate the
> SET.** This is not scope growth; it is the same defect, correctly counted.

**Steps**

1. On the attach path, detect that **any flag that cannot be honoured** was
   passed (a live board already holds the key) — `--restore`, `--timeout`,
   `--title`, and anything else appended past line 414. Enumerate them.
2. **Exit non-zero** (D3 — ruled). **This half stands and is ratified.**

   **⛔ THE CORRECTIVE-VERB HALF IS FALSIFIED AND MUST NOT SHIP — measured
   2026-08-06 (daedalus), on a throwaway key, with a valid precondition cell.**

   D3 ruled that the refusal should name `--fresh --restore` as the fix, on the
   claim that it "tears the live board down and respawns from the snapshot."
   **The HANDOFF flagged this claim as the one still-unverified thing D3's
   entire ruling rested on. It was measured. It is false, and the failure mode
   is data loss.**

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

   **Mechanism — this is our own #73, load-bearing.** `cli.ts:398-408`, the
   `live && flags.fresh` branch, tears the board down by sending
   **`POST /cmd {type:"close"}`** — and **`close` writes the snapshot.** The
   board being closed is the _empty_ one, so close flushes **live(0) over
   snapshot(2)**. `--restore` _is_ then correctly appended at line 415 and the
   new daemon _does_ restore — **from a snapshot emptied 200ms earlier.** The
   teardown and the restore are wired to the same file **in the wrong order**;
   `--restore` is not ignored here, it is honoured against a corpse the teardown
   just made.

   > **A user in the exact situation this message is written for — live board
   > empty, real data only in the snapshot — would follow the instruction and
   > destroy the only copy.** The refusal would convert a recoverable state into
   > an unrecoverable one, with a non-zero exit and a helpful envelope field
   > explaining that it had done so.

   **Ruled (prospero, 2026-08-06): the refusal names NO corrective verb.** There
   is currently no safe one. The only measured sequence that preserves the
   snapshot is **`kill -9 <pid>` + a plain keyed `open`** (steps 1–4 of the
   construction below) — and naming a `kill -9` in a user-facing refusal is a
   decision for Cole, not a default. **An honest refusal that names no fix beats
   a helpful one that names a destructive fix.**

   **New defect, arguably outranking #80.1: `--fresh --restore` destroys a
   snapshot.** Same family as #73. Recorded here; **filing is Cole's call.**

3. **Announce in the envelope** (D1.2's convention, applied):
   `restoreSkipped: {requested, reason} | null` — **`null` when nothing was
   skipped, never absent.** The exit code is what a `set -e` wrapper or a
   Monitor catches; the field is what an agent parses.
4. **`SKILL.md` names the field and stops** (D1.4 — ruled). Two lines at most;
   do not restate the semantics.

**Real-board baseline — captured 2026-08-06 by the reporter, on the recovered
102-card board.** This is the pre-fix artifact the regression test gets written
against; our own repro is synthetic.

```
snapshot 102 · live deliberately diverged to 103
bounty open --session-key anthill-dev --restore k-anthill-dev-adad92ec
  EXIT ..... 0
  STDOUT ... {"url":…,"port":…,"session_id":"k-anthill-dev-adad92ec","title":"Bounty Board"}
  STDERR ... # attached to existing board k-anthill-dev-adad92ec (key "anthill-dev")
live AFTER . 103        (divergence survived)
```

**Nothing in stdout or stderr mentions `--restore` in any form** — not
performed, not skipped, not refused. That absence, plus the unreachable line
415, is what proves inertness. **The task-count delta does not**, per the gate
note below.

**⚠ Do not build the divergence by mutating the live board.** Snapshots are
**not** close-only: `server.ts:650-651` and `:1235` mark the snapshot dirty on
every board mutation and flush on a ~1s debounce (verified 2026-08-06 — card
added, snapshot absent at t+0, present with the card at t+~1s). So emptying live
flushes an **empty snapshot**, and the divergence this gate depends on destroys
itself. "Live unchanged after restore" is then consistent with both _inert_ and
_restored the same contents_.

**Reading the snapshot "immediately before the restore" does not fix it** — that
is the moment most likely to land **inside** the debounce window of the setup
step before it, and a stale read is indistinguishable from a true one. The
reporter hit exactly this: they re-read diligently, got
`snapshot 102 / live 103`, and the number was an artifact of the race that
**arrived as evidence for the wrong model.**

**Verified race-free construction (probe run 2026-08-06 — use this):**

```
1. open --session-key K --no-open ; add x2
2. poll the snapshot file until it reads 2   <- deterministic; never a fixed sleep
3. kill -9 the daemon                        <- NOT close; close writes the snapshot (#73)
4. open --session-key K --no-open            -> live 0, snapshot 2
5. assert live == 0 AND snapshot == 2        <- its own cell, before the measurement
6. open --session-key K --restore <id>       <- the measurement
```

Step 4 respawns **empty without mutating**, so nothing is dirty and nothing is
in flight — measured stable at live `0` / snapshot `2` after 3s idle. The
precondition in step 5 therefore has **no race to lose**, rather than a race
that usually resolves in time. Assert it as its own cell so the gate fails when
the number it depends on is stale, instead of silently comparing against it.

**Both load-bearing facts RE-MEASURED AND RATIFIED 2026-08-06 (daedalus):**

- **A mutation dirties the snapshot, flushed on a ~1s debounce** — snapshot
  **absent** at t+0 after two `add`s; **present reading 2 at ~1000ms**. Confirms
  that building the divergence by mutation destroys it.
- **A keyed respawn does not mutate** — after `kill -9` + a plain keyed `open`,
  live=0 while the **snapshot stayed 2**. This is what makes the construction
  race-free, and why step 4 is correct.

**⚠ They are still guarded by no test.** Pin both in `server.test.ts` as part of
P0b, per below.

**⚠ Reading the PID: `kill -9` must not read it from the discovery file.** That
file carries `url`/`port`/`session_id`/`title` and **no PID** — a kill built on
it silently no-ops, step 4 "respawns" onto the still-live board, and the
precondition degenerates to live=2/snapshot=2. Step 6 then shows "live
unchanged," which the plan warns is consistent with **both** inert and
restored-same-contents. **This happened on the first attempt at the drive and
the run looked clean.** Use `pgrep -f -- "--id <unique-session-id>"` — safe
because the id is unique, unlike the shared `scripts/server.ts` argv that once
cost this repo a live daemon.

**What caught it: printing the precondition as an asserted `VALID-CONTROL` /
`DEGENERATE` cell rather than treating step 4 as a step that obviously worked.**

**⚠ This construction's correctness depends on facts no test currently guards**
— that a mutation dirties the snapshot and flushes on a ~1s debounce, and that a
keyed respawn does **not** mutate. Both were measured on 2026-08-06 and neither
is pinned. **A doc claim drifts under its own code and fails no gate** (the
reporter's phrasing, and it applies to this plan): if either behaviour changes,
this gate keeps passing and stops meaning anything. **Pin both in
`server.test.ts` as part of P0b**, not as a follow-up — a mutation flushes
within the debounce, and `open --session-key` on a dead keyed board leaves the
snapshot byte-identical.

_Two incidentals from the probe, both worth their own attention._ Steps 1–4 are
**#64 + #73's real-world sequence in four commands** — a respawn-empty over a
good snapshot — which makes this a reusable P1 fixture; and the empty respawn
did **not** clobber the snapshot, confirming the clobber belongs to `close`
(#73) and not to `open`. Second, step 4's stderr was **completely empty**: no
attach line, and no warning that it had just respawned an empty board on top of
a populated snapshot. That silence is D1.3's whole case.

_Recorded because three separate attempts at this one control were degenerate in
one evening: the reporter's first baseline compared 102 to 102; their re-read
"fix" landed inside the debounce window; and the sequence this plan's author
sent as the replacement asserted "live unchanged == restore was inert." The
shape is hard, not the people — assume the next version is wrong too until a
mutation test says otherwise._

**Gate — AMENDED 2026-08-06 (cassandra's audit: the best-constructed of the
four; one real hole).** Subject to **G1–G4** above.

Build the divergence with the six-step construction above, asserting the
precondition (live `0`, snapshot `N`) as its own cell, then run
`open --session-key K --restore <id>` against the **live** board. It must exit
non-zero and carry `restoreSkipped`. Throwaway board only.

> **⛔ THE FINAL CELL IS STRUCK — it asserted a capability that does not exist,
> and running it destroys the fixture.** The gate used to end: _"then confirm
> `--fresh --restore` on the same key actually restores."_
>
> **`--fresh --restore` does not restore — it deletes the snapshot** (see step 2
> above). So the cell could never have passed, and **a gate step is an
> instruction someone follows**: whoever ran it would have destroyed the
> snapshot the rest of the gate depends on, then read the resulting empty board
> as a failed restore rather than as the gate eating its own fixture.
>
> **This cell was inside an audit I adopted "in full, no amendments," and its
> auditor came back unprompted to say her own verdict was incomplete.** Both
> facts are worth keeping: the adopt-in-full was mine, and the correction was
> hers.

**⚠ Hole closed — the `null` half was ungated.** D3/step 3 rules
`restoreSkipped: {requested, reason} | null`, **"`null` when nothing was
skipped, never absent."** The gate above only exercises the **skip** path, so
**a fix that emits the field only when it skips passes it and violates the
ruling.** Add a cell where a normal `open` skips nothing and the field must be
**present and `null`**:

```
assert "restoreSkipped" in envelope     // NOT the same assertion as:
assert envelope.restoreSkipped == null  // this one passes when the key is absent
```

Only the first catches it. Same rule for `snapshotBackedUp` and `hydrated` in
P1.

**⚠ Task-count evidence does NOT travel** (retained because the reasoning
applies to any count-based cell, including ones added later, even though the
step it was written about is now struck). A task count is the evidence this plan
elsewhere declares inadmissible. It is admissible **only inside a construction
that pins live `0` against snapshot `N`**, which is what makes the count
discriminating. **Anyone reusing a count check outside this construction is back
to the reporter's original error.**

**Field note (2026-08-06, unplanned):** the lead restored a dead team board with
`open --session-key … --restore <id>`. It worked — stdout was
`{url, port, session_id, title}` and **nothing else. No mention of `--restore`
in any form: not performed, not skipped, not confirmed.** So the **success**
path is exactly as silent as the skip path, and the only evidence the restore
fired was the task count. **A positive twin of `restoreSkipped` is therefore a
real question — but do not mint a name for it here** (see the vocabulary note in
P0c); it goes to the contract investigation with #85–#88.

---

## Phase 0c — The unparsed `--flag=value` (#81)

**Owner:** daedalus · **Verify:** cassandra · **D4 ruled:** support `=` **and**
reject unknown flags

Third P0 lane, third mechanism. **This one is house-wide, not bounty-only** — it
is the widest-blast-radius item in the project and the only P0 item that
silently corrupts **writes**.

**The mechanism, verified 2026-08-06 (fact, not claim):** `parseArgs` splits on
whitespace only, so `--owner=forager` yields a flag literally named
`owner=forager` with value `true`, and `flags.owner` stays `undefined`.
Downstream, `typeof flags.owner === "string"` is false → `scope.owner` is
undefined → `cmdState`'s `if (scope.owner || scope.mine)` block never runs → the
unfiltered board prints, exit 0. `--mine` is unaffected only because it is
boolean and takes no value — that asymmetry is what disguised this as an
`--owner` defect in #80.

**Reproduced on a 5-task board** (no large or recovered board needed):

```
state --owner forager        → 3 tasks  ["forager"]                     correct
state --owner=forager        → 5 tasks  ["forager","maestro","None"]    whole board
state --owner=zzz-nobody-zzz → 5 tasks  ["forager","maestro","None"]    whole board, exit 0
add "x" --owner=maestro      → {"ok":true,"sent":"task.add"}            stored owner = NONE
add "y" --status=doing       → {"ok":true,"sent":"task.add"}            stored status = todo
state --totally-bogus-flag z → exit 0, stderr empty
```

**~~Blast radius — audited 2026-08-06~~ — FALSIFIED and re-measured 2026-08-06
(thoth). The old per-spell table is below for the record; it is wrong in a way
that changes the work.**

> ~~`bounty` none · `grapevine` none · `glamour`/`imago`/`magpie` partial ·
> `mind-mapper` the only CLI that rejects unknown flags~~

**The unit is the arg-parsing ENTRY POINT, not the spell. There are 16 across 8
spells:**

| parser                                          | count  | `=` support      | unknown-flag rejection |
| ----------------------------------------------- | ------ | ---------------- | ---------------------- |
| `node:util` `parseArgs`, **all `strict: true`** | **10** | **YES — native** | **YES — already**      |
| hand-rolled                                     | **6**  | no               | no                     |

**The 6 hand-rolled parsers are the ENTIRE fix:** `bounty/cli.ts`,
`glamour/cli.ts`, **`glamour/server.ts`**, `grapevine/cli.ts`, `imago/cli.ts`,
`magpie/cli.ts`.

**The 10 already correct:** `astrolabe/cli.ts`, `astrolabe/server.ts`,
`bounty/server.ts`, `bounty/join.ts`, `digestify/review.ts`, `imago/server.ts`,
`magpie/server.ts`, **`magpie/discover.ts`**, `mind-mapper/cli.ts`,
`mind-mapper/server.ts`.

> ### ⚠ CORRECTED 2026-08-06 by an independent review, then RE-DERIVED. Read this before trusting any count above.
>
> **The first version of this table said 15 / 6 / 9 and named
> `magpie/discover.ts` as hand-rolled. It is not** — `discover.ts:262` is
> `const { parseArgs } = await import("node:util")` with `strict: true` at
> `:272`.
>
> **Two instrument blind spots, not two typos:**
>
> | detector                                   | could not see                             | consequence                                  |
> | ------------------------------------------ | ----------------------------------------- | -------------------------------------------- |
> | `grep 'from "node:util"'` (classifier)     | a **dynamic** `await import("node:util")` | `discover.ts` misfiled as hand-rolled        |
> | `grep "process.argv"` (entry-point finder) | **`Bun.argv`**                            | **`glamour/server.ts` never counted at all** |
>
> **`glamour/server.ts:486-497` is a hand-rolled parser that was missing from
> the set entirely** —
> `args.indexOf(\`--${name}\`)`, so no `=`, no unknown-flag rejection, no positionals. **It parses `--restore`.\*\*
>
> **⚠ The hand-rolled count staying at 6 is a COINCIDENCE** — `discover.ts` left
> the set and `glamour/server.ts` entered it. **A number that did not move makes
> this look like a one-word edit. It was a re-derivation.**
>
> _Both greps were honest measurements, run and not recalled. **The failure was
> not "did you check" but "what can the check not see" — a real measurement
> whose question was wrong.**_
>
> _`grapevine/scripts/daemon.ts` was flagged `UNVERIFIED` and is now **settled:
> it parses no arguments**, so the total is 16 and not 17._

**Verified on the real artifact, not the source:**

```
$ bun astrolabe/scripts/cli.ts nosuchverb --port=9999
astrolabe: Unknown option '--port'. To specify a positional argument starting
with a '-', place it at the end of the command after '--', as in '-- "--port"'
```

One line proving **both** halves: it split `--port=9999` on the `=` natively,
then rejected `--port` as unrecognized. **D4's ruled behaviour already ships in
this house, in nine places, today.**

**Three claims this kills:**

1. **"`mind-mapper` is the only CLI that rejects unknown flags" — FALSE.** Not a
   nit: that sentence sends the builder to mind-mapper for a reference
   implementation when eight closer ones exist.
2. **"`bounty`: `=` handling — none" — FALSE as a spell-level claim.** Two of
   bounty's three entry points handle it natively; only `cli.ts` does not. Same
   for `imago` and `magpie`, whose "partial" reads as one weak parser when it is
   really **one broken hand-rolled parser beside one already-correct `node:util`
   one, inside the same spell.**
3. **"A spell is one parser" — FALSE, and it has teeth for step 5's ward.**
   bounty's `SKILL.md` documents flags for **three** entry points in one
   document: `--port`/`--host` (`:344-345`) belong to `server.ts`, `--url`
   (`:561`) to `join.ts`, and neither appears in `cli.ts`.

**⚠ Consequence for step 2 — the likely correct fix is not "add a registry to
the bespoke parser," it is "DELETE the bespoke parser."** Replacing
`bounty/cli.ts:291-313` with `node:util` `parseArgs({strict: true, options})`
yields `=` support, unknown-flag rejection **and** the `--` terminator the
prose-positional collision needs — all three from the standard library, in the
shape nine siblings already use. **That makes "three spellings of one idea"
impossible by construction rather than by discipline.**

**`daedalus` rules this, not thoth:** `node:util` strict **throws** where the
hand-rolled parser **returns**, so the migration is real per-verb work, and the
`allowPositionals` interaction with `add`/`message` free prose is exactly where
the reference implementation broke seven tests. **The target set is 6 files, and
the pattern to copy is already inside the file being fixed.**

**Reference implementation — anthill's `define.ts` (offered on #80,
2026-08-06).** anthill landed this exact fix hours before we filed #81, for the
positional version of the same class: it splits on `=` at parse time
(`if (!arg.includes("=") && isValueFlag(...))`) and rejects unrecognized flags
at **parser altitude**, across 21 commands. Two lessons come with it, both paid
for:

- **Fix at parser altitude, not per-verb.** Their first attempt scoped the guard
  to one verb's `run()` and reached **1 of 13** leaves. Ours has the same shape
  — `parseArgs` is one function, but the _validation_ of what it produced is
  currently nowhere, and adding it verb-by-verb repeats their miss.
- **Positionals are what break.** Their first guard broke **seven tests**, and
  they now pin three controls where the first positional must keep working
  (`commit -- <paths>`, `comms send <body>`, `join <handle>`). Bounty is more
  exposed than anthill here, not less: `add` (`cli.ts:775`) and `message`
  (`cli.ts:895`) build their text with **`pos.join(" ")`** — free prose, and
  `message` is a verb agents use conversationally. There is no `--` terminator
  anywhere in the file.

**⚠⚠ CORRECTED 2026-08-06 — this plan, the HANDOFF and the convene brief all
said `add write the --draft section` "becomes a hard error the moment step 2
lands." All three were wrong in the way that matters.** The shipped `parseArgs`,
run verbatim:

```
["write","the","--draft","section"]        -> pos.join(" ") = "write the"       flags {draft:"section"}
["fix","the","--stdin","handler","later"]  -> pos.join(" ") = "fix the later"   flags {stdin:"handler"}
```

**Both exit 0 today.** The first silently truncates a task title. The second
**deletes two words from the middle of a sentence and simultaneously flips a
real behavioural flag (`--stdin`)** — on `message`, the verb `SKILL.md`
advertises for conversational use.

> **P0c step 2 does not break these callers. They are already broken, silently,
> and step 2 is what makes an existing corruption audible.**

**This changes P0c's justification, not its scope.** The `--` terminator is
**not** a mitigation for a behaviour change we are choosing to make — it is
**the fix for a live write-corruption bug**. The future-tense framing is what
made step 2 read as a risk to be managed rather than a repair. **The issue's
harm statement should lead with the corruption, not the mechanism:** _"a
conversational verb silently deletes words from the middle of your message and
flips a flag you did not pass"_ — #81 currently leads with `--flag=value`.

**It also hands the gate a control it could not otherwise have:** a
positional-preservation test asserting `"fix the --stdin handler later"`
survives **fails on today's code.** Every other P0c assertion can only be
written against post-fix behaviour.

**Steps**

1. **Support `--key=value`** in `parseArgs` — split on the first `=` only, so
   values containing `=` survive.
2. **Reject unrecognized flags** (D4 — ruled): non-zero exit, the offending flag
   named in the message. **Copy `mind-mapper`'s existing implementation** rather
   than inventing a second convention; if it needs generalising, lift it to a
   shared shape and say so. Do it **once at parser altitude**, not per verb.
   Resolve the prose-positional collision above in the same change — a `--`
   terminator is the conventional answer, and `--stdin` already exists as the
   escape hatch for both affected verbs.
3. **Apply to all SIX hand-rolled entry points** — `bounty/cli.ts`,
   `glamour/cli.ts`, `grapevine/cli.ts`, `imago/cli.ts`, `magpie/cli.ts`,
   **`glamour/server.ts`**. The other ten already have the ruled behaviour and
   **must not be touched.**

   **⚠ "Every spell CLI" under-scoped, and the miss is specific:** it reads as
   `cli.ts` only, which **skips `glamour/server.ts`** — a hand-rolled parser in
   a spell whose `cli.ts` is also being fixed. **A per-spell checklist therefore
   marks magpie done with a live defect still in it.** Track this list by
   **entry point**, never by spell.

4. **Regression tests on three axes.** A read path (`state --owner=X` must not
   return out-of-scope tasks); a write path (`add --owner=X` must not silently
   drop the owner) — a read-only test would have missed the worse half; and a
   **positional-preservation** control per affected verb, since that is what
   broke in the reference implementation. Assert the read path with a **bogus
   value through the `=` form** (`--owner=zzz-nobody-zzz` → zero tasks), not a
   valid one: `--owner=forager` returning tasks is a control that cannot come
   out differently, and is precisely the paraphrase that hid this bug for a
   round.
5. **~~`SKILL.md` sweep~~ — FALSIFIED 2026-08-06 (thoth). Replaced by an
   invariant.**

   The old wording — _"any documented example using a spelling that now errors
   must be corrected in the same change"_ — **sweeps an empty set, in the wrong
   direction.** Measured: **zero `--flag=value` occurrences in any spell
   `SKILL.md`** (all seven files, broad regex `--[A-Za-z0-9_-]+=`, 0 hits). And
   after step 1 the `=` form **starts working**, so a documented `=` example
   would be _fixed_ by this change, not broken by it. The examples that begin to
   error are the ones step 2 **rejects** — a different set entirely.

   **Replacement, owned by `thoth` and carried as a ward** (amended by its own
   author 2026-08-06 — the first wording assumed one parser per spell):

   > **Every flag named in a spell's `SKILL.md` is in the recognized set of the
   > ENTRY POINT that actually parses it, and every recognized flag across all
   > of a spell's entry points is documented.**

   **⚠ The naive "that CLI" version is worse than no ward.** bounty's `SKILL.md`
   documents three entry points, so a doc-vs-`cli.ts` check reports **three
   false positives on bounty today** — and **a check that cries wolf on correct
   code gets switched off**, which is how a ward stops protecting the thing it
   was written for.

   A ward is checked **when an entry point changes**; a sweep is checked once.

   **Ordering — half dissolved (good news).** For the **10 `node:util` entry
   points the recognized set already exists** (the `options` object), so the
   invariant is **checkable today** on 10 of 16, with no dependency on P0c. Only
   the 6 hand-rolled ones need step 2 first.

   **Ruled (prospero): HOLD the whole ward until P0c lands, then add all 16 at
   once.** A ward covering 9 while six known-broken parsers sit outside it is a
   checklist item that passes — and **reads as coverage.** The draft is written
   and parked; landing it early buys a partial check at the cost of a false
   all-clear, which is the exact trade this project exists to stop making.

   **⚠ Scope by CLI, not by regex.** The only `=`-form examples anywhere under
   the plugin are four lines in `imago/references/mediaforge.md`, and
   **`media-forge` is an external tool that is legitimately `=`-spelled.** A
   regex-driven sweep would "correct" them and **corrupt correct
   documentation.**

**⚠ This is a deliberate behaviour change.** Step 2 makes previously-silent
callers start failing. That is the intent (D4), but it means P0c is the item
most likely to surface breakage elsewhere in the house.

**⚠ Doc/parser divergence stops being cosmetic.** Today a flag that is
documented but unrecognized is silently ignored, exit 0. After step 2 it is a
hard error — so drift becomes a **caller-facing failure**. That is what thoth's
ward (step 5) exists to hold.

**Ruling (prospero, 2026-08-06):** the recognized set is **code, not prose.**
The registry lives in the parser; `SKILL.md` **documents** it; the ward checks
they agree. **Do not derive the recognized set from `SKILL.md`, and do not let
the doc become the registry.**

> **⚠ A stronger version of this warning was drafted and then FALSIFIED within
> the hour — recorded because the retraction is the useful part.** It claimed
> P0c "converts every `SKILL.md` into a load-bearing registry" because
> `parseArgs` "has no registry at all — step 2 authors the first one," and that
> this would create a second source of truth in violation of `seams.md`.
> **`node:util`'s `options` object IS a registry, and ten entry points in this
> house already have one** (see the table below). Step 2 does not author a
> convention; it **extends an existing in-house one to six holdouts.** The
> author of the original claim found and retracted it himself.

**anthill's caller audit — answered 2026-08-06, and it clears.** Its complete
invocation set is four calls (`bounty state`, `bounty sessions`,
`bounty open --session-key … --pin --no-open`, `grapevine who <channel>`), all
space-separated, with no `=` anywhere in code or in shipped prose — and it calls
neither `add` nor `message`, so the `--` terminator work breaks nothing on their
side. Their channel name, the one agent-controlled value they pass us, is
validated against `[A-Za-z0-9._-]` and so cannot be re-read as a flag.

**The residual argues _for_ P0c.** Their prose teaches the space form
everywhere, but nothing stops an agent improvising `--status=doing` — agents
adapt shipped examples constantly, which is what examples are for. Today that
silently no-ops and reports `ok:true`. **The check is still ours to run for
every other caller**, but the largest external consumer is clear.

**Field corroboration (weak, and recorded as weak).** The reporter audited their
102-card board for the write-corruption half: of cards whose titles name a seat,
19 have an owner, **5 are unowned**, 0 mismatched. They explicitly decline to
attribute those 5 to `--owner=` — the `add` calls were hand-typed in agent panes
and `grep` for `--owner=` across their tree finds nothing. Treat this as
pattern- consistent, not as a confirmed instance. The reproduction is the
evidence; this is not.

**Gate — REWRITTEN 2026-08-06 (cassandra's audit: survived, but the old Gate
line was the weak paraphrase).** Subject to **G1–G4** above.

**The old line said `=` must be "honoured identically to its space-separated
form" — which is the valid-value comparison this plan itself calls "a control
that cannot come out differently."** Step 4 had the sharp version; the Gate line
did not, and **the Gate line is what gets implemented.** Hoisted:

1. **`--owner=zzz-nobody-zzz` → ZERO tasks.** Not `--owner=alice` → some tasks.
   A bogus value through the `=` form is the discriminating cell; a valid one is
   the paraphrase that hid this bug for a round.
2. **Unknown flag exits non-zero, naming the flag.**
3. **Write path: `add --owner=<name>` stores the owner** — a read-only gate
   misses the worse half.
4. **Positional preservation, per affected verb, pinned as a LITERAL
   invocation** (G4) — `add write the --draft section` and
   `message fix the --stdin handler later`. **The second fails on today's code**
   (see the correction above), which makes it the only P0c cell that is
   discriminating pre-fix as well as post-fix.
5. **Enumerate the ENTRY POINTS** (G4), not the spells — and **partition them**,
   per the point below. "For each spell CLI" let a two-spell fix pass.

**⚠ A green across all 16 entry points is ~60% VACUOUS, and it reads as the
opposite.** The 10 `node:util` entry points **pass this gate before the fix and
after it** — they were already conformant, so no result they produce can fail.
By G2 that is decoration for those arms; it is only meaningful over the **6
hand-rolled** ones.

**Ruled: the gate reports its two populations separately.**

```
CONVERTED (6, discriminating): bounty/cli.ts glamour/cli.ts grapevine/cli.ts
                               imago/cli.ts magpie/cli.ts glamour/server.ts
ALREADY CONFORMANT (9, regression-only): astrolabe/cli.ts astrolabe/server.ts
                               bounty/server.ts bounty/join.ts digestify/review.ts
                               imago/server.ts magpie/server.ts
                               mind-mapper/cli.ts mind-mapper/server.ts
```

The 9 are still worth running — as a **regression check** that the change did
not break them — but they must not be counted as evidence the fix works. **A
single "15/15 green" is a true number that means far less than it looks like.**

**⚠ And the same trap is waiting in the RELEASE NOTE, which is where it will
actually mislead someone.** When P0c lands, the honest sentence is **not**
_"unknown-flag rejection now works across the house"_ — that phrasing implies we
built something that mostly already existed, and it will read as false to anyone
who greps. The accurate claim, and the one to ship:

> **6 converted · 10 already conformant · 16 total** — P0c brings six
> hand-rolled parsers onto the `node:util` `strict` behaviour the other nine
> already had.

**A true claim that reads as an overclaim costs the same trust as a false one**,
and this project's whole subject is signals that mislead while being technically
correct.

Pre-fix baseline, measured on a throwaway board 2026-08-06:

```
--owner alice           -> 1 task  ["alice"]                correct
--owner=alice           -> 2 tasks ["alice","maestro"]      whole board
--owner=zzz-nobody-zzz  -> 2 tasks ["alice","maestro"]      whole board
--totally-bogus-flag z  -> exit 0
```

---

## Phase 0d — Writes that report success without applying (#83, #84)

**Owner:** daedalus · **Verify:** cassandra · **No decision needed** — these are
defects against an existing contract, not a new convention. **Placement in P0
ruled by Cole 2026-08-06**, over the scope-growth objection.

Fourth P0 lane. Found by the 2026-08-06 envelope audit, not by a user. Same
defect class as the rest of P0 and **on the write path**, which makes it the
half that loses data rather than merely misreports it.

### #83 — `bounty add` is the only write verb that ignores `applied`

**The mechanism, verified 2026-08-06 (fact, not claim):** `server.ts` documents
`applied` as existing so the CLI can confirm a write took, and returns
`{ok:true, applied:false}` when `validateTask` rejects the task or
`applyTaskAdd` refuses it (duplicate id). `cli.ts:793` discards the result:

```ts
await postCmd(session, { type: "task.add", task }, { as }); // no `const res =`
```

It is the **odd one out** — `update` (821), `claim` (838), `block`/`unblock`
(864) and `remove` (883) all check. So this reads as an oversight, and the fix
is to match its four siblings, not to invent anything.

⚠ `message` (897), `close` (918) and the generic (914) also ignore it. Lower
stakes, but **`close` ignoring a failed apply belongs in the same pass** given
what P1 says about `close`.

### #84 — `/cmd` answers `ok:true` before it knows

**⚠ MECHANISM CORRECTED 2026-08-06 (daedalus, falsified in comms #34 and adopted
— the plan text was not amended until now).** The original framing called this
an `await` bug. **It is not, and `imago` is the disproof:**

```ts
// glamour server.ts:354-360   — not awaited …          returns {ok:true}
handleAgentMsg(b as AgentCommand);
return Response.json({ ok: true });

// imago server.ts:1182-1190   — AWAITED, correctly … returns {ok:true} anyway
await handleAgentMsg(body as Record<string, unknown>);
return new Response('{"ok":true}', …);
```

**`imago` already does the thing the fix was going to instruct.** So the defect
cannot be the missing `await`: **the route returns `ok:true` unconditionally,
and `handleAgentMsg` hands it nothing to report.** Adding `await` to glamour
makes glamour resemble imago — **which is also broken.**

magpie (`server.ts:635`) is the same shape. In those three spells `ok` means _"I
parsed your JSON."_ In bounty and astrolabe it means _"the write took effect."_
**One word, two meanings, five spells.**

**This is what P0's step 2 audit finds on the failure path** — it was never
reported because nobody had a reason to distrust `ok`.

**Steps**

1. #83: capture the result and fail loudly, naming the id and the reason.
2. #83: do the same for `close`; decide `message` and the generic explicitly and
   record the decision either way.
3. #84: ~~`await` the handler in all three spells and return what it decided.~~
   **REWRITTEN — the original step was a NO-OP that would have closed the issue
   without fixing it.** `imago` already awaits and is still broken, so "add the
   `await`" changes nothing there and only makes glamour resemble a second
   broken spell. **The actual work is two-part and the first part is the one the
   old step hid:**

   a. **`handleAgentMsg` must RETURN a verdict** in all three spells — today it
   returns nothing, so there is no decision for the route to propagate. This is
   the real change and it is inside the handler, not at the route. b. **The
   route must propagate that verdict** instead of returning a literal `ok:true`.
   `await` is necessary here but nowhere near sufficient, and it was never the
   defect.

   ⚠ **Gate this on the verdict, not on the presence of an `await`** — an
   `await`-shaped check passes against imago **today**, unfixed.

4. **Do not invent a new field name.** Use `applied`, which already exists and
   is already documented. The vocabulary question is
   [#82](https://github.com/ichabodcole/spellbook/issues/82)'s and is **on
   hold** — anything minted here would be re-spelled later.

**Gate — ⛔ THE ORIGINAL WAS DEFECTIVE. REWRITTEN 2026-08-06 (cassandra's
audit).** Subject to **G1–G4** above.

> **Do not run the old gate.** It said: _"`add` with a duplicate `--id` exits
> non-zero **and** a subsequent `state` does not show the task."_

**Why it was defective — this is an _inverted control_, the failure mode G2
exists to catch.** Measured on a throwaway board:

```
add "ORIGINAL TITLE" --id dup-probe --owner alice -> {"ok":true,...} exit 0
add "IMPOSTOR TITLE" --id dup-probe --owner bob   -> {"ok":true,"sent":"task.add"} exit 0   <- #83
state -> 1 task: id=dup-probe title="ORIGINAL TITLE" owner=alice   cursor 2 -> 2 (unchanged)
```

`applyTaskAdd` (`server.ts:410`) is
`if (state.tasks.some(t => t.id === task.id)) return false;` — it does **not**
overwrite and does **not** push. **On a duplicate id the board is completely
unchanged, and the original keeps that id by construction.**

So _"a subsequent `state` does not show the task"_ has two readings and the text
picks neither:

- **Literal** — _the id is absent from `state`._ **This fails against a correct
  fix**, because the original still holds it. The only way to satisfy it is a
  fix that also destroys the original — which the fix must never do.
- **Charitable** — _the impostor's content never landed._ Correct, but the gate
  never says it and never names the discriminating observable.

**A gate whose plain reading fails the correct implementation is worse than a
decorative one.** Decoration passes silently; this one produces a **false FAIL**
and sends the builder to "fix" `applyTaskAdd`, which is already right.

**Replacement — three cells, all measured to be discriminating:**

1. `add` with a duplicate `--id` **exits non-zero** and the envelope reports
   **`applied: false`** (existing field — mints nothing; see the vocabulary
   note).
2. **The surviving row is unchanged** — `title`, `owner`, `status`,
   `enteredStatusAt` are all still the ORIGINAL's. **This is the cell that
   catches a fix which silently overwrites**, the failure mode the literal
   reading cannot see at all.
3. **Task count unchanged AND `cursor` unchanged.** Cursor is the cheapest
   strong tell — confirmed not to advance on a refused add — and it
   discriminates _refused_ from _applied-then-reverted_.

**Second half — REWRITTEN. It has a FALSE PREMISE, not merely a missing
fixture.** The old cell read: _"For each of glamour/imago/magpie, a command the
reducer declines must not answer `ok:true`."_ It named no declining command for
any of the three, so the implementer picks the fixture — and picking one the
reducer _accepts_ makes it pass trivially (G4).

**Then it was driven. All three arms are MEASURED, none inferred** — the fixture
is a bogus `type` on `/cmd`:

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
everything-is-fine stub. **#84's defect is confirmed live across the full set.**

> _**Superseded within the hour, and the supersession is the lesson.** This cell
> was briefly ruled **`UNVERIFIABLE-PRE-FIX` for `glamour`** — reasoning that
> `server.ts:352-360` never `await`s the handler, so no decline is observable
> and nothing could fail the cell. **That was a verdict-of-absence built on a
> structural read**, and it dissolved as soon as someone got a glamour daemon up
> a **different way** (running `server.ts` directly instead of through `open`)
> and drove it._
>
> _**An arm that looks unfixturable is often an arm nobody has tried hard enough
> to fixture.** Recording the hole was right; keeping it would not have been._

**The rule it was recorded for still stands, and is why the hole surfaced at
all:** a gate arm that cannot be driven is written down as a **verdict**, never
left as an absence — **a silent 2-of-3 reads as full coverage.**

_Second instance of the false-premise category, and the category predicted it:
the criterion was written after P0d's first defective cell and it found this one
before anyone had looked at glamour._

⚠ **Do not extend this lane to #85–#88.** They are the same family and they are
deliberately out of scope — the contract investigation decides what right looks
like, and fixing them now means fixing them twice. See the proposal's Out of
scope.

---

## Phase 0e — The gate destroys the board it is gating (NEW, 2026-08-06)

**Owner:** daedalus · **Verify:** cassandra · **Ruled by prospero 2026-08-06:
this is a PREREQUISITE, not a fifth defect lane.**

**Not one of the fourteen.** Found by the team during the ratify round, by
having it happen to them — **twice, in forty minutes.**

### What happens

1. Every seat shell carries **`BOUNTY_SESSION_KEY=spellbook`** (anthill sets it
   so the team's verbs bind the team board — correct, and why our CLI calls
   work).
2. `server.test.ts`'s `runCli` (line 1533) spawns with
   **`env: { ...process.env, ...opts.env }`** — it spreads the ambient
   environment. The tests set `BOUNTY_HOME: uniqHome()` for isolation, with a
   comment at line 777 saying it exists so snapshots "never leak into the user's
   real `~/.bounty`".
3. **`BOUNTY_HOME` isolates the SNAPSHOT store (`cli.ts:60`). It does not
   isolate the KEY path.** `cmdOpen` (`cli.ts:384`) reads
   `process.env.BOUNTY_SESSION_KEY`, and `sessionKeyToId("spellbook", cwd)`
   resolves to the **live team board**.
4. So the test's `open` takes the **idempotent-attach branch at
   `cli.ts:388-397`** — the very lines P0b is about — attaches to the live team
   board, adds fixture cards to it, and then calls
   **`runCli(["close", "--session", session])`** (lines 1857, 2278).

**`close` is the #73 clobber verb. The gate calls it on the team's board, by
construction.**

### The control (one variable, both directions)

```
bun test bounty/scripts/server.test.ts                 -> 181 pass  7 FAIL  exit 1   (board dies)
env -u BOUNTY_SESSION_KEY bun test .../server.test.ts  -> 188 pass  0 fail  exit 0   (board survives)
```

Same suite, same machine, same minute. **The only difference is one inherited
environment variable.**

**The "7 failures" were the bug reporting itself** — the tests correctly noticed
the board they had attached to held 7 tasks where they expected 1. **A red gate
that is a symptom of your own live state is the same silent-wrong-answer shape
as the rest of P0.** True baseline once scrubbed: **1289 pass / 0 fail**, biome
clean.

### Why this is a prerequisite and not scope growth

- **It is test-only.** No production behaviour changes; it does not widen the
  release.
- **No land is safe until it exists.** The land command a seat is handed at join
  is **`<project gate> && anthill commit …`** — one shell string, composed at
  `team-join.ts:243` — so **landing runs the gate, and the team's own landing
  command was board-destroying.**

  > **⚠ Corrected 2026-08-06. This bullet used to say "`anthill commit` runs the
  > project gate in front of every commit." That is FALSE** — `team-commit.ts`
  > never executes a gate; it only names one in warning strings. **The shell
  > chain runs it.**
  >
  > **The conclusion was unaffected and the mechanism was wrong, which is why it
  > survived four readers.** It was written here by the lead, repeated in a
  > ruling, and then inherited by three seats — one into an upstream issue draft
  > whose top-ranked fix was unimplementable _because_ of it, and one into a
  > proof that had to be downgraded to a conditional inference. **A false
  > mechanism attached to a true conclusion is invisible to anyone checking the
  > conclusion.**

- **The SOP and this defect were in direct conflict:** the SOP tells every seat
  to baseline the gate at join, and every seat that obeyed killed the board.

### Steps

1. **Scrub the ambient key in the test harness** — `runCli` (1533) and the
   daemon-spawn helper (772-778):
   `env: { ...process.env, BOUNTY_SESSION_KEY: undefined, BOUNTY_SESSION: undefined, ...opts.env }`.
2. ~~**Interim guard, already applied:** `.anthill/config.json`'s `gate` field
   was changed to scrub the vars, so every seat's land is scrubbed **by
   construction rather than by memory**.~~ **DONE AND REVERTED 2026-08-06.** The
   guard did its job while step 1 was being built; the config is back to
   `bun run check && bun test`, because the scrub belongs in the harness and not
   in every consumer's config. **A workaround left in place after its fix lands
   is a second, quieter source of truth** — and it would have hidden a
   regression in step 1 from every seat.

**Gate:** with `BOUNTY_SESSION_KEY` set to a live throwaway board's key, the
full suite runs and **that board is still alive, with its cards unchanged,
afterwards.** Both directions (G2): confirm the pre-fix suite kills it.

> ### ⛔ REOPENED 2026-08-06. P0e had TWO halves; we shipped one and declared it done.
>
> **The gate above is why nobody noticed.** It asserts the **board survives**.
> It never asserts **the suite is green** under the seat-shell frame. **A world
> where the tests fail with the key set satisfies this gate completely** — which
> is how "P0e is done" and "the suite is red in a seat shell" were both true for
> a release. **That is a G4 enumeration hole in a gate that already shipped.**
>
> **Half 1 — the ambient env.** Landed `4b55da0`. Still correct, and now known
> to be **smaller than it looked**: the key axis is a **no-op in this repo**,
> because level 3 and level 5 of `resolveSession` resolve to the same board (see
> G1, amended). Two seats ran the key axis and got **opposite signs on the same
> cells** — a real effect does not reverse when a different operator runs it.
>
> **Half 2 — the discovery pointer. UNBUILT, and it is the unblock for every
> other lane.** The harness must set its **own private `TMPDIR`**, so a peer
> suite cannot reach its pointer. See G5 for the mechanism and the evidence.
>
> **Still test-only. Still changes nothing a user sees. Still does not widen the
> release.** P0e's original justification is unchanged — which is precisely why
> this is P0e's second half and **not** a fifth defect lane.
>
> **Gate for half 2 — STRUCTURAL, ratified 2026-08-06 (cassandra).** Landed as
> `d650c97`.
>
> ```
> after a suite run under a known ambient TMPDIR:
>   assert NO  <spell>-latest.json  at the TOP LEVEL of that TMPDIR
>   assert the pointer EXISTS inside the per-suite dir
> ```
>
> **An earlier draft of this gate asserted _"the full suite is green under a
> private `TMPDIR`"_ and was STRUCK as an inverted control** — that outcome is
> probabilistic and would fail a correct fix roughly one run in three. **This
> one asserts the MECHANISM: a file's location does not flake.** False pre-fix,
> true post-fix, deterministic in both directions, and it never reads a test
> result.
>
> **⚠ The second cell is not optional.** Asserting only the _absence_ passes
> trivially when the suite spawned no daemon at all. **That vacuity has bitten
> this project four times** — P0's sub-64KiB fixture, P0b's degenerate
> precondition, the ward's empty documented-set, `probe-help2`'s exit-127 cells.
> **General form: every _"X is not there"_ needs _"and the thing that would have
> put X there ran."_**
>
> **⚠ This gate is scoped to the PEER channel and does not read as such.** It is
> satisfied completely by a build where **all fixtures in a file share one
> pointer and race each other** — `mkdtempSync` at `server.test.ts:803` runs
> once at **module scope**, so `TEST_TMPDIR` is per-**file**, not
> per-**fixture**. **Per-run isolation is not per-fixture isolation**, and a
> gate that cannot see the difference is partial isolation reading as total, at
> the gate layer.
>
> **OPEN, unmeasured:** does any fixture's daemon outlive its test? If every
> daemon dies with its test there is no intra-file concurrency and the question
> closes. **Measure before building for it.**
>
> **⚠ Do NOT read a suite result — green or red — off a dirty tree.** Recorded
> because the lead did it twice in ten minutes and published a false finding
> from it. He ran the full gate while a peer had **uncommitted edits to
> `server.test.ts`**, the file that spawns the daemons, got a red, and broadcast
> _"G5 is necessary and not sufficient"_ as a measured result. It was withdrawn
> within the hour: **both greens on record ran on a clean tree
> (`uncheckedAgainst: []`), both reds on a dirty one**, and the variable tracked
> peer WIP perfectly across four runs.
>
> **The instrument already existed and was already assigned.** `anthill commit`
> prints `uncheckedAgainst` on every land, and the lead had explicitly taken
> ownership of the cross-seat view of it one hour earlier. **He did not run
> `git status` before treating an exit code as a fact about the world.**
>
> > **The SOP documents the green half — _"non-empty means your green was
> > measured against work your commit does not include."_ The missing corollary
> > is the dangerous one: a RED is equally uninterpretable, and a red is far
> > more likely to be published as a finding.**
>
> **Standing precondition, all gates: `git status` first. A gate is
> uninterpretable in BOTH directions while a peer has uncommitted work in the
> tree.**
>
> **⚠ The production defect is NOT fixed by this and is deliberately out of
> scope.** Users' daemons still share a machine-global pointer; four spells
> carry the identical shape in source (bounty, glamour, imago, magpie). **That
> is a candidate issue for Cole, filed beside #85–#88 with the contract
> investigation** — it is the same question as last session's candidate #2 (_a
> bounty read cannot identify which board answered it_) from the other end.
> **Fixing it here means fixing it twice.**
>
> _And it would give this session no relief either way: seats run the **cached**
> plugin copy (1.16.0), byte-identical to the repo but loaded from cache, so a
> pointer fix landed tonight does not change the daemons currently polluting the
> singleton._

**⚠ What P0e is NOT.** It stops _our tests_ from seizing a live board. **It does
not stop any other process carrying the ambient key from doing so**, and the
read envelope still cannot tell you it happened. That half is a candidate issue
below, not P0e.

---

## Candidate issues found during the ratify round (2026-08-06)

**None of these are in the fourteen. None are fixed in this project.** Recorded
so they are not re-derived, and so a lane does not quietly widen to catch one.
**Filing is Cole's call.**

| #   | finding                                                                                                                                                                                                                                                                                                                         | found by                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1   | **Any process carrying `BOUNTY_SESSION_KEY` can seize a live keyed board**, and the CLI serves it with no signal at the read site. A seat's write landed on a stranger board and failed with `no such task` — the wrong reason.                                                                                                 | daedalus + thoth (one event, two halves) |
| 2   | **A bounty read cannot identify which board answered it** — no session id, key or port anywhere in the `state` envelope. This is what made #1 undetectable.                                                                                                                                                                     | cassandra                                |
| 3   | **A `tail` that cannot attach retries forever**, announces it on **stderr**, and the shipped `grep -E '"type":"(task\|unblocked\|closed)"'` filter **swallows it** — so a wire attached to nothing is indistinguishable from a quiet lane. Sharpens P1 step 7: a tail that cannot attach must say so where the seat can see it. | thoth                                    |
| 4   | **A performed `--restore` is as unannounced as a skipped one** (see P0b's field note). Raises whether `restoreSkipped` needs a positive twin — **do not mint a name; take it to the contract investigation.**                                                                                                                   | prospero                                 |

Items 1–4 belong beside **#85–#88** with the
[CLI-contract investigation](../../investigations/2026-08-06-spell-cli-contract-investigation.md).

### Added by the BUILD round (2026-08-06, later the same day)

**Same rules: none are in the fourteen, none are fixed here, filing is Cole's
call.** Every one was found by using the shipped spells on ourselves.

| #   | finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | found by                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| 5   | **`close --help` CLOSES THE BOARD.** `--help` is unrecognized, the hand-rolled parser discards it, and the verb runs. `state --help` dumps the board; `tail --help` opens the stream and never exits. The three verbs that reject do so **by accident** — they demand a positional. **P0c fixes the destructive half by construction** (step 2 rejects unknown flags); making `--help` actually _print help_ is new behaviour and is **not** in scope. **The harm statement belongs in #81: an unrecognized flag is not ignored — the verb executes anyway, so on a destructive verb it is a destructive act with no signal.** | cassandra                    |
| 6   | **The discovery pointer is a machine-global singleton** at `join(tmpdir(), "<spell>-latest.json")`, unscoped by `BOUNTY_HOME`, in **bounty, glamour, imago and magpie**. Cleanup exists but is **graceful-exit-only**, so killed daemons never unlink: 2206 stale files, oldest 11 days. **Proven causally** (labelled-tracer injection). **`d650c97` closed the TEST-side channel repo-wide; 22 shipped-source sites remain — that is G5's repeal criterion, quantified.**                                                                                                                                                    | thoth + daedalus + cassandra |
| 7   | **`bounty message` answers `{"ok":true,"sent":"message"}` and leaves no durable trace** — `server.ts:949-950` `broadcast(...)` with no `events.push(...)`, alone among the write paths. Same family as #83/#84: a write-shaped verb reporting success with nothing to read back.                                                                                                                                                                                                                                                                                                                                               | prospero                     |
| 8   | **`bounty tail` replays its entire event history** with no default anchor — the same shape as the comms wire, which at least documents it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | prospero                     |
| 9   | **`mind-mapper` ships as inert payload.** 58 tracked files under `plugins/spellbook/skills/mind-mapper/`, **no `SKILL.md`**, absent from `grimoire/trigger-registry.md`. Per Contract 4 the marketplace copies the whole tracked subtree (`source: ./plugins/spellbook`), so it ships and registers nothing. **Not a user hazard — it presents no trigger surface — but "deliberately unreleased" and "tracked in the shipped subtree" cannot both be true.** Needs Cole: pre-release, or fallen out of the registry?                                                                                                          | thoth                        |

**⚠ #64 is NOT on this list and must not be closed by item 6.** See Phase 1 step
5 — the idle-timeout framing is arithmetically impossible, and the lead's
proposal that fixing the pointer would close #64 (and therefore cost nothing)
was withdrawn.

---

## Vocabulary: the freeze guards the WRONG direction (ratified 2026-08-06, thoth)

The rule "mint no new field names while #82 is on hold" was ratified on the
assumption that these names already exist somewhere. **Measured — they do not:**

| name               | in code                                                                    | in `SKILL.md`                           |
| ------------------ | -------------------------------------------------------------------------- | --------------------------------------- |
| `applied`          | **YES** — `bounty/scripts/server.ts:266` (`ApplyResult`), ~14 return sites | **YES** — `bounty/SKILL.md:228`, `:680` |
| `restoreSkipped`   | no                                                                         | no                                      |
| `snapshotBackedUp` | no                                                                         | no                                      |
| `hydrated`         | no                                                                         | no                                      |

So **"mint no new names" is trivially satisfiable and protects nothing** — there
is nothing to re-spell. **The real hazard is the inverse: all three get written
for the FIRST time, in different phases** (`restoreSkipped` in P0b step 3;
`snapshotBackedUp` and `hydrated` in P1 steps 3–4) **and possibly different
sessions — and a first spelling has no prior spelling to disagree with, so no
grep, no test and no reviewer catches a divergence.** #82 governs cross-tool
_convention_; this is _first use inside one tool_ and #82 would not have covered
it.

**Standing requirement:** `thoth` holds the three spellings as a canon fact and
checks them **at each land**. P0d step 4's "use `applied`, do not invent" is
**RATIFIED** — that field is real, documented and load-bearing.

---

## Phase 1 — Daemon lifecycle and snapshot integrity (#64, #73, #74, nits)

**Owner:** daedalus · **Verify:** cassandra · **D1 ruled:** backup-then-write,
announce in the envelope, hydrate by default

**Order within the phase is forced:** #64 is the trigger, #73/#74 the
consequence. But do **not** block the guards on a complete #64 root-cause — the
clobber is a footgun on a healthy daemon too.

**Steps**

1. **Backup-then-write** (D1.1 — ruled). A snapshot write that would replace a
   non-empty snapshot with an empty/materially-smaller state **backs up first,
   then writes**. It does **not** refuse: a refusal adds a second failure to an
   already-degraded recovery path, and trains `--force` into the runbook.
2. **Rotation** — `<session>-<ts>.json`, keep N. Must still read an old
   single-slot snapshot (additive).
3. **Announce in the envelope** (D1.2 — ruled):
   `snapshotBackedUp: {path, taskCount, reason} | null`. **`null` when nothing
   happened, never absent** — a readable blank distinguishes "not needed" from
   "not reported." stderr prose does not count; the consumer is an agent parsing
   JSON.
4. **`open --session-key` hydrates by default** (D1.3 — ruled), announcing
   `hydrated: {from, taskCount} | null`, with `--fresh` to opt out. **Do not
   prompt** — a prompt in an agent path is a hang.

   **⚠ The announcement must distinguish the two failures, because a consumer
   provably cannot.** anthill already ships the warning bounty does not
   (anthill#43): `convene` reads `bounty sessions`, subtracts the live count
   from the snapshot's, and prints
   `POSSIBLE BOARD LOSS … Do NOT close the board`. **It fires identically in two
   worlds that need opposite actions** — a respawn-empty over an intact snapshot
   (**recoverable**, and the reason not to `close`) and a snapshot `close`
   already clobbered (**unrecoverable**, where the honest answer is stop). Two
   reads and a subtraction cannot tell them apart; `open` knows at the moment it
   happens. Whatever we emit must name **which** one, or we have shipped their
   ambiguity first-party.

   _Their reporter also notes they **nearly dismissed** their own warning —
   `.bounty-session` pointed at the populated session, which looked like proof
   it was spurious. **A reconstructed warning is one a caller argues with; a
   first-party one is not.** If D1.3 lands well, anthill#43 should shrink or be
   deleted rather than maintained._

5. **#64 root cause — ~~enumerate, don't guess~~. THE IDLE-TIMEOUT FRAMING IS
   DEAD ON ARITHMETIC (2026-08-06, daedalus). #64 is genuinely unexplained.**

   The plan half-knew this — _"the failure survived a keep-alive tail, so the
   idle timeout theory is incomplete."_ **The incompleteness is not which board
   the tail was on. There was never a timeout short enough to fire.**

   | fact                                                                           | value                           | landed                    |
   | ------------------------------------------------------------------------------ | ------------------------------- | ------------------------- |
   | reported death                                                                 | **~20 minutes**                 | reported **2026-07-09**   |
   | default idle timeout (`server.ts:542`)                                         | **7200s — two hours**           | `d38a32a`, **2026-06-17** |
   | the requested flag                                                             | `--timeout 14400` (4h)          | —                         |
   | subscriber guard `if (subscriberCount > 0) return false` (`server.ts:210-212`) | watched boards never idle-close | `d38a32a`, **2026-06-17** |

   **Both guards landed three weeks BEFORE the report.** At the time of the
   report, a board with **zero** subscribers and **no** `--timeout` flag still
   lives two hours. **A death at ~20 minutes is not reachable by any timeout
   value in the code** — not the default, not the flag, watched or unwatched.

   > **"Idle" is the reporter's inference, not a measurement.** Every story
   > about _which timeout applied_ answers the wrong question. **Two were
   > proposed on 2026-08-06 — the lead's (a keep-alive tail misresolved to a
   > stranger board via the discovery singleton) and the engine seat's (a keyed
   > attach silently drops `--timeout`) — and the arithmetic kills both
   > equally.**

   **The surviving candidate, recorded as a candidate:** _something closed it._
   That needs no timeout, and it is the one class with a **proven instance in
   this repo** — the gate destroying live boards (`4b55da0`), and `close --help`
   executing (2026-08-06). **UNVERIFIED for #64 specifically.**

   **⚠ #64 is NOT closed by the discovery-pointer fix.** That fix is right for
   its own reasons and this is not one of them. _The lead proposed the inverse —
   that fixing the pointer would close #64 and therefore cost nothing — and
   flagged it in the same message as the hypothesis to trust least, because it
   dissolved a scope problem too conveniently. It did, and it was._

   **⚠ The reporter's binding is UNVERIFIED — UNREACHABLE-BY-CONSTRUCTION.** It
   lives in another repo, in a session seven days before diagnostics logging
   existed. Recorded as unreachable rather than counted as checked.

   **This strengthens the case that P1 needs its own ratify round**, not that
   #64 should be chased inside this project.

6. **Fold in the robustness nits** (`2026-06-15-bounty-daemon-robustness-nits`):
   R1 `prevBlocked` stale entry; R2 non-numeric `?since=` replaying everything;
   #3 unbounded `events[]`; **#4 `tail` retries forever on abnormal daemon
   death** — #4 is the "fails silently" half of #64 and belongs here.
7. **Tail-death visibility:** a final `daemon exiting` event on the SSE stream
   so consumers can tell death from idle. Three agents' Monitors died silently
   alongside the daemon.

**The mechanism splits, and both a fixture and a real event agree.** The
respawn-empty does **not** touch the snapshot — the clobber is `close`'s alone.
Verified on a throwaway board 2026-08-06 (P0b's construction, steps 1–4), and
corroborated independently by the reporter's unplanned session-12 incident: a
multi-session board went live-and-empty over a **97-task** snapshot and the
snapshot was **intact**, recovered by reading `~/.bounty/snapshots/<id>.json` by
hand. Those cards are still on their board. **So #64/#73 are two bugs that read
as one**, they fail in opposite directions (exposure vs destruction), and the
guards can be built and gated separately.

**Gate:** kill a daemon holding a populated board; respawn; `close`; confirm the
snapshot still holds the tasks. This is the exact sequence that destroyed data
twice — reproduce it on a **throwaway** board. **P0b's six-step construction is
this fixture**; build it once and both phases use it.

---

## Phase 2 — Bounded reads (#75 + bounty tail-drain twin)

**Owner:** daedalus · **Verify:** cassandra · **Depends on:** P0

Two spells, one missing primitive, surfaced independently. **Pick one flag name
and one semantic and ship both** rather than letting `--drain` and `--no-follow`
diverge into two spellings of one idea.

**Steps**

1. Name the flag (one decision, both spells).
2. `grapevine tail` — print the requested range (`--from-start` / `--since <id>`
   / `--last <n>`) and exit 0 without following.
3. `bounty tail` — the same verb and semantic (closes
   `2026-06-15-bounty-tail-drain`).
4. **Piping regression test** — this command's whole job is print-then-exit, so
   it is maximally exposed to the P0 shape.
5. Check whether `anthill:join`'s backfill step should be simplified upstream;
   file there, don't fix it here.

**Gate:** a cold agent backfills a >64KiB channel in one command and gets
complete, parseable history.

---

## Phase 3 — Legibility and honest signals (#79, #72, #11, #76, #40)

**Owners:** circe (surface) + daedalus (CLI/derivations) · **D2 ruled:** take
the big swing

**Steps**

1. **Define what counts as evidence** — the one open sub-question, and the only
   thing that must be settled before code. Candidates: commits by this owner
   while holding the card, board mutations, vine activity. Propose to the lead;
   this is not a licence to expand scope.
2. **Build the evidence-based poke** (#76 + #40 in one model). A `doing` card
   pokes when there is **no evidence of movement**, not when a timer elapses.
   **Blocked-ness is one evidence input, not a separate skip** — that is what
   unifies the two issues instead of layering a skip on a timer.
   - Touches `server.ts` (`computeDuePokes` ~L106-135, `cardOverdue` ~L145-152,
     `expectedMinutes` ~L97-101, `Task.blockedBy` ~L76) **and** the Alpine
     `cardOverdue` mirror in `template.html`.
   - `2026-06-22-bounty-heartbeat-skip-blocked` carries the approved
     blocked-predicate derivation (`blockedBy` ∩ not-done) — **reuse the
     predicate, drop its skip-shaped framing.**
   - ⚠ The `SKILL.md` line survives but **changes job**: under blocked-skip it
     was a prerequisite ("model waits as block edges or this does nothing");
     under evidence-based poking it is a hint. Do not carry the old wording over
     — it would overstate what the human must do.
3. **#79 `bounty list`** — either rename to `bounty boards`, or have the output
   name its own noun ("2 boards") so a plausible zero can't read as "your cards
   are missing." One or the other, not both.
4. **#72 size badge** — `S`/`M`/`L` chip on the card, `--expect` minutes on
   hover, plus an edit affordance so re-sizing isn't CLI-only. Note the size's
   role weakens once poking is evidence-based; it stays useful as a human
   planning signal, which is what #72 asked for.
5. **#11 wordmark** — the surface still renders "Tuskboard"; regenerate as
   Bounty.
6. **`state` should report the scope it applied** (added 2026-08-06 from the
   anthill vine — small, and the same defect class as the rest of P0). `--mine`
   means _own **plus claimable**_ (`cli.ts:241`), which is intended and is
   documented at `SKILL.md:391`. `cli.ts:521` even announces it per call —
   `# scoped to --mine (owner=X + claimable)` — **but it writes that to stderr,
   and every consumer of `state` reads stdout through a pipe.** A second team
   read `--mine` returning 62 rows as a filtering bug and came within a message
   of filing it next to #81. Put the scope in the payload it describes, beside
   `cursor`: `scope: {mine, owner, as, includesClaimable}`. **No semantic
   change** — `--mine` keeps meaning mine-plus-claimable. This is the same rule
   as D1.2 applied to a read: _a disclosure on a channel the consumer does not
   read is not a disclosure._
7. **`bounty sessions` emits prose, not JSON** — alone among the read verbs
   (`k-anthill-dev-adad92ec  102 tasks  — anthill-dev — session 12`). Every
   other read returns an envelope, so a caller that reasonably assumes JSON gets
   a parse error from the one verb used **during recovery**, when they are
   already worried the data is gone. Same family as #79: the tool answering in a
   shape the caller did not ask for. Give it the standard envelope; keep a human
   rendering behind `--human` if it is worth keeping at all.

**⚠ Surface-mirror discipline:** every `server.ts` derivation touched here has a
hand-written Alpine twin in `template.html` and **no test guards the drift.**
Change both in the same commit, and name both paths in the land.

**Gate:** a blocked card and a session-length card that are both **moving**
produce no pokes; a card with **no evidence of movement** still pokes regardless
of size; a card whose only blocker went `done` and which then goes quiet pokes
again. Note this gate is stated in evidence terms, not elapsed-time terms — if
it still reads as a timer, the model didn't change.

---

## Release

> ### ⚠ THE RELEASE NOTE IS WHERE THIS PROJECT'S OWN DEFECT CLASS WILL RECUR
>
> **Every honest sentence below was earned by a false one being caught first.**
> This project exists because tools reported plausible, well-formed, wrong
> results — **a release note that overstates does the same thing to a reader who
> cannot grep.**
>
> **1. Say WHICH HALF.** P0 fixed the **entry-point** exits at eight ruled-in
> sites (nine were fixed; `magpie/discover.ts` was subsequently ruled OUT). **44
> in-function sites remain (Phase 0f)**, including the `write→exit` pair inside
> `tail` in five spells. The honest sentence is _"the entry-point exits are
> fixed across eight files; the streaming verbs' terminal exits are filed as
> P0f"_ — **not** _"the drained exit is fixed."_
>
> **2. Distinguish PINNED from VERIFIED.** A **test** prevents regression
> tomorrow; a **drive** proves it today. Sites verified by a recorded drive
> (magpie/cli, imago, glamour — no process-spawning harness exists in those
> suites) are **not pinned**, and _"9 of 9 gated"_ would assert the first while
> delivering the second.
>
> **3. Say CONVERTED vs ALREADY CONFORMANT.** For P0c: **6 converted · 10
> already conformant · 16 total.** _"Unknown-flag rejection now works across the
> house"_ implies we built something that mostly already existed and **will read
> as false to anyone who greps.**
>
> **4. Name what a fix does NOT reach.** `d650c97` closed the discovery
> pointer's **test-side** channel; **22 shipped-source sites remain.** Seats
> also run the **cached** plugin copy, so an in-repo fix does not change
> already-running daemons.
>
> **A true claim that reads as an overclaim costs the same trust as a false
> one.**

1. Conventional commits throughout (`fix(bounty)`, `fix(grapevine)`,
   `feat(bounty)`) — release-please owns versions, **no hand-edited version**.
2. Re-read both `SKILL.md` files against what actually shipped. Anything this
   project falsified must be corrected here; that is the in-scope slice of
   `2026-07-09-bounty-grapevine-skill-review`.
3. Cold-gate the assembled release (cassandra), not just the phases.
4. Cole cuts the release and pushes — **the agent does not push or release.**
5. Move every closed backlog item to `docs/backlog/_archive/`.
6. Comment the GitHub issues as they close.

## Open Questions

- ~~D1 and D2 need Cole.~~ **Both ruled 2026-08-05** (proposal). One
  sub-question survives: **what counts as "evidence"** for D2's poke — owning
  seat proposes, lead rules.
- ~~D3 (#80: does a skipped `--restore` exit non-zero?) needs Cole.~~ **Ruled
  2026-08-06** — non-zero exit **and** the envelope field. P0b is unblocked.
- ~~#80's `--owner` sub-claim is unreproduced.~~ **Resolved 2026-08-06 — it was
  real, and it was not the truncation.** The reporter's measurement was
  **unpiped** against a whole 122KB payload, with a discriminating control: a
  **nonexistent** owner also returned the full board, which a
  working-but-permissive filter cannot produce. Root cause is `parseArgs` not
  handling `--key=value` → **#81**, now P0c. The earlier "symptom of #78" theory
  was wrong, and the scratch board failed to reproduce it for one reason:
  **every check used the space-separated form.** _Lesson for the remaining
  phases — reproduce the reporter's exact spelling, not a reasonable paraphrase
  of it._ The reporter's generalisation, which is the better statement and is
  adopted here: **a paraphrase of the input is a control that cannot come out
  differently, because it removes the variable under test while still looking
  like the same test.** Applies to every gate in this plan, not just repro —
  before accepting a gate as passed, ask what result would have failed it.
- ~~Does P0's audit find the shape beyond the two reported spells?~~ **Yes —
  seven files.** Now a question of which of the five unreported ones can
  actually emit an over-buffer payload.
- **Does an envelope field belong on other destructive verbs too?** D1.2 adds
  `snapshotBackedUp` to the snapshot path. If the reasoning holds (agents parse
  JSON; a readable `null` beats an absent key), the same shape may be owed
  elsewhere. Do **not** expand scope for it here — note what you find.
- Is #64's root cause reachable this session, or does it need its own
  investigation? If enumeration stalls, ship P1's guards anyway and split #64
  out rather than blocking the release on it.
- Does the bounty snapshot format change warrant a migration note for teams with
  live boards?
