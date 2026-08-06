# Spell Hardening — fix what the shipped spells are getting wrong, then release

**Status:** Approved (scope + execution ratified by Cole, 2026-08-05; #80 folded
into P0 and D3 ruled, #81 filed and D4 ruled, 2026-08-06) — **now running as a
MULTI-SPRINT project** (promoted 2026-08-06) **Created:** 2026-08-05 **Author:**
Cole Reed (triaged with Claude Code)

> **This document is the project's LIVING arc.** Where we are is the ledger,
> [`./README.md`](./README.md); what each sprint planned and what it actually
> did lives under [`./sprints/`](./sprints/). Per
> [the projects convention](../README.md#multi-sprint-projects), **a closed
> sprint's `plan.md` is frozen and never edited** — it is the record of what was
> believed at the time. **Only this proposal and the ledger are amended.** So
> when a sprint falsifies the scope, the correction lands here, and it lands as
> a strike-through plus a dated erratum rather than a silent rewrite — the
> original claim is the evidence of what the project once believed.
>
> **Sprint 01 (`01-drained-exit`) is closed** and falsified several claims
> below; each is marked in place. Read
> [its outcome](./sprints/01-drained-exit/outcome.md) before planning anything.

---

## Overview

`bounty` and `grapevine` are the **most-used spells** — every anthill session in
this repo and others leans on them. **Fourteen** GitHub issues are in scope, six
filed on 2026-08-05 alone and two more on 2026-08-06, and the triage that
produced this project found that **seven of them actively mislead rather than
merely annoy**: they return plausible, well-formed, wrong results and exit 0.

This project fixes them in a **harm-ordered sequence** and cuts a release, so
teams already depending on these spells get the benefit immediately rather than
waiting on a feature round.

It is deliberately **not** a feature project. Everything here traces to a filed
issue or an existing backlog item.

## Problem Statement

Grouped by what they cost the people using the spells:

**1. Silent wrong data (correctness).** `grapevine pull` and
`bounty state --full` truncate at exactly 64KiB through a pipe, emit unparseable
JSON, and **exit 0**. Agents always read through a pipe, so this is the normal
path, not an edge case. It cut a real session: a joining agent read a channel as
ending at message #68 when it stood at #116, stamped a verdict on that stale
watermark, and the lead read the watermark as evidence the agent had ignored a
briefing — and broadcast that inference before retracting it. **One silent
truncation produced a wrong verdict and a wrong judgement of a teammate.**

**1b. A recovery command that reports success and does nothing (correctness).**
`bounty open --session-key K --restore <id>` is **accepted, prints normal
discovery JSON, and exits 0 without restoring anything** whenever a live board
already holds the key: `cli.ts:388-397` takes the idempotent-attach branch and
returns, and `--restore` is not appended to the daemon's args until line 415 —
past the return. The flag is never consulted, and nothing says so. A second team
hit this on a board whose snapshot held 97 tasks and whose live board held 0
(#80). **This is the worst possible position for a silent no-op:** it is the
_recovery_ command, reached only after the caller has already accepted something
is wrong with the board — so an empty result is exactly what they are primed to
believe. They recovered only by reading `~/.bounty/snapshots/<id>.json` by hand.

**1c. A flag spelling nobody rejects (correctness, house-wide).** `parseArgs`
splits on whitespace only, so `--owner=forager` registers a flag literally named
`owner=forager` and `flags.owner` stays undefined — the scope filter never runs
and **the entire board prints, exit 0.** The tell is that a _nonexistent_ owner
returns everything too. It corrupts writes the same way: `add --owner=maestro`
returns `{"ok":true}` and stores the task **unowned**. Unknown flags never warn
at all. ~~**`bounty` and `grapevine` have no `=` handling whatsoever** — the two
most-used spells — and only `mind-mapper` rejects unknown flags (#81).~~ Found
while triaging #80's `--owner` claim, which turned out not to be the truncation.

> **⚠ FALSIFIED 2026-08-06 — and the reframing matters more than the numbers.**
> Re-measured during sprint 01 (`thoth`, then corrected by an independent review
> and re-derived); see [the frozen plan](./sprints/01-drained-exit/plan.md),
> Phase 0c, "Blast radius".
>
> **The unit is the arg-parsing ENTRY POINT, not the spell.** There are **16
> entry points across 8 spells.** Ten use `node:util` `parseArgs` with
> `strict: true` and therefore **already** split on `=` natively **and** reject
> unknown flags; **six are hand-rolled** and do neither:
>
> | parser                                  | count  | `=` support      | unknown-flag rejection |
> | --------------------------------------- | ------ | ---------------- | ---------------------- |
> | `node:util` `parseArgs`, `strict: true` | **10** | **YES — native** | **YES — already**      |
> | hand-rolled                             | **6**  | no               | no                     |
>
> So **"bounty has no `=` handling" is false as a spell-level claim** — two of
> bounty's three entry points handle it natively; only `cli.ts` does not. The
> same is true of `imago` and `magpie`, whose "partial" reads as one weak parser
> when it is really one broken hand-rolled parser sitting **beside** an
> already-correct `node:util` one **inside the same spell**.
>
> **This is the correction that matters, because per-spell thinking is what made
> the original triage wrong.** A per-spell checklist marks a spell done while a
> live defect remains in another of its entry points — `glamour/server.ts` is a
> hand-rolled parser in a spell whose `cli.ts` is also being fixed, and it was
> missing from the set entirely until an independent review found it. **Track
> this work by entry point, never by spell.**
>
> **"only `mind-mapper` rejects unknown flags" is false by nine.** It sends a
> builder to `mind-mapper` for a reference implementation when nine closer
> already-conformant entry points exist — see D4 below, where the same sentence
> was corrected.
>
> The `=` defect itself is unchanged and real: `bounty/cli.ts` is one of the
> six.

**2. Data loss during recovery (integrity).** When the bounty daemon dies,
`open --session-key K` respawns an **empty** board under the same id, and
`close` then writes 0 tasks over the good snapshot, unconditionally, with no
rotation. Two independent sessions on different repos hit the identical sequence
months apart. One lost 10 completed-card histories. **The recovery move is what
destroys the data**, which is why it recurs.

**3. Signals that train their audience to ignore them.** The heartbeat pokes
cards that are legitimately blocked or session-length, so a lead receives alerts
he acts on none of and stops reading the channel. An alert that is correct but
meaningless is worse than the gap it was built for.

**4. Answers to questions nobody asked.** `bounty list` enumerates **boards**,
not tasks, and returns a **plausible zero** — indistinguishable from "your cards
don't exist." One caller was a message away from filing a false defect against a
tool that was working perfectly.

## Proposed Solution

Four phases, ordered by **harm first, and by dependency where it forces the
issue** — **P0 has since split into six named lanes; the other three phases are
unchanged in scope and still unratified.**

**As originally written 2026-08-05 — superseded, kept for the record:**

| ~~Phase~~  | ~~Theme~~                       | ~~Issues / items~~                                         |
| ---------- | ------------------------------- | ---------------------------------------------------------- |
| ~~**P0**~~ | ~~Silent wrong data~~           | ~~#77, #78, #80, #81, #83, #84 (+ audit every spell CLI)~~ |
| ~~**P1**~~ | ~~Daemon lifecycle + data~~     | ~~#64, #73, #74, `bounty-daemon-robustness-nits`~~         |
| ~~**P2**~~ | ~~Bounded reads~~               | ~~#75 + `bounty-tail-drain` (one flag, both spells)~~      |
| ~~**P3**~~ | ~~Legibility + honest signals~~ | ~~#79, #72, #11, #76, `bounty-heartbeat-skip-blocked`~~    |

> **⚠ FALSIFIED 2026-08-06 — P0 is not one lane, and "audit every spell CLI"
> under-counted the work by an order of magnitude.** Sprint 01 discovered that
> **P0 carries five named sub-lanes**, one of them (**P0f**) not conceived of
> when this proposal was written; it was split out mid-sprint with a measured
> denominator. Measured and ruled during sprint 01; see
> [the frozen plan](./sprints/01-drained-exit/plan.md), Phase 0f, and
> [the outcome](./sprints/01-drained-exit/outcome.md). The corrected table
> follows.

| Phase   | Theme                                | Issues / items                                          | State                                       |
| ------- | ------------------------------------ | ------------------------------------------------------- | ------------------------------------------- |
| **P0**  | The drained exit — **entry points**  | #77, #78, #80.2                                         | **DONE** (sprint 01)                        |
| **P0e** | The gate destroys the board it gates | (found mid-sprint; no issue)                            | **DONE** (sprint 01, both halves)           |
| **P0b** | The inert `--restore`                | #80.1                                                   | Unbuilt → sprint 02                         |
| **P0c** | The unparsed `--flag=value`          | #81                                                     | Unbuilt → sprint 02                         |
| **P0d** | Writes that report success anyway    | #83, #84                                                | Unbuilt → sprint 02                         |
| **P0f** | The **in-function** exits            | (born mid-sprint; **45**-site denominator at `7a32677`) | `tail` slice → sprint 02; **rest deferred** |
| **P1**  | Daemon lifecycle + data              | #64, #73, #74, `bounty-daemon-robustness-nits`          | **UNRATIFIED**                              |
| **P2**  | Bounded reads                        | #75 + `bounty-tail-drain` (one flag, both spells)       | **UNRATIFIED**                              |
| **P3**  | Legibility + honest signals          | #79, #72, #11, #76                                      | **UNRATIFIED**                              |

**P0f is the lane this proposal missed entirely.** P0's audit enumerated **one
exit per FILE** — the `main()` wrapper — but **the defect's unit is the SITE.**
A source-scanning guard measured **44 remaining `process.exit(` sites** after
the entry-point fixes landed; re-measured at `7a32677` the figure is **45**
(sprint 01's own `62a5972` added one). The highest-harm shape sits inside `tail`
in five spells — write the terminal event, exit on the next line, on a verb that
is _always_ on a pipe and that agents leave running for hours. **Only the `tail`
slice is carried into sprint 02; the rest of P0f is deferred** (see Out of
scope).

**P1, P2 and P3 are UNRATIFIED, and each needs its own ratify round before it is
built.** This is a project-level commitment, discovered in sprint 01 and
recorded here rather than in a frozen plan, because it governs every remaining
sprint. **It is not a formality: P0's ratify round falsified six claims in a
plan written by one author, and an independent cold read then found two more
that four seats checking each other had missed.** Assume P1/P2/P3 will do the
same, and budget a round for each.

**P0 must go first, and not only because it is the worst.** A bounded
`tail --no-follow` (P2) is a command that prints a payload and exits — **exactly
the shape that loses its tail to the P0 bug.** Shipping P2 first would deliver a
brand-new way to silently lose history.

**#80 sits in P0, not beside its neighbours in P1.** Its first half (the inert
`--restore`) is about keyed-board recovery, which _looks_ like P1's territory
next to #73/#74. But P1 is about **destruction**, and this is about **recovery
not working and saying it did** — the P0 defect class exactly. It is also
independent: it needs neither D1's snapshot ruling nor #64's root cause, and its
fix has P0's shape (refuse loudly, or state the skip in the envelope). Its
second half (`bounty state --full` truncating through a pipe) is #78, already P0
— so splitting #80 across phases would separate one report's two halves for no
gain.

**#80 is not covered by D1.3.** Hydrate-by-default fixes the **dead**-daemon
respawn. #80's board was **live and empty**, so hydration never fires and
`--restore` is the only lever there is. The two rulings are complementary, not
overlapping.

**P1's internal order is also forced.** #64 (the daemon dies) is the _trigger_;
#73/#74 (recovery clobbers the snapshot) is the _consequence_. But they are
independently worth fixing — an unguarded clobbering `close` is a loaded footgun
even on a daemon that never dies — so P1 does not block on a complete root-cause
for #64.

## Scope

**In scope.** The fourteen triaged issues (ten at ratification, plus #80 and #81
folded in 2026-08-06, plus #83 and #84 from the envelope audit the same day),
plus three adjacent backlog items that touch the same code and are cheaper to do
in the same pass than to schedule separately:

- `2026-06-15-bounty-tail-drain` — the bounty twin of #75. **Do them together**
  so `--drain` and `--no-follow` don't become two spellings of one idea.
- `2026-06-15-bounty-daemon-robustness-nits` — R1/R2/#3/#4. **#4 in particular**
  (`tail` retries forever on abnormal daemon death) is the "fails silently" half
  of #64's UX and belongs in the same phase.
- ~~`2026-06-22-bounty-heartbeat-skip-blocked` — **already fully designed and
  approved** (with the dream-flute lead, on the `bounty-heartbeat-design`
  channel). Same family as #76: both are heartbeat false-positives.~~

  > **⚠ ALREADY SHIPPED — removed from scope 2026-08-06.** This landed in
  > **`e25a28d` on 2026-06-22**, the same day it was filed, and **GitHub #40 was
  > closed then too.** The predicate is `isBlocked` at
  > `bounty/scripts/server.ts:124`, applied at `:151` (`computeDuePokes`) and
  > `:182` (`cardOverdue`), mirrored in `template.html:719-721`, and documented
  > at `SKILL.md:494-498`. **P3 was over-counted by one whole item**, in both
  > the phase table and this list.
  >
  > **Nothing swept the backlog file, so nothing ever contradicted this
  > paragraph.** The item was fixed deliberately and closed upstream; only the
  > local record stayed open. That is the failure this project is about, run on
  > this project's own scope — **a document asserting work remains, with no
  > mechanism that would ever tell it otherwise.**

**Out of scope.**

- The two 2026-08-05 primitive investigations (context, communication log) —
  research, not release work.
- mind-mapper R13 finalize. Its branch is parked, not abandoned.
- `2026-07-09-bounty-grapevine-skill-review` as a standalone pass — but any
  `SKILL.md` line this project falsifies **must** be corrected as part of the
  change that falsifies it.
- Feature-shaped backlog items: leaderboard, task metrics, sessions filter,
  grapevine rename/edit/presence/facilitation-timer, imago items.
- **#85, #86, #87, #88 — the other envelope defects found by the 2026-08-06
  audit.** Each is "this spell's envelope is wrong," and
  [the CLI-contract investigation](../../investigations/2026-08-06-spell-cli-contract-investigation.md)
  decides what right looks like. **Fixing them before it concludes means fixing
  them twice.** They are filed, verified, and independent — they do not block
  this release and this release does not block them.
- **A structured failure envelope on stdout.** Also the contract's, and see the
  reversal recorded in the plan's Phase 0: it lands in the same function P0
  rewrites, but its shape is known-incomplete, so folding it in would block a
  data-corruption fix on an open investigation.

**Added to out of scope by sprint 01 (2026-08-06).** These were all discovered
while doing the work, and each is deferred deliberately rather than forgotten —
the evidence for each is in
[sprint 01's outcome](./sprints/01-drained-exit/outcome.md), "Explicitly NOT
carried into sprint 02."

- **The rest of P0f** — the ~39 in-function exits beyond the five `tail` sites,
  the `die()` family rule-outs, and the SIGINT handlers. **Only the `tail` slice
  is in scope**, because that is the shape that loses a stream's terminal
  events.
- **`bounty/join.ts`'s socket-lifecycle hang.** `process.exit` there is
  **load-bearing on a live WebSocket** — the natural-return fix hangs. The
  honest fix is a socket-lifecycle change, carded separately. **Shipping a hang
  to fix a truncation is a bad trade**, and sprint 01 shipped exactly that at
  `glamour` before catching it.
- **A process-spawning test harness for `magpie` / `imago` / `glamour`.** Its
  absence is the reason four of nine P0 sites are _verified_ and not _pinned_.
- **The discovery-pointer production defect — ruled `file, don't fix`
  (2026-08-06).** A machine-global `<spell>-latest.json` singleton unscoped by
  `BOUNTY_HOME`, in four spells. The test-side channel was closed; **shipped
  source sites remain — HOW MANY IS UNVERIFIED.** It is the same question as
  candidate #2 from the other end and belongs with the CLI-contract
  investigation beside #85–#88.

  > **⚠ THE COUNT IS UNVERIFIED (noted 2026-08-06). Three measurements disagree:
  > 22 / 19 / 10.** The plan says 22, a cold-read reviewer counted 19, a third
  > grep returned 10. **The spread is almost certainly different denominators**
  > — glob breadth, whether `src/` counts, whether tests are excluded — **not a
  > moving target.** Do not pick one. **Re-measure with the denominator stated**
  > before this number appears anywhere reader-facing; it is release-note-bound,
  > and **this project's own bounded-check rule applies to it: state your scope
  > and your denominator, or the number is not a measurement.**

- **#64's root cause.** Its idle-timeout framing is **dead on arithmetic** —
  both guards landed three weeks before the report, and a ~20-minute death is
  unreachable by any timeout value in the code. **#64 is genuinely unexplained
  and needs its own investigation, not a lane**, and the discovery-pointer fix
  does **not** close it.

## The four decisions — RULED (D1/D2 2026-08-05, D3/D4 2026-08-06)

Everything else here has a known fix. These four did not, and they are why this
is a project rather than fourteen branches. **All four are now ruled. Do not
relitigate; falsify with evidence if you think one is wrong.**

### D1 — Snapshot safety semantics (P1) — RULED

**The governing fact: the audience is agents, not humans.** Every affordance
below is decided on that basis, and it is the reason to reject the options that
read as safer to a human operator.

**D1.1 — Backup-then-write. Not refusal.**

- The clobber happens **during recovery** — an already-degraded path where the
  caller is confused because the daemon just died. A refusal adds a second
  failure on top of a first.
- **Refusals breed `--force`.** Once an agent learns `close` sometimes refuses,
  `--force` enters the runbook and the guard is permanently gone. A guard that
  trains its own bypass is worse than none, because it reads as protection.
- Backup never blocks and is always correct. Snapshots are small JSON; rotation
  (`<session>-<ts>.json`, keep N) makes it cheap.

**D1.2 — It must not succeed quietly, and the announcement is a FIELD IN THE
ENVELOPE, not prose on stderr.** A human reads stderr; an agent reads the parsed
result. Shape:

```jsonc
{
  "ok": true,
  "saved": 0,
  "snapshotBackedUp": {
    "path": "…",
    "taskCount": 9,
    "reason": "wrote 0 over 9",
  },
}
```

**`null` when nothing happened — never absent.** A readable blank distinguishes
"no backup was needed" from "this build doesn't report it"; a missing key
cannot.

_Scar this is built on:_ `anthill commit` has printed `uncheckedAgainst` on
every land, and a team still reconstructed its own race window three separate
ways across three seats. **"The affordance was not missing; it was unnamed, and
nothing pointed at it."** Printing is not enough — see D1.4.

**D1.3 — `open --session-key` hydrates BY DEFAULT and announces it the same
way.** `hydrated: {from, taskCount} | null`, with `--fresh` to opt out.

- The empty-board-under-the-same-id shape is **what made the clobber look
  safe**. Hydrating removes the root confusion rather than guarding its
  consequence.
- **Do not prompt.** A prompt is a human affordance; in an agent path it is a
  hang, not a question.

**D1.4 — The tool is authoritative; `SKILL.md` points at it and stops.**

This follows the house rule already in force — the SOP says of the CLI's
checklist _"that checklist is the single source; don't restate it,"_ and
`seams.md` opens with _"defer to one source — don't restate shared truth."_
Three reasons it matters here specifically:

- **The doc drifts; the runtime message can't.** The 2026-06-18 fresh-agent
  finding caught `mediaforge.md` describing the pre-context-library API and
  contradicting `SKILL.md` _"at exactly the read/write points the task needed."_
  `2026-07-09-bounty-grapevine-skill-review` exists because these docs drift as
  the CLIs evolve.
- **Timing.** A skill doc is read at join, possibly hours before the act. The
  envelope field arrives **at the moment of the act, to the agent performing
  it.**
- **Dispositional beats situational.** "Watch out for snapshot clobbering," read
  at join, requires recognising that _this_ is that situation — the step where
  prose guards fail. A field in the response is mechanical.

**So `SKILL.md` carries the disposition and the field names only** — roughly two
lines: _"snapshot writes are guarded and self-announcing; read
`snapshotBackedUp` and `hydrated` in the envelope."_ **Its job is to make the
agent look at the field, then stop.** Naming the field is the part D1.2's scar
says is missing; restating the semantics is the part that drifts.

### D2 — The heartbeat card model (P3) — RULED: take the big swing

**Alert on evidence, not elapsed time.** #76 (session-length cards) and #40
(blocked cards) are one defect class seen from two directions; ship one model,
not two overlapping fixes.

- **Blocked-ness becomes one evidence input, not a separate skip.** That unifies
  #40 and #76 instead of layering a skip on top of a timer.
- **This makes the nudge problem better, not worse — which is the argument for
  the big swing.** Under blocked-skip the load-bearing requirement was "model
  your waits as block edges or this does nothing," and the team that reported it
  never ran `bounty block`. Evidence-based poking **removes the dependency on
  humans modeling their waits correctly.** The `SKILL.md` nudge shrinks from a
  prerequisite to a hint.
- **Cole: "I'd rather just get it all done and dusted."** Do not split P3 into
  sub-phases. One sequencing constraint only: **the evidence source must exist
  before the poke can consult it** — decide what counts as evidence (commits by
  this owner while holding the card, board mutations, vine activity) first.

**What "evidence" means is the one open sub-question**, and it is the owning
seat's to answer with a proposal to the lead — not a licence to expand scope.

### D3 — Does a skipped `--restore` exit non-zero? (P0) — RULED

Added 2026-08-06 with #80; **ratified by Cole the same day.** D1.2's convention
already settles **half** of this: the skip is announced as a **field in the
envelope**, not stderr prose — `restoreSkipped: {requested, reason} | null`,
present-and-null when nothing was skipped. What D1.2 does not settle is whether
the **exit code** also moves.

**Ruled: yes — non-zero, _and_ the field. Not either/or.** The field is what an
agent parses; the exit code is what a `set -e` wrapper or a Monitor catches. #80
asks for exactly this, in these words: _"we would rather have a non-zero exit or
an explicit field than a friendlier default."_

**The objection to answer is D1.1's — "refusals breed `--force`."** It does not
transfer here, for a reason we can check rather than assert:

- **D1.1 governs `close`** — an involuntary path every session hits. A refusal
  there is on the critical path, so a bypass flag inevitably enters the runbook.
  `open --restore` against a live board is a **deliberate, rare, and
  self-contradictory** request: the caller is naming a snapshot to load _and_ a
  live board already holds the key.
- ~~**The bypass already exists and is honest.** `--fresh --restore` means "tear
  the live board down, respawn from this snapshot." A refusal that names an
  available corrective verb is not a dead end, and does not need a `--force`
  invented for it.~~

  > **⚠ FALSIFIED 2026-08-06, and this is the dangerous kind of stale.**
  > **`--fresh --restore` does not restore — it DELETES the snapshot.** Measured
  > during sprint 01; see [the frozen plan](./sprints/01-drained-exit/plan.md),
  > P0b step 2. The sentence above sat inside a section headed **RULED**, which
  > reads as settled, and it directed a reader to run a destructive verb as the
  > safe corrective.
  >
  > **The ruling that depended on it is therefore unsupported**, not merely
  > mis-worded: "a refusal is fine because an honest bypass exists" fails when
  > the named bypass destroys data. **Whether `open --restore` against a live
  > board should refuse is now an OPEN question** and belongs to the sprint that
  > builds P0b — it must not be inherited as decided.

- **It breaks no routine path — verified, not assumed.** anthill is the
  reporting caller, and it never scripts `--restore`.
  `scripts/anthill/commands/team-convene.ts:73` explicitly declines to (_"We
  cannot restore the snapshot from here (that is spellbook's side of the
  seam)"_) and instead emits `boardShadowWarning`, which tells a human or agent
  to recover deliberately. So `--restore` is only ever reached as an intentional
  act — the case where a non-zero exit is a gift rather than an interruption.

**Why this was ours to decide and not the reporter's.** #80 deliberately
declined to prescribe a fix (_"we are not asking for specific implementations"_)
— which is what a good report does. Handing the design back would invert that,
and the reporter is in any case the party least able to weigh it, since D1's
rulings aren't visible to them.

_Adjacent, out of scope:_ anthill's own comment at `team-convene.ts:100` still
reads _"bounty's `open` is NOT idempotent (always spawns a fresh daemon)"_ —
stale since #69 made keyed open idempotent, and part of why this surprised the
team. Worth reporting to anthill; not this project's to fix.

### D4 — How far does the flag-parsing fix go? (P0) — RULED

Added 2026-08-06 with #81; **ratified by Cole the same day.** #81's immediate
defect is that `--key=value` is unparsed. The decision was whether to stop
there.

**Ruled: both halves. Support `--key=value` _and_ reject unrecognized flags
loudly** (non-zero exit, the offending flag named in the message).

- **`=` support alone fixes one spelling and leaves the class intact.** Every
  other typo — `--ownr`, `--staus` — stays silent, and the failure mode is
  identical: a well-formed answer to a question nobody asked.
- **The precedent is in-house.** ~~`mind-mapper` is the only spell CLI that
  already rejects unknown flags. Copy it rather than invent a convention.~~

  > **⚠ FALSIFIED 2026-08-06.** Measured during sprint 01; see
  > [the frozen plan](./sprints/01-drained-exit/plan.md), Phase 0c, "Blast
  > radius" and its `CORRECTED` block. **Ten of the sixteen entry points already
  > reject unknown flags**, because they use `node:util` `parseArgs` with
  > `strict: true` — proven on the real artifact, not the source:
  >
  > ```
  > $ bun astrolabe/scripts/cli.ts nosuchverb --port=9999
  > astrolabe: Unknown option '--port'. …
  > ```
  >
  > One line proving **both** halves — it split on `=` natively, then rejected
  > the flag. **D4's ruled behaviour already ships in this house, in ten places,
  > today.**
  >
  > **The harm of the struck sentence is not the count, it is the direction it
  > points a builder.** It sends them to `mind-mapper` for a reference
  > implementation when **nine closer ones exist** — including
  > `bounty/server.ts`, `bounty/join.ts` and `magpie/discover.ts`, i.e. inside
  > the very spells being fixed. **The likely correct fix is therefore not "add
  > a registry to the bespoke parser" but "DELETE the bespoke parser"** and
  > adopt `parseArgs({strict: true, options})`, which yields `=` support,
  > unknown-flag rejection **and** the `--` terminator the prose-positional
  > collision needs. The target set is the **six hand-rolled** entry points;
  > **the other ten must not be touched.**

- **It is a deliberate behaviour change**, and that is the point. A caller
  passing a stray flag starts getting an error where it previously got silence.
  This is the same reasoning D3 applied to a skipped `--restore`: **when the
  tool cannot do the thing, say so.**
- **Consistent with D1.1's anti-`--force` rule.** No bypass flag is introduced —
  there is nothing to bypass, because the corrective action is to spell the flag
  correctly.

_Rejected: "reject unknown flags only."_ It would make `--owner=x` fail loudly
rather than work, which is defensible — the `=` form was never documented — but
`glamour`, `imago`, and `magpie` have partial `=` handling today, so callers
exist who use it successfully. Breaking them to punish a spelling is a worse
trade than supporting it.

**Corroborated externally, 2026-08-06.** The reporter landed the same ruling
independently in anthill hours before #81 was filed — `=` split at parse time
plus unknown-flag rejection at **parser altitude**, across 21 commands — for the
positional version of this class. Their two scars transfer and are recorded in
P0c: a per-verb guard reached **1 of 13** leaves, and the first working guard
broke **seven** positional tests. Two houses reaching the same rule from
different defects is the strongest evidence D4 is right that we are going to
get.

## Technical Approach

- **P0's fix is a drained exit, not pagination.** The payloads are already
  complete; only the write is lost. A control in #77 proves it isn't inherent to
  Bun: `anthill comms read` moved 983KB through a pipe intact because its
  success path returns naturally instead of calling `process.exit`.
- **The audit is part of P0, not a follow-up — and it is wider than the two
  reported spells.** ~~A first-pass grep finds the same
  `main → process.exit(code)` shape in **seven** files: the two reported, plus
  `astrolabe`, `glamour`, `imago`, `magpie`, and grapevine's `daemon.ts`. Not
  all of them can emit an over-buffer payload, so the phase confirms per site
  rather than patching blind — but the reported count was two and the real
  exposure is larger. Fix the shape, not the call sites.~~

  > **⚠ FALSIFIED 2026-08-06 — and this is the sentence that taught the wrong
  > unit.** _"Fix the shape, not the call sites"_ is **good advice that hid a
  > bad denominator.** It is correct that the fix is one shape. **It does not
  > follow that the audit's unit is the file** — and the bullet quietly
  > conflated the two, because a shape-level fix _feels_ like it covers a file
  > once you have found that file's `main()`.
  >
  > **Measured consequence:** P0's audit enumerated **one exit per file** — the
  > `main()` wrapper — and after all nine ruled-in entry points were fixed, a
  > source-scanning guard found **45 in-function `process.exit(` sites still
  > standing**, including a `write→exit` pair inside `tail` in five spells.
  > **The defect's unit is the SITE.**
  >
  > The grep was honest and its count of seven files was right; **the question
  > it asked was wrong.** Where the truth now lives:
  > [sprint 01's outcome](./sprints/01-drained-exit/outcome.md) for the
  > enumeration and the number, and **sprint 02 for the `tail` slice** — the
  > rest of P0f is deferred (see Out of scope).

- **Regression tests must pipe.** The bug is invisible at a TTY, so a test that
  doesn't read through a pipe cannot catch it. This applies to P0 and to P2.
- **Surface mirrors stay in lockstep by hand.** Anything touching bounty's
  `server.ts` derivations must mirror into `template.html`'s Alpine copy — a
  known drift risk with no test guarding it.
- **Additive and non-destructive.** No snapshot format break; a new snapshot
  layout must still read an old one.
- **Versioning via release-please conventional commits.** No hand-edited
  versions.

## Risks

- **P1 changes recovery behaviour**, which teams have built habits around. A
  silent restore-on-respawn could surprise someone who expects a clean board —
  D1 must decide this deliberately.
- **The bounty surface mirror drifts silently** (P3 touches it). Mitigation:
  name the mirror in the same commit as the server change.
- **P0's audit may find more than two sites**, widening the phase. That is the
  point; better found here than in another session.
- **Scope creep from the backlog.** The three fold-ins are listed explicitly and
  exhaustively; anything else is a new decision, not an extension.

## Success Criteria

- [ ] All fourteen triaged issues closed or explicitly deferred with a reason.
- [ ] `grapevine pull` and `bounty state --full` return valid, complete JSON
      through a pipe on >64KiB payloads, with a piping regression test each.
- [ ] ~~No spell CLI retains the undrained `process.exit` shape.~~

      > **⚠ FALSIFIED 2026-08-06 — this criterion would certify something
      > false.** Measured in sprint 01: **45 in-function `process.exit(` sites
      > remain at `7a32677`, and they remain BY DESIGN** — the rest of P0f is
      > deferred, and `bounty/join.ts`'s is load-bearing on a live WebSocket.
      > Ticking this box was never reachable. See
      > [the outcome](./sprints/01-drained-exit/outcome.md), §"Planned vs.
      > shipped". Split into the three criteria below.

- [ ] **Entry points: done.** No spell CLI's `main()` wrapper retains the
      undrained `process.exit` shape. **Fixed nine, ruled in eight**
      (`magpie/discover.ts` was patched and then ruled out — its large payload
      goes to a file, not stdout). _Sprint 01._
- [ ] **The `tail` sites: the five `write→exit` pairs** in `bounty`, `magpie`,
      `astrolabe`, `imago` and `glamour` no longer drop the terminal events of a
      stream read through a pipe. _Sprint 02._
- [ ] **The remainder: explicitly deferred, not achieved.** The ~39 other
      in-function exits, the `die()` family, and the SIGINT handlers stay as
      they are, and **the release note must say so** rather than implying the
      shape is gone from the house.
- [ ] **Nothing in this project ships a hang to fix a truncation.** Every
      converted site asserts the process **EXITS**, not merely that its payload
      survived — nothing in this repo asserted that, and a 23-minute hang
      shipped in a released spell's entry verb with the whole suite green.
- [ ] **No write verb reports success without confirming the write applied.**
      `bounty add` checks `applied` like its four siblings (#83), and
      glamour/imago/magpie's `/cmd` stops answering `ok:true` before it knows
      (#84).
- [ ] A `--restore` that cannot be honoured never reports success — it is
      visible in the envelope, with a regression test covering the live-board
      attach path.
- [ ] A `close` cannot silently destroy a non-empty snapshot.
- [ ] ~~Every spell CLI honours `--key=value` identically to its space-separated
      form and rejects an unknown flag by name, with read-path, write-path, and
      positional-preservation tests — and no verb taking free prose regressed.~~

      > **⚠ FALSIFIED 2026-08-06 — this is the weak paraphrase, and sprint 01
      > hoisted it out of P0c's own gate for exactly this reason.** "Honoured
      > identically to its space-separated form" is a **valid-value comparison**:
      > `--owner=forager` returning tasks is _"a control that cannot come out
      > differently, because it removes the variable under test while still
      > looking like the same test."_ It is the same paraphrase that hid this bug
      > for a round while triaging #80. See
      > [the frozen plan](./sprints/01-drained-exit/plan.md), Phase 0c, "Gate —
      > REWRITTEN". Replaced by the discriminating cells below.

- [ ] **`bounty state --owner=<bogus>` returns ZERO tasks.** Today it returns
      **the whole board, exit 0** — which is the tell, because a
      working-but-permissive filter cannot produce that. A **bogus value through
      the `=` form** is the discriminating cell; a valid one is not.
- [ ] **An unrecognized flag does not merely get named — the verb does not
      run.** Lead with the harm: today the flag is silently discarded and **the
      verb executes anyway**, so **`bounty close --help` CLOSES THE BOARD**,
      `state --help` dumps it, and `tail --help` opens the stream and never
      exits. The three verbs that do reject, reject **by accident** — they
      happen to demand a positional. The criterion is a non-zero exit that names
      the flag **and performs nothing.**
- [ ] **The write path and the positionals are gated too.** `add --owner=<name>`
      stores the owner (a read-only gate misses the worse half), and each
      free-prose verb keeps a pinned literal invocation —
      `add write the --draft section`, `message fix the --stdin handler later`.
      **The second fails on today's code**, which makes it the only P0c cell
      that discriminates before the fix as well as after it.
- [ ] **The gate enumerates ENTRY POINTS, not spells, and reports its two
      populations separately** — **6 converted (discriminating) · 10 already
      conformant (regression-only) · 16 total.** A green across all 16 is ~60%
      vacuous and reads as the opposite; "for each spell CLI" would let a
      two-spell fix pass, and a per-spell checklist marks a spell done while
      another of its entry points — `glamour/server.ts` — is still broken.
- [ ] **Every gate above was checked with a control that could have failed.** A
      paraphrase of the reported input is not a control; it removes the variable
      under test while looking like the same test. This one is process, not
      product, and it is here because ignoring it cost this project a wrong
      triage on #80.
- [ ] Blocked and session-length cards produce no false pokes; genuinely stalled
      cards still do.
- [ ] `bun run check && bun test` green; cold-gate pass by the verify seat.
- [ ] A release is cut and the spells' `SKILL.md` files are true.
- [ ] **The release note is honest by these four rules** (ruled in sprint 01;
      standing, because they outlive any one sprint and were re-derived from
      scratch twice). **This project exists because tools returned plausible,
      well-formed, wrong results — a release note that overstates does the same
      thing to a reader who cannot grep. A true claim that reads as an overclaim
      costs the same trust as a false one.**
  1.  **Say WHICH HALF.** _"the entry-point exits are fixed across eight files;
      the streaming verbs' terminal exits are filed as P0f"_ — **not** _"the
      drained exit is fixed."_
  2.  **Distinguish PINNED from VERIFIED.** A **test** prevents regression
      tomorrow; a **drive** proves it today. Of P0's nine sites, **5 are pinned
      by a regression test and 4 by a recorded drive only** (`magpie/cli`,
      `imago`, `glamour` — no process-spawning harness exists in those suites).
      _"9 of 9 gated"_ asserts the first while delivering the second.
  3.  **Say CONVERTED vs ALREADY CONFORMANT.** For P0c: **6 converted · 10
      already conformant · 16 total.** _"Unknown-flag rejection now works across
      the house"_ claims we built something that mostly already existed, and
      **reads as false to anyone who greps.**
  4.  **Name what a fix does NOT reach.** The discovery-pointer fix closed the
      **test-side** channel; **shipped-source sites remain** — the count is
      **UNVERIFIED (22 / 19 / 10 across three measurements; re-measure with the
      denominator stated)** — and seats run the **cached** plugin copy, so an
      in-repo fix does not touch already-running daemons. **A rule about honest
      counting is not allowed to carry an unverified count.**

- [ ] **The nine candidate issues are handed to Cole, not lost.** See below.

## Candidate issues found during sprint 01 — for Cole to file

**None of these are in the fourteen; none are fixed by this project.** They are
carried here because **filing is Cole's call** and sprint 01's plan is now
frozen — left there they would die with it. **The evidence for each is in the
frozen plan's candidate tables**
([ratify round](./sprints/01-drained-exit/plan.md), §"Candidate issues found
during the ratify round"; build round in the section immediately below it).
Every one was found by using the shipped spells on ourselves.

| #   | one-line summary                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Any process carrying `BOUNTY_SESSION_KEY` can seize a live keyed board**, and the read site gives no signal — a seat's write landed on a stranger board.          |
| 2   | **A bounty read cannot identify which board answered it** — no session id, key or port anywhere in the `state` envelope. This is what made #1 undetectable.         |
| 3   | **A `tail` that cannot attach retries forever** and says so only on stderr, which the shipped `grep` filter swallows — a wire attached to nothing looks quiet.      |
| 4   | **A performed `--restore` is as unannounced as a skipped one.** Whether `restoreSkipped` needs a positive twin is a contract question — do not mint a name.         |
| 5   | **`close --help` CLOSES THE BOARD.** `--help` is unrecognized, discarded, and the verb runs anyway. P0c fixes the destructive half by construction.                 |
| 6   | **The discovery pointer is a machine-global singleton** in four spells, cleaned up on graceful exit only — 2206 stale files, oldest 11 days. Proven causally.       |
| 7   | **`bounty message` answers `{"ok":true,"sent":"message"}` and leaves no durable trace** — alone among the write paths. Same family as #83/#84.                      |
| 8   | **`bounty tail` replays its entire event history** with no default anchor.                                                                                          |
| 9   | **`mind-mapper` ships as inert payload** — 58 tracked files, no `SKILL.md`, absent from the trigger registry, yet inside the shipped subtree. Pre-release or drift? |

**Items 1, 2, 4 and 6 belong beside #85–#88 with the
[CLI-contract investigation](../../investigations/2026-08-06-spell-cli-contract-investigation.md).**
**Item 5's harm statement belongs in #81.** **⚠ #64 is NOT on this list and must
not be closed by item 6.**

_Also left for Cole:_ whether `--fresh --restore` destroying a snapshot should
be filed as its own issue (**it arguably outranks #80.1**); whether `kill -9`
may appear in a user-facing refusal message; and cutting the release — **the
agent does not push or release.**

## References

- Backlog (the triage): `docs/backlog/2026-08-05-*.md`,
  `2026-07-16-bounty-daemon-idle-death.md`,
  `2026-07-16-bounty-board-ui-polish.md`
- Fold-ins: `2026-06-15-bounty-tail-drain.md`,
  `2026-06-15-bounty-daemon-robustness-nits.md`
  (~~`2026-06-22-bounty-heartbeat-skip-blocked.md` — **shipped `e25a28d`, #40
  closed 2026-06-22; out of scope**~~)
- Issues: #11, #64, #72, #73, #74, #75, #76, #77, #78, #79, #80, #81, #83, #84 —
  and, deferred to the contract investigation, #82, #85, #86, #87, #88
- Code: `plugins/spellbook/skills/{grapevine,bounty}/scripts/`
