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

⭐ **CORROBORATED n=2, INDEPENDENTLY, AND THE SECOND ARM IS THE DISCRIMINATING
ONE.** The verify seat's own stand-down ~40 minutes earlier returned
`created: false` **with a fresh timestamp** — i.e. a genuinely successful,
first-time write reporting the same value as a no-op. **She had that output in
front of her and did not report it**, which is the field's whole failure mode:
`created: false` reads as _"nothing happened"_ and is therefore not worth
mentioning, exactly when it means _"something did."_

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
