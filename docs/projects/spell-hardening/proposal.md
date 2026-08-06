# Spell Hardening — fix what the shipped spells are getting wrong, then release

**Status:** Approved (scope + execution ratified by Cole, 2026-08-05; #80 folded
into P0 and D3 ruled, #81 filed and D4 ruled, 2026-08-06) **Created:**
2026-08-05 **Author:** Cole Reed (triaged with Claude Code)

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
at all. **`bounty` and `grapevine` have no `=` handling whatsoever** — the two
most-used spells — and only `mind-mapper` rejects unknown flags (#81). Found
while triaging #80's `--owner` claim, which turned out not to be the truncation.

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
issue.**

| Phase  | Theme                       | Issues / items                                         |
| ------ | --------------------------- | ------------------------------------------------------ |
| **P0** | Silent wrong data           | #77, #78, #80, #81, #83, #84 (+ audit every spell CLI) |
| **P1** | Daemon lifecycle + data     | #64, #73, #74, `bounty-daemon-robustness-nits`         |
| **P2** | Bounded reads               | #75 + `bounty-tail-drain` (one flag, both spells)      |
| **P3** | Legibility + honest signals | #79, #72, #11, #76, `bounty-heartbeat-skip-blocked`    |

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
- `2026-06-22-bounty-heartbeat-skip-blocked` — **already fully designed and
  approved** (with the dream-flute lead, on the `bounty-heartbeat-design`
  channel). Same family as #76: both are heartbeat false-positives.

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
- **The bypass already exists and is honest.** `--fresh --restore` means "tear
  the live board down, respawn from this snapshot." A refusal that names an
  available corrective verb is not a dead end, and does not need a `--force`
  invented for it.
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
- **The precedent is in-house.** `mind-mapper` is the only spell CLI that
  already rejects unknown flags. Copy it rather than invent a convention.
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
  reported spells.** A first-pass grep finds the same
  `main → process.exit(code)` shape in **seven** files: the two reported, plus
  `astrolabe`, `glamour`, `imago`, `magpie`, and grapevine's `daemon.ts`. Not
  all of them can emit an over-buffer payload, so the phase confirms per site
  rather than patching blind — but the reported count was two and the real
  exposure is larger. Fix the shape, not the call sites.
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
- [ ] No spell CLI retains the undrained `process.exit` shape.
- [ ] **No write verb reports success without confirming the write applied.**
      `bounty add` checks `applied` like its four siblings (#83), and
      glamour/imago/magpie's `/cmd` stops answering `ok:true` before it knows
      (#84).
- [ ] A `--restore` that cannot be honoured never reports success — it is
      visible in the envelope, with a regression test covering the live-board
      attach path.
- [ ] A `close` cannot silently destroy a non-empty snapshot.
- [ ] Every spell CLI honours `--key=value` identically to its space-separated
      form and rejects an unknown flag by name, with read-path, write-path, and
      positional-preservation tests — and no verb taking free prose regressed.
- [ ] **Every gate above was checked with a control that could have failed.** A
      paraphrase of the reported input is not a control; it removes the variable
      under test while looking like the same test. This one is process, not
      product, and it is here because ignoring it cost this project a wrong
      triage on #80.
- [ ] Blocked and session-length cards produce no false pokes; genuinely stalled
      cards still do.
- [ ] `bun run check && bun test` green; cold-gate pass by the verify seat.
- [ ] A release is cut and the spells' `SKILL.md` files are true.

## References

- Backlog (the triage): `docs/backlog/2026-08-05-*.md`,
  `2026-07-16-bounty-daemon-idle-death.md`,
  `2026-07-16-bounty-board-ui-polish.md`
- Fold-ins: `2026-06-15-bounty-tail-drain.md`,
  `2026-06-15-bounty-daemon-robustness-nits.md`,
  `2026-06-22-bounty-heartbeat-skip-blocked.md`
- Issues: #11, #64, #72, #73, #74, #75, #76, #77, #78, #79, #80, #81, #83, #84 —
  and, deferred to the contract investigation, #82, #85, #86, #87, #88
- Code: `plugins/spellbook/skills/{grapevine,bounty}/scripts/`
