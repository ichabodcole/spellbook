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

## 4. `comms stand-down` returns `created: false` on a SUCCESSFUL update

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

## 5. A departure record is not a claim the pane is inert

Two seats stood down and then deliberately sent again, correctly, citing the
SOP. The teardown guard reads the departure record as _this seat is gone_; the
seat means _this seat announced it was done_. **Both are true simultaneously and
the guard only ever reads the first.**

Related to `s5-7` (departure records are not session-scoped), re-measured
2026-08-10 and still unresolved.

---

## What Cole is being asked

**Nothing yet.** These are drafted for review. **Do not read the ordering as
priority** — items 1 and 2 are praise for mechanisms that worked, items 3–5 are
defects, and item 3 is the only one that cost this session real time. </content>
