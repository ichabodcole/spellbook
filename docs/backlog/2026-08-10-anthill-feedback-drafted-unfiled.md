# anthill feedback — five drafts, measured, DRAFTED AND UNFILED

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

### ⛔ THE MISSING ARM IS BOOKED, NOT TAKEN — and this paragraph is why it survives

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
— it blocks rather than authorises.** `s5-7` is either fixed upstream since it
was filed or was wrong when filed; **that cannot be told from here and is not
being guessed at.**

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

---

## What Cole is being asked

**Nothing yet.** These are drafted for review. **Do not read the ordering as
priority** — items 1 and 2 are praise for mechanisms that worked, items 3–5 are
defects, and item 3 is the only one that cost this session real time. </content>
