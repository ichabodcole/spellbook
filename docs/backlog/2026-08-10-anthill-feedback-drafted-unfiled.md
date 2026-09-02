# anthill feedback — six drafts, measured, DRAFTED AND UNFILED

**Filed:** 2026-08-10 · **Source:** spell-hardening sprint 05 finalize, step 5
(aggregate the team's upstream feedback) · **Status:** ⛔ **NOT SENT — filing to
another project is outward-facing and is Cole's call**

> **Why this is a file and not a wire message.** Every item below was measured
> on a channel that is never re-read and gitignored. `prospero.md` already
> records _"six anthill feedback drafts composed and UNFILED, awaiting Cole"_
> from a previous sprint — **so the drafts survive and the observation does not,
> which is [the unclosed unit](./2026-08-10-the-unclosed-unit.md).** Deduped per
> seat, one issue per mechanism rather than one per seat who hit it.

## 1. ⭐ `--as-of` is the only mechanism that never needed anyone to remember it

**Measured across three seats in one session:**

```
prospero   9+ of 13 sends refused
circe       6 of 11
thoth       4
cassandra   1 of 1
           -------
           10+ of ~16, and NOT ONE was noise
```

Every refused draft was **materially wrong, not merely late** — one about to
hand a seat a number the sender's own seat doc flags as unmeasured; one
publishing a "two-seat unanimity" that was a 2-1 split; one calling a card
"fixed" while it carried an over-read.

**The contrast is the point.** Everything else that worked this session — a
ward's green no-op, a `.ts` filter's blind axis, an mtime staleness check, a
gate's 16 unreadable files — **required a human to go looking.** This one fires
whether or not anyone is paying attention.

**⚠ And its honest limit, found at the very end:** it guarantees you have
**READ** the crossing message. It cannot guarantee your **DRAFT ACCOUNTS FOR
IT.** A send went out carrying a sentence its own `--as-of` value had already
falsified. The gap is between reading and revising, and nothing observes that
step.

## 2. `uncheckedAgainst` names the in-flight set, unasked

Printed on **every** land this session, naming exactly the paths the committer's
gate could not vouch for — a peer's uncommitted module, a deliberate mutation, a
seat doc mid-write. **Three seats have reconstructed that state by hand in past
sprints; nobody did tonight.**

It also silently refuted a false claim: _"untracked files are invisible to
`uncheckedAgainst`"_ was published by two seats independently and is wrong — a
land envelope three hours older already listed an untracked directory.

## 3. ⛔ `BOUNTY_HOME` is not isolation when a daemon is running

**The env var picks a store for a COLD START. A running daemon outranks it** —
the CLI talks to the live daemon and the "isolated" home is never consulted.

**Two seats hit this in one night, independently, both careful, both reporting
clean.** One wrote two probe cards to the live team board; the other retitled
it. **The second happened before the first was written up.**

**The generalised discriminator** (worth more than the bug):

> **Is the daemon's DISCOVERY POINTER inside the directory the env var
> relocates?** If YES it isolates. If NO it relocates your DATA and leaves your
> DAEMON shared.

```
astrolabe · grapevine · mind-mapper    pointer inside the relocated dir   ISOLATES
bounty · imago · magpie                pointer in tmpdir()                DOES NOT
glamour                                NO ENV VAR AT ALL                  CANNOT
```

**4 of 7 do not isolate**, and `glamour/scripts/cli.ts` has **zero**
`process.env` references — a seat trying to isolate it has nothing to set and no
way to discover that except by reading source.

## 4. `comms stand-down`'s `created` field is dead on arrival for any established team

> **⛔ CONVERGED. Four layers, three measured, one booked. This section was
> rewritten after the seats took it apart — the original framing ("the field is
> ambiguous") was the weakest of the four.**

```
1 PERSISTENCE     departure records outlive their session       OBSERVED  (prospero 66h, thoth 48h, live)
2 REPORTING       `created:false` on a FRESH write, n=3         OBSERVED  (circe, cassandra, daedalus)
3 REPORTING       `created:false` on a genuine 48h UPDATE       BOOKED    (thoth, at teardown)
4 REACHABILITY    `created:true` is UNREACHABLE for this team   OBSERVED  (5/5 handles hold a record)
```

### ⭐ Layer 4 is why this is worth fixing rather than documenting

`created:true` is **not** degenerate by design — it is a real return, on a
seat's **first-ever** stand-down. daedalus went looking for the input that would
produce it:

```
roster handles              cassandra · circe · daedalus · prospero · thoth
already hold a record       cassandra · circe · daedalus · prospero · thoth
seats that could return true    NONE
```

Identity is roster-resolved, so **no caller on this team can ever again produce
`created: true`.** The field's informative value is consumed **exactly once per
seat, ever**, and for this team all five of those events are in the past.

> **A field whose informative value is consumed on first use and never returns
> is worse than a constant one** — early in a project's life it demonstrably
> works, so nobody revisits it, and it decays into a permanent `false` while
> still being printed as though it meant something.

> ⛔ **RESIDUE OF THE WITHDRAWN CLAIM, CAUGHT ON A RE-READ OF THIS FILE.** This
> paragraph originally ended _"exactly as the team starts depending on the
> teardown guard it feeds."_ **`created` does not feed the guard.** The guard
> reads `record.at` against `sessionOpenedAt` (`comms.ts:724`) and never looks
> at `created` at all.
>
> **So the surviving section had inherited the dead claim's consequence** — the
> measurement was fine and the sentence explaining why it MATTERED was carrying
> the falsified inference. **Withdrawing §5 did not automatically clean §4, and
> nothing would have flagged it**: it reads as ordinary motivating prose.
>
> **The honest scope of §4 is now smaller and stands on its own:** a reported
> field that no established team can ever see take its informative value. It is
> an ergonomic defect in what the CLI tells its caller. **It is not a safety
> issue and this file no longer implies one.**

**You cannot tell a team "watch for `created: true`" when no team past its first
session can ever see it.**

## 4a. The original observation, kept because it is layer 2

A caller cannot distinguish **"I recorded your departure"** from **"you had
already stood down"** without reading the timestamp.

**That is this project's entire thesis** — _a consumer must be able to tell
"nothing is there" from "I cannot tell you"_ — **occurring in the verb every
session ends on.** Found by the surface seat while standing down.

⭐ **CORROBORATED n=3, INDEPENDENTLY** — surface, verify and engine seats, three
separate runs, all returning `created: false` on a write that **demonstrably
happened**:

```
circe      created:false   fresh ts, prior record 46h old
cassandra  created:false   fresh ts, ~40 min before the finding was reported
daedalus   created:false   16-second-old record, and he had NEVER stood down this session
```

**The verify seat had that output in front of her and did not report it** —
which is the field's own failure mode operating on its observer:
`created: false` reads as _"nothing happened"_ and is therefore not worth
mentioning, **exactly when it means "something did."**

> ⛔ **NARROWING — the headline claim rests on ONE OBSERVED ARM, and circe
> caught that before this file reached anyone.** All three runs are
> `created: false` on a **fresh/successful** write. **Nobody observed the other
> arm** — a caller who had genuinely already stood down. So what is MEASURED is:
> _a successful write reports `created: false`._ What is **INFERRED** is: _a
> no-op reports the same, therefore they are indistinguishable._
>
> **TAKEN ON REPORT, not verified here.** The indistinguishability claim is the
> stronger and less supported half, and it is the half an upstream reader would
> act on. **State it as one arm plus an inference, or measure the second arm
> first** — it is one command.

### ✅ THE MISSING ARM IS TAKEN — by the LEAD's own stand-down, at teardown

**The stale arm is measured. All four layers are now observed.**

```
$ anthill comms stand-down --as prospero
  {"handle":"prospero","created":false}          <- reported as though nothing happened

prospero.json  BEFORE   Aug  8 02:05     <- 67 HOURS OLD, from sprint 04
prospero.json  AFTER    Aug 10 21:18     <- genuinely REPLACED, this session
```

⛔ **`created: false` on a write that replaced a 67-hour-old record.** Literally
true about _creation_ — nothing was created, a row was updated — **and useless,
because the caller cannot distinguish it from _"you had already stood down."_**
That is exactly the case three seats had to label TAKEN ON REPORT, and it was
supplied by the one remaining handle with a stale record: the lead's.

```
1 PERSISTENCE     records outlive their session                OBSERVED
2 REPORTING       created:false on a FRESH write, n=3          OBSERVED
3 REPORTING       created:false on a genuine 67h UPDATE        ✅ OBSERVED (prospero, teardown)
4 REACHABILITY    created:true unreachable for this team       OBSERVED
```

**The indistinguishability claim is no longer an inference.** Both arms are
measured: a successful fresh write and a successful stale update return the same
value, and nothing in the envelope separates them from a no-op.

> **The booking mechanism worked and is worth keeping.** `thoth` declined to run
> the verb early to harvest the measurement — the side effect _is_ the point of
> a departure verb — and booked it instead, in a message rather than his
> scratch, **explicitly so its absence would be readable if teardown came
> first.** It did not come first. The arm arrived from a handle nobody had
> considered.

---

### The original booking, kept because the reasoning is the transferable part

**`thoth` holds a 47.8-hour-old departure record from sprint 04** and is
therefore the only seat positioned to test the stale half:

```
cassandra.json  Aug 10 19:59   this session   \
circe.json      Aug 10 20:00   this session    |  fresh BY CONSTRUCTION —
daedalus.json   Aug 10 20:02   this session   /   they had already stood down tonight
prospero.json   Aug  8 02:05                      (the lead — has not run the verb)
thoth.json      Aug  8 20:13   SPRINT 04    <-  age 47.8h — THE STALE ARM
```

**The population able to test the stale arm was exactly the two seats who had
not yet run the verb**, which is why no amount of care from the other three
could have produced it.

**He declined to run `stand-down` early to harvest it**, and the reasoning is
the one this session paid for repeatedly: **a departure verb has a side effect
on shared state, and the side effect is the entire point of it.** Running it for
a measurement is the _"isolated write that wasn't isolated"_ shape three seats
hit tonight.

**So the arm is BOOKED.** When teardown is called, he posts the raw envelope
plus before/after timestamps and this item gets its fourth arm — the one where
`created: false` would be **literally true about creation** and still useless,
because the caller cannot tell it from _"you had already stood down."_

⚠ **RECORDED HERE BECAUSE A BOOKED MEASUREMENT THAT LIVES IN ONE AGENT'S HEAD IS
INDISTINGUISHABLE FROM ONE NOBODY THOUGHT OF.** He said so himself and sent a
message rather than a scratch note; scratch is gitignored. **If teardown happens
and no fourth arm is posted, that absence is now readable from this file** —
which is the only reason it is not lost by default.

## 5. ⛔ WITHDRAWN — "the teardown guard is fooled by stale departure records" IS FALSE

**This section originally claimed the guard treats a previous session's
departure record as a departure, and cited `s5-7`. Measured against the
installed anthill (2.3.0), from source: it does not.**

```
comms.ts:717   if (sessionOpenedAt === null) return false;
comms.ts:724   return typeof record?.at === "number" && record.at >= sessionOpenedAt;
```

Computed against this team's live files at this session's `openedAt`:

```
prospero   66h-old record   hasDeparted = FALSE   <- correctly EXCLUDED
thoth      48h-old record   hasDeparted = FALSE   <- correctly EXCLUDED
cassandra / circe / daedalus  this session       hasDeparted = TRUE
```

**The stale rows are correctly excluded, and the un-scopeable case fails CLOSED
— it blocks rather than authorises.**

> ✅ **RESOLVED — this file previously said "either fixed upstream or wrong when
> filed; that cannot be told from here." IT COULD BE TOLD, IT TOOK TWO
> COMMANDS**, and the answer is decisive:
>
> ```
> 1.10.0   SESSION-SCOPED     (record.at >= sessionOpenedAt)
> 2.0.0    SESSION-SCOPED
> 2.2.0    SESSION-SCOPED
> 2.3.0    SESSION-SCOPED     <- what we run
> ```
>
> **The scoping is in every version on this machine, back to 1.10.0. It was
> never absent, so it was never fixed. `s5-7` was FALSE WHEN FILED**, against
> the version the team was running at the time.
>
> **Its remedy is a RETRACTION, not a fix — and the retraction should say why:
> the claim was never run.**
>
> ⚠ **One more inference dies with it:** that stale records are why `--force`
> normalises at teardown. **If `--force` is in fact reached for routinely, the
> cause is unmeasured** — which is now an open question rather than an answered
> one, and a better one.

### What survived and what died

```
1 PERSISTENCE    records outlive their session               STILL TRUE (the files are there)
2 REPORTING      created:false on a fresh write, n=3         STILL TRUE
4 REACHABILITY   created:true unreachable for this team      STILL TRUE
--
THE INFERENCE    1 + 2 therefore the guard is fooled         ⛔ FALSE
```

**The three measurements survive. What died is the CONSEQUENCE all of us hung on
them — and it was the only part that made the finding urgent.**

What remains is genuine and much smaller: **`created` carries no information for
an established team** (§4). That is worth filing. _"The teardown guard is fooled
by stale records"_ is not, because it is false.

⚠ **This is the whole reason the batch was drafted and not sent.** A measured
persistence fact plus a measured reporting fact produced a confident consequence
that four seats accepted, and **the consequence was never measured by anyone.**
It would have gone upstream as a defect report against working code.

## 6. ⛔ anthill's own test suite leaks a REAL bounty daemon into the user's REAL `~/.bounty`, once per run

**Found at teardown, on `ward`'s "confirm no zombie processes" step. Reproduced
before it was written up.**

`scripts/anthill/commands/team-support.boardbinding.test.ts` closes with a
round-trip test that spawns a **real** `anthill convene` against the **installed
spellbook**, deliberately — the comment says so, and the reasoning is sound: a
green CI without spellbook installed is not evidence the derived-id round trip
holds. **The test is right. Its cleanup is not.**

```ts
afterAll(() => rmSync(ROOT, { recursive: true, force: true })); // the tmpdir
```

`convene` spawns a **detached** bounty daemon (`--no-open`, reparented to init).
`rmSync` removes the fixture directory and **the daemon is not in it.** Nothing
closes the board.

### Measured on this machine, at 04:23 UTC

```
live k-myproject-* daemons     31        ages 72s → 2h00m, ppid 1
leaked snapshots               73        ~/.bounty/snapshots/, every one {"tasks":[]}
```

`myproject` is **this test's fixture channel** and appears nowhere else on the
machine. The source repo is `~/Projects/dreamwood/anthill`, branch
`fix/config-resolver-hygiene`, actively being worked today.

### The reproduction — one run, one daemon

```
before   30 daemons
$ bun test scripts/anthill/commands/team-support.boardbinding.test.ts
         4 pass  0 fail  [215.00ms]
after    31 daemons

daemon.log: {"session_id":"k-myproject-0cea1f8c","pid":188,"reason":"ready",…}
```

**The suite passes. That is the problem** — the leak is invisible to the gate
that would catch it, because a leaked process is not a failed assertion.

### ⭐ Why it is bounded, and why that is the least reassuring part

`server.ts:616` — `timeout` defaults to **7200s**. Every leaked daemon
self-closes after two hours idle, which is exactly why no live one was older
than `02:00:09`. **So the ceiling is "however many test runs fit in two
hours"**, and today that was ~30 concurrent processes from ~73 runs.

**The idle-close is the only thing standing between this and unbounded
accumulation** — and it is the mechanism spellbook issue **#64** exists to
question. **This is NOT evidence for #64** (an idle daemon closing at its idle
timeout is the feature working); it is a reason #64 will be hard to debug, since
a machine carrying 30 stranger daemons is a noisy place to reproduce an unwanted
idle death.

### And the cleanup writes MORE state than it removes

Killing the 31 leaked daemons produced **31 additional snapshots** — flush-on-
shutdown, working as designed. `73 → 104`, all empty boards. **A leak whose
cleanup step grows the artifact it leaks** is worth naming on its own: anyone
reaping these by hand and then counting will conclude they failed.

### The fix is anthill's, and it is small

Close the board in `afterAll` (the id is in the `.bounty-session` the test
**already reads and asserts on** — nothing new needs discovering), or spawn it
with a short `--timeout`. Either removes the leak without weakening the round
trip, which is the part worth protecting.

**⚠ There is a spellbook-side question too, and it is ours:** a caller who
strands a board has **no reap verb**. `list` shows live boards and `close` acts
on one resolved session; there is nothing that says _"close every board matching
this key prefix."_ grapevine grew exactly that verb (`reap`) in V1.8. **Cleaning
this up took `pgrep | xargs kill` and a `rm` glob** — two operations outside the
spell, on the spell's own state. Filed here rather than as a separate item
because it was found from the same evidence; **it is a spellbook backlog
candidate, not anthill feedback.**

---

## What Cole is being asked

**Nothing yet.** These are drafted for review. **Do not read the ordering as
priority** — items 1 and 2 are praise for mechanisms that worked, items 3–6 are
defects, and item 3 is the only one that cost this session real time.

**Item 6 is the exception to "nothing yet": its cleanup was already performed**
— 31 daemons killed, 104 empty snapshots removed, with Cole's explicit
authorisation that no other team was using a board. **The defect itself is
untouched and will re-leak on the next `bun test` in the anthill repo.**
</content>
