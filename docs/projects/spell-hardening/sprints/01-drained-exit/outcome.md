# Sprint 01 outcome — The drained exit

**Sprint:** 01 · `sprints/01-drained-exit/` **Ran:** 2026-08-05 (ratify) →
2026-08-06 (build) **Closed:** 2026-08-06 **Plan:** [`plan.md`](./plan.md) —
**frozen; do not edit it, and do not act on it** **Branch:**
`fix/spell-hardening`, merged to `develop` at **`7a32677`**

> ## The honest headline
>
> **Zero of the fourteen GitHub issues are closed.** Six code commits landed and
> one whole defect lane is done, but nothing was released and nothing was
> commented shut. **A sprint that fixed real code and closed no issues is the
> accurate summary**, and it is the one this project's own subject matter
> demands: a true claim that reads as total costs the same trust as a false one.

---

## What the sprint was

Two rounds against one plan, both by the anthill team — `prospero` leading,
`daedalus` engine, `cassandra` verify, `thoth` grimoire (`circe`, surface,
deliberately unseated in both).

| round      | date          | scope                                   | outcome                                                                                                                                |
| ---------- | ------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **ratify** | 2026-08-05/06 | ratify the P0 family. **Not build it.** | P0 family ratified; **six claims in the plan falsified**; P0e admitted as a named exception; an independent review then found two more |
| **build**  | 2026-08-06    | build the ratified P0 family            | **P0 and P0e shipped. P0b, P0c, P0d, P0f not started.**                                                                                |

**Gate at close:** **1297 pass / 0 fail**, biome clean, **under a private
`TMPDIR`** — a frame that did not exist when the sprint opened, and which the
sprint had to build (P0e half 2) before any other number could be trusted. The
ratify round closed at 1291/0 under a _shared_ pointer; **that number is void by
the sprint's own G5 ruling** and is recorded here only so nobody reads the
1291→1297 delta as test growth alone.

---

## Planned vs. shipped

The plan carried ten lanes. **Two shipped.**

| lane                                                  | planned                                                                 | shipped                                                                                                             | status                       |
| ----------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| **P0** — the drained exit                             | fix the shape at every site that can emit >64KiB through a pipe         | **YES**, at the entry points. 9 sites fixed, 1 (`magpie/discover.ts`) subsequently ruled OUT → **8 ruled-in files** | **DONE (entry points only)** |
| **P0e** — the gate destroys the board it gates        | scrub the ambient session key **and** give the harness its own `TMPDIR` | **YES, both halves.** Half 1 landed pre-merge (`4b55da0`); half 2 at `d650c97`                                      | **DONE**                     |
| **P0f** — the in-function exits                       | _did not exist at sprint open_ — split out mid-sprint                   | **NOTHING.** Named, denominated, and left unbuilt                                                                   | **UNBUILT** (carry-forward)  |
| **P0b** — the inert `--restore`                       | refuse non-zero + `restoreSkipped` envelope field                       | **NOTHING**                                                                                                         | **UNBUILT** (carry-forward)  |
| **P0c** — the unparsed `--flag=value`                 | `=` support + unknown-flag rejection across 6 hand-rolled parsers       | **NOTHING built.** One prerequisite artifact landed (`4f3488d`)                                                     | **UNBUILT** (carry-forward)  |
| **P0d** — writes that report success without applying | `bounty add` checks `applied`; `/cmd` returns a verdict                 | **NOTHING**                                                                                                         | **UNBUILT** (carry-forward)  |
| **P1 / P2 / P3**                                      | not in this sprint's build scope; **still unratified**                  | **NOTHING**                                                                                                         | **UNRATIFIED**               |
| **Release**                                           | `SKILL.md` re-read, cold gate, archive backlog, comment issues          | **NOTHING.** No release cut, no issue commented, no backlog item archived                                           | **UNBUILT** (carry-forward)  |

### The release sentence this sprint earned, verbatim

The plan rules the true sentence, and it is **not** "the drained exit is fixed":

> **"the entry-point exits are fixed across eight files; the streaming verbs'
> terminal exits are filed as P0f"**

**Why the distinction is load-bearing and not pedantry.** P0's audit enumerated
**one exit per FILE** — the `main()` wrapper. **The defect's unit is the SITE.**
A source-scanning guard measured **44 remaining `process.exit(` sites** after
`c29aa4e` + `ec33378`, and the highest-harm shape among them sits inside `tail`
in five spells: write the terminal event, exit on the next line, on a verb that
is _always_ on a pipe and that agents leave running for hours.

**This project has now shipped "done" over an unenumerated remainder three
times** — P0e held two halves, P0b enumerated one flag of three, P0 counted
files instead of sites. **Each read as complete because the part that shipped
was the part someone had enumerated.**

### Three more claims the release note must carry (ruled, unshipped)

1. **PINNED ≠ VERIFIED.** A test prevents regression tomorrow; a drive proves it
   today. Of the nine P0 sites, **5 are pinned by a regression test and 4 by a
   recorded drive only** (`magpie/cli`, `imago`, `glamour` — no process-spawning
   harness exists in those suites). _"9 of 9 gated"_ asserts the first while
   delivering the second.
2. **CONVERTED vs ALREADY CONFORMANT** (for P0c, when it ships): **6 converted ·
   10 already conformant · 16 total.**
3. **Name what a fix does NOT reach.** `d650c97` closed the discovery pointer's
   **test-side** channel; **22 shipped-source sites remain**, and seats run the
   _cached_ plugin copy, so an in-repo fix does not touch already-running
   daemons.

---

## The six code commits

All on `fix/spell-hardening`, merged to `develop` at `7a32677`.

| sha       | what                                                                         | why it is here                                                                                                 |
| --------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `d650c97` | **P0e half 2** — the harness owns its own `TMPDIR` (`bounty/server.test.ts`) | The discovery pointer escapes `BOUNTY_HOME`. **This is the unblock: every green measured before it is void.**  |
| `c29aa4e` | **P0 drained exit in `bounty/cli.ts`** + its gate (`server.test.ts`)         | And **the gate a `Bun.spawn` pipe could not see** — the decoration trap, caught by mutation                    |
| `ec33378` | **P0 drained exit at the remaining eight CLI sites**                         | astrolabe · bounty/join · digestify · glamour · grapevine · imago · magpie/cli · magpie/discover · mind-mapper |
| `59517c3` | **P0 gate, grapevine** — a >64KiB `pull` survives a PIPE (#77)               | `cli.test.ts`, +46                                                                                             |
| `92e1c57` | **P0 gate, digestify** — a >64KiB submission survives a PIPE                 | `review.test.ts`, +72                                                                                          |
| `62a5972` | **glamour — release the daemon's stdout pipe in `open`**                     | **A regression shipped by `ec33378` and fixed inside the same session.** See below.                            |

Plus **20 docs commits**, which on this branch are not commentary — **they are
the rulings.** Every falsification below landed as its own commit, which is why
each is individually traceable. Notable: `82ec61c` (pin the audit table to
`5dfbb0d` rather than renumber), `a4b7794` (G5's repeal criterion would have
self-fired), `caf83aa` (Phase 0f is born), `2227f25` (`magpie/discover.ts` ruled
out and the count propagated), `4f3488d` (the P0c recognized-flag-set artifact,
now
[`artifacts/p0c-recognized-flag-sets.md`](../../artifacts/p0c-recognized-flag-sets.md)).

### The regression, recorded because it is the sprint's costliest defect

`ec33378` replaced `process.exit(code)` with a natural return at eight entry
points **as one bulk mechanical edit.** At `glamour`, `process.exit` had been
doing **double duty** — draining stdout (broken) **and** terminating despite a
live child pipe (**load-bearing, and nobody knew**). `glamour open` post-fix ran
for **23 minutes** and never returned; pre-fix it returned normally.

**The engine seat had reverted the identical pattern at `bounty/join.ts` four
commits earlier — because he opened that file.** He shipped it at `glamour`
**because glamour was one of eight.** Same engineer, same pattern, same night.
**The variable was bulk.**

**The gate lesson, which outlives the instance:** the suite was green, both P0
gates were green, and a 23-minute hang in a shipped spell's entry verb was
invisible to all of them, **because nothing asserts that a CLI RETURNS.**

⚠ **The shipped fix and the plan's prescription differ.** The plan's amendment
says `child.stdout.destroy()`; `62a5972` shipped **`child.stdout.unref()`**,
stating both were measured clean in a synthetic repro of the exact spawn shape
and that `unref` is the conservative spelling. **The plan was never amended to
match.** Sprint 02 restates the trap against what actually shipped.

---

## What was falsified, and by whom

**Plans are claims.** These are the ones the sprint disproved, so the next plan
does not inherit a dead assumption.

### The ratify round — six, in a plan written by one author

| falsified                                                                                                                                                                                                                         | by           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| **P0d's gate was an INVERTED CONTROL** — its plain reading **fails a _correct_ fix**, and would have dispatched the builder to "fix" `applyTaskAdd`, which was already right                                                      | `cassandra`  |
| **P0c step 5's `SKILL.md` sweep swept an EMPTY set**, and in the wrong direction (0 `=` occurrences in all seven `SKILL.md` files). Replaced by an invariant                                                                      | `thoth`      |
| **P0c's blast-radius table was wrong in both directions** — the unit is the **entry point**, not the spell; and **P0c's positional corruption is LIVE today**, not a future consequence of step 2                                 | `thoth`      |
| **D3's corrective verb is DESTRUCTIVE.** `--fresh --restore` does not restore — it **deletes the snapshot**. The refusal now names no corrective verb                                                                             | `daedalus`   |
| **#84's mechanism is not an `await` bug** — `imago` awaits correctly and is still broken. The route returns `ok:true` unconditionally and the handler hands it nothing to report                                                  | `daedalus`   |
| **The gates were never valid from a seat shell** — they inherit `BOUNTY_SESSION_KEY`; and **"assert which session answered" is unsatisfiable from the read envelope** (no session id, key or port anywhere in a `state` response) | `cassandra`  |
| **`HANDOFF.md` carried two stale claims, one destructive**                                                                                                                                                                        | (the review) |
| **P0e added** — the project's own gate destroyed the live team board **twice in forty minutes**                                                                                                                                   | `daedalus`   |

> **The deflation the four seats recorded themselves:** _"None of the
> independent review's findings were caught by the four of us checking each
> other. It took an outside reader given no frame."_

### The build round

| falsified                                                                                                                                                                                                                                                                                                                                               | by                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **"Through a pipe" names TWO things and only one reproduces the bug.** `Bun.spawn({stdout:"pipe"})` — how every harness in this repo drives a CLI — **cannot fail on this defect.** The engine seat wrote that gate, it passed, he restored the bug, **and it passed again.** Nine ruled-in sites × a gate that cannot fail = **nine decoration gates** | `daedalus` (`291836c`)                              |
| **P0's audit counted FILES; the defect's unit is the SITE.** Phase 0f is born, with a measured denominator of 44                                                                                                                                                                                                                                        | `daedalus` (`caf83aa`)                              |
| **`magpie/discover.ts` is NOT a P0 site** — its large payload goes to `Bun.write(out, …)`, a FILE; stdout gets a human summary; nothing spawns it. **The payload and the channel had been treated as one thing**                                                                                                                                        | `daedalus`, ruled out by its own finder (`2227f25`) |
| **G5's repeal criterion would have SELF-FIRED.** _"Repealed the moment the harness does it for you"_ — `d650c97` made that true for **bounty's** harness, so by its own words G5 repealed itself while three other suites still wrote the machine-global pointer. Rewritten per-spell                                                                   | (`a4b7794`)                                         |
| **P0c's counts said 15/6/9 while its own table said 16/10** — a **dynamic** `await import("node:util")` was invisible to the classifier grep, and **`Bun.argv`** was invisible to the entry-point grep, so `glamour/server.ts` **was never counted at all**. The hand-rolled count staying at 6 is a **coincidence**                                    | an independent review, then re-derived (`7f8518d`)  |
| **#64's idle-timeout framing is DEAD ON ARITHMETIC.** Both guards landed three weeks _before_ the report; a ~20-minute death is unreachable by any timeout value in the code. **#64 is genuinely unexplained**, and the pointer fix does **not** close it                                                                                               | `daedalus`                                          |
| **"`anthill commit` runs the project gate before every commit" is FALSE** — `team-commit.ts` never executes a gate; the shell chain does. **A false mechanism attached to a true conclusion survived four readers**                                                                                                                                     | (`166e57e` era)                                     |
| **A red gate read off a DIRTY TREE is uninterpretable.** The lead published _"G5 is necessary and not sufficient"_ as a measured result while a peer had uncommitted edits to the very file that spawns the daemons; withdrawn within the hour                                                                                                          | the lead, self-caught                               |
| **The glamour `/cmd` arm was briefly ruled `UNVERIFIABLE-PRE-FIX` and it dissolved** as soon as someone got a glamour daemon up a _different_ way and drove it. **An arm that looks unfixturable is often an arm nobody has tried hard enough to fixture**                                                                                              | `cassandra`                                         |
| **6 of 9 `file:line` audit references went stale WITHIN THE SESSION**, moved by the very fixes the table commissioned. Fixed by pinning the table to `5dfbb0d` — **not** by renumbering                                                                                                                                                                 | the lead (`82ec61c`)                                |

---

## What this outcome could NOT confidently classify

**Recorded as unresolved rather than guessed, per the plan's own standing
rule.**

1. **"8 sites" vs "9 sites" vs "10 sites" for P0.** The audit ruled in 10, then
   ruled `magpie/discover.ts` OUT. The retro reports **"9 of 9 verified"**; the
   plan's release section says **"eight files"** and, in the same paragraph,
   _"nine were fixed; `magpie/discover.ts` was subsequently ruled OUT."_ **All
   three numbers are defensible readings of the same events** — nine sites were
   patched by `c29aa4e` + `ec33378`, eight of them ruled in, one patched then
   ruled out. **No renumbering is attempted here.** Sprint 02 should say _"fixed
   nine, ruled in eight"_ and stop.
2. **The 44-site P0f denominator has moved.** It was measured after `c29aa4e` +
   `ec33378`. Re-measured at `7a32677`: **45** non-test `process.exit(` sites
   under `plugins/spellbook/skills/*/scripts/`. **The +1 is `62a5972`** —
   `glamour/cli.ts` went 5 → 6 — confirmed by counting at `62a5972^`. The plan's
   44 is correct _as of its measurement_ and is left alone; sprint 02 carries
   **45**.
3. **Whether P0e is fully closed.** Half 1 (`4b55da0`) is now known to be
   **smaller than it looked** — the key axis is a **no-op in this repo**,
   because `resolveSession` levels 3 and 5 resolve to the same board. Half 2
   (`d650c97`) landed and is gated structurally. **But the gate is scoped to the
   PEER channel**: `mkdtempSync` at `server.test.ts:803` runs once at _module_
   scope, so `TEST_TMPDIR` is per-**file**, not per-**fixture**. The plan leaves
   **OPEN, unmeasured**: _does any fixture's daemon outlive its test?_ If every
   daemon dies with its test, the question closes. **It was not measured.**
4. **G5's repeal status.** Repealed **per spell**, and only **bounty** is green
   (`d650c97`). `glamour` is **red** (its suite reaches the in-process pointer
   write at `server.ts:405-415`); `imago` and `magpie` are **UNVERIFIED**. **One
   of four. G5 stays for everyone.**
5. **The plan-vs-shipped divergence at `glamour`** (`destroy()` vs `unref()`) —
   see above. The plan text was never reconciled.
6. **Whether the ratify round and the build round are one sprint or two.** They
   share one plan document and one branch, so they are recorded here as one.
   **If the ledger wants them separate, this outcome is the seam** — but the
   frozen plan cannot be split retroactively without editing it.

---

## CARRY-FORWARD → sprint 02

**This is the handoff.** Sprint 02 **restates** each item in its own words with
its own line references. It does not reach back and amend sprint 01.

### Goes into sprint 02 (`02-success-shaped-lies`)

| item                            | what carries                                                                                                                                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **P0b**                         | **The lane is the FLAG SET, not `--restore`.** The early return discards `--timeout`, `--restore` **and** `--title`. D3's refusal names **no** corrective verb. The six-step race-free construction, the `kill -9` PID trap, and the `null`-not-absent envelope hole     |
| **P0c**                         | 6 hand-rolled parsers to convert, 10 already conformant. **Step 2 is what stops `bounty close --help` from CLOSING THE BOARD.** The positional-prose collision, the `--` terminator, the two-population gate report, the recognized-flag artifact, and thoth's held ward |
| **P0d**                         | #83 (`bounty add` discards `applied`) and #84 (the route returns `ok:true` unconditionally — **not** an `await` bug). The rewritten three-cell gate, replacing the inverted control                                                                                      |
| **P0f — the `tail` slice only** | The five `write→exit` pairs, **re-pinned to `7a32677`**. Shape F (the obvious helper) is byte-for-byte the defect. **The rest of P0f stays deferred.**                                                                                                                   |
| **The release beats**           | `SKILL.md` re-read, cold-gate the assembled release, archive closed backlog items, comment the issues — **with the four honest-sentence rulings above**                                                                                                                  |

### Traps that must survive into sprint 02

**A builder reading only sprint 02 must not walk into a trap sprint 01 already
paid for.** These are the ones that still apply:

- **G1–G5**, all five, all active. G1 as **amended** (the explicit
  `--session-key` **is** the isolation; the scrub is not). G5 **not repealed**
  for glamour/imago/magpie.
- **The `bun -e` / `Bun.spawn` pipe boundary** — a gate driven through
  `Bun.spawn({stdout:"pipe"})` **cannot fail** on the drained-exit defect. Use
  the `sh -c "… | cat"` construction verbatim.
- **Assert the process EXITS**, not only that its payload survived. Nothing in
  this repo did, and a 23-minute hang shipped.
- **The vacuity trap** — every _"X is not there"_ needs _"and the thing that
  would have put X there ran."_ It has bitten this project four times.
- **The inverted-control check (G2)** — evaluate every gate's assertion twice:
  once against the buggy world, **once against the world after the intended
  fix.** The second check found the only defective gate of the four.
- **Shape F** — a drain callback covers only its own write. **It is not a
  barrier.**
- **A bulk mechanical edit is where recognition fails.** Per-site preconditions
  are invisible to shape inspection; `join.ts` and `glamour` are both proof.
- **`git status` before every gate.** A gate is uninterpretable in **both**
  directions while a peer has uncommitted work in the tree.
- **Reproduce the reporter's exact spelling, not a reasonable paraphrase.** A
  paraphrase removes the variable under test while looking like the same test.

### Explicitly NOT carried into sprint 02

- **The rest of P0f** — the ~39 other in-function exits, the `die()` family
  rule-outs, and the SIGINT handlers.
- **`bounty/join.ts`'s hang** — `process.exit` there is load-bearing on a live
  WebSocket. **The honest fix is a socket-lifecycle change**, carded separately.
  **Shipping a hang to fix a truncation is a bad trade.**
- **A process-spawning test harness for magpie / imago / glamour** — the reason
  four of nine P0 sites are _verified_ and not _pinned_.
- **P1, P2, P3** — **all still unratified.** Run a ratify round on each before
  building it. **P0's round falsified six things; assume these will too.**
- **The discovery-pointer production defect** — ruled **file, don't fix**. 22
  shipped-source sites; it is the same question as candidate #2 from the other
  end, and belongs with the CLI-contract investigation beside #85–#88.
- **#85–#88 and the structured failure envelope** — the contract investigation
  decides what right looks like.
- **#64** — genuinely unexplained; needs its own investigation, not a lane.

### Left for Cole (not the agent's call)

- **Filing the nine candidate issues** found across both rounds (see the plan's
  candidate tables) — including **`--fresh --restore` destroys a snapshot**,
  which arguably outranks #80.1.
- **Whether `kill -9` may appear in a user-facing refusal message.**
- **`mind-mapper` shipping as inert payload** — pre-release, or fallen out of
  the registry?
- **Cutting the release and pushing.** The agent does not push or release.
