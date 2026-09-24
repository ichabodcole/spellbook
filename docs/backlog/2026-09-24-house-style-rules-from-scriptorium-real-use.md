---
type: backlog
title: "House-style rules proposed by the Scriptorium real-use cycle"
description:
  Four candidate rules for grimoire/house-style.md that the Scriptorium real-use
  cycle earned (one state, what a number is for, a reference names its referent,
  a wait that wakes by ending must end), each with its incidents, proposed
  wording and section, for Cole to rule on
tags: [house-style, grimoire, canon, proposal]
status: draft
lifecycle: open
generated: { by: claude-opus-5.5, at: 2026-09-24 }
---

# House-style rules proposed by the Scriptorium real-use cycle

**Owner:** Cole. `grimoire/house-style.md` is his, so this item proposes rules
and does not edit the file. **Filed at the close of**
[Scriptorium from real use](../cycles/2026-09-scriptorium-real-use.md), whose
sessions said these rules were worth proposing and left the proposal to the
cycle's wrap.

**Why a backlog item.** The repo has no convention for proposing a house-style
change. Earlier rules were written into the file during the work that earned
them, and nothing in `docs/projects/`, `docs/backlog/` or `docs/briefs/`
proposes one. This item is the proposal. If Cole wants a standing convention,
that is a separate ruling.

Every rule below uses the file's own shape: an imperative, its boundary checks,
a repeal criterion and a scar. Each one was checked against the current file for
an existing rule that already says it. Where one comes close, the entry names it
and says what the proposal adds.

**What landing any of these costs, besides the prose.** A new `###` or `####`
heading needs a `<!-- rule-id: … -->` line (`grimoire/rule-id.test.ts` fails
without one) and a row in `grimoire/decay-ledger.md`
(`scripts/instruments/canon-ledger-ward.ts` pairs the two). A sharpened boundary
check needs neither, and the rule's ledger row gets its reinforcement date
bumped.

## 1. One state, one meaning

**The rule:** a shared fact gets one piece of state, mirrored to the daemon, and
every view of it derives from that state. A second local flag that can disagree
with it is the defect.

**Incidents:**

- **The chip's `dropped` flag** (branch 1). `ChatComposer` held a flag that hid
  the selection, reset only on send, so after one dismissal every later
  selection stayed hidden and the daemon was never told. `MarkdownView` also
  kept its own memory of the last range it resolved, so re-selecting the same
  passage reported nothing. Cole ruled that clearing the chip clears the
  selection, because one state means "less juggling for the human and the
  agent".
  [Session](../projects/scriptorium/sessions/2026-09-22-the-chip-and-the-lines-it-pointed-at.md#the-ruling),
  [memory](../memories/2026-09-22-scriptorium-selection-and-the-chip.md).
- **Applied on purpose in branch 3.** A collapsed column is a width of 0 in the
  layout pref, not a flag beside it. Reader mode is derived from the view and
  the columns, and there is no reader flag. The composer's draft is one state
  wherever the composer is drawn.
  [Session](../projects/scriptorium/sessions/2026-09-22-room-to-read-and-the-width-the-anchors-forgot.md#what-was-built).
- **Applied again in the chip-across-documents fix.** One rule,
  `selectionOnScreen`, is read by both the surface and the daemon.
  [Session](../projects/scriptorium/sessions/2026-09-22-a-selection-that-outlived-its-document.md#the-fix).

**Section:** _The shape of a spell_, directly after _A spell is a shared
workspace_.

**Overlap check.** Two rules come close, and neither says this. _Drive a
conjuration through a daemon_ says where canonical state lives. It does not
forbid a second copy in the surface. _The other party's channel carries the fact
at all_ asks whether each party can obtain a fact. Two states can pass that test
and still disagree: a reader-mode flag beside a derived mode breaks nothing that
parity checks. And parity can fail with only one state: bounty's
`restoreSkipped` has one state that the human surface never renders. So the
proposed rule is a sibling, not a restatement.

**Proposed wording:**

```markdown
### A shared fact gets one state; everything that shows it reads that state.

<!-- rule-id: shared-fact-one-state -->

A fact both parties act on (the selection, a column's width, a draft) is held in
exactly one place: the daemon's copy, when the agent reads it. Every view of it
(a chip, a badge, a mode) is derived from that place. A second flag that hides,
dismisses or remembers the fact locally can disagree with it, and when it does,
the human sees one thing while the agent acts on another.

- **Boundary check:** a **command** is not a second state. A clear signal that
  carries nothing about _what_ was selected cannot disagree with the selection
  it accompanies. Test a candidate by asking whether it could ever say something
  the one state does not. How to _draw_ a fact (hover, focus, an open menu) is
  not the fact, and is out of scope. Where a library already holds the fact (a
  collapsed panel is a width of 0), use its state. Do not add a flag beside it.
- **Repeal when:** the surface renders the daemon's state with no local copy at
  all, by construction, so a second state cannot be written.

_Scar: Scriptorium's chip kept a `dropped` flag the selection did not. After one
dismissal, every later selection stayed hidden, and the daemon, whose held
selection `say` attaches, was never told the passage had gone. Fixed on
`fix/scriptorium-selection-context`: clearing the chip clears the selection, in
both panes and in the daemon. The rule stands._
```

## 2. Ask what a number is for before writing it into a document

**The rule:** before putting a number in a document, ask who will act on it. A
number that earns its place carries its method, its population and its limit. A
tally of the moment gets deleted, not reconciled.

**Incidents:** three numbers in branch 2 did not survive re-measurement. "Within
one source line" came from a probe that flattered it. A headline population of
42 sat over detail figures out of 37. And an anchor count could not be checked
without instrumenting the code. Every blocking item from the reviewer of record
was a prose claim, not behaviour. Cole's words, quoted in
[the session](../projects/scriptorium/sessions/2026-09-22-keeping-your-place-and-the-guard-that-guesses.md#the-rule-that-came-out-of-it-and-it-is-not-scriptoriums)
and logged in E63:

> What is the purpose of adding this number? Who is it for? What are they
> actually going to do with it? Is it actionable, or is it just information?

The branch applied it: the accuracy figures stayed with their purpose stated,
and "the document has 28 headings" went. The cycle's own Outcome was written
under it.

**Section:** _Authoring — the governing rule_, after _Context is an attention
budget_. The two are the same kind of rule: that one says an exclusion must earn
its place, and this one says a number must.

**Overlap check.** The file's closest text is the denominator clause and
_publish the datum your failure mode cannot fake_, both under _Enumerate the
roster by behaviour_. Those say **how** to publish a measurement so that it
can't mislead. This rule comes first and asks **whether** to publish it at all.
It fills a gap and is not a duplicate. The wording points at those clauses
rather than repeating them.

⚠ **A question of scope for Cole.** `house-style.md` governs spell craft. This
rule governs every document in the repo, spell artifacts included. The
_Authoring_ section already speaks to "the artifact" in general, which is why it
is proposed there. If Cole would rather house-style stay about spells, the other
home is `AGENTS.md`. `docs/SCHEMA.md` is not an option, because it ships
verbatim in the scaffold.

**Proposed wording:**

```markdown
### Ask what a number is for before you write it down.

<!-- rule-id: ask-what-number-is-for -->

> What is the purpose of adding this number? Who is it for? What are they
> actually going to do with it? Is it actionable, or is it just information? —
> Cole

A number earns its place when someone will act on it: a bar a design is held to,
a threshold a check reads, a baseline a later measurement will be compared
against. Then it carries its **method, its population and its limit**. A tally
of the moment (how many headings, runs or files there are today) goes stale
without anyone noticing, and nobody acts on it. The fix for one is to **delete
it**, not to reconcile it.

- **Boundary check:** ask "who acts on this?" **before** "is it right?".
  Checking a number nobody needs is wasted work, and a wrong one is only noticed
  once someone has already acted on it. Once a number has earned its place, the
  denominator clauses under _Enumerate the roster by behaviour_ say how to
  publish it. A number in a scar can earn its place as evidence of how bad the
  failure was. The test is still whether a reader decides something by it.
- **Repeal when:** documents quote their numbers from a live measurement at read
  time, so a stale one cannot be written down.

_Scar: one branch of Scriptorium's keep-your-place work published three numbers
that failed re-measurement: an accuracy bar from a probe that flattered it, a
headline population that disagreed with its own detail figures, and a count
nobody could verify. Every blocking item from the reviewer was a claim like
these, not code._
```

## 3. A place in a document names its document

**The rule:** a value that names a place in something (an offset, a range, a
line, a cursor into a log) carries which thing it names and which version of it.
The check happens where the value is read.

**Incidents:**

- **The chip across documents.** The held selection was offsets and lines with
  no document. The effect that told the daemon stamped it with whichever
  document was open. After a switch, the chip read `beta.md · line 5` over
  alpha's words, and a `say` would have sent it. The verifier then found
  `reveal`, a second value with the same flaw.
  [Session](../projects/scriptorium/sessions/2026-09-22-a-selection-that-outlived-its-document.md),
  [memory](../memories/2026-09-22-a-place-in-a-document-names-its-document.md).
- **The tail's bookmark, house-wide.** `--since N` is a cursor into one event
  log. After a daemon restart, an old bookmark at or below the new log's length
  made the daemon skip the new log's start, and a human message at new id 2 was
  lost without notice. The fix is `--since N@<epoch>`, a cursor that names its
  log.
  [Session](../projects/scriptorium/sessions/2026-09-23-the-tail-hands-off-before-the-cap.md#review).

Two incidents in two different subsystems, the Scriptorium surface and the kit's
wire, are what make this a house rule rather than a Scriptorium one.

**Section:** a fourth `####` clause under _Carry the frame, not just the value_.
That family says its name is "how you recognise a fourth one", and this is a
value that lost its frame.

**Sibling test,** as the family's boundary check requires: construct the case
where an existing clause holds and this one fails.

- _A response states its conditions_ can hold here. The chip bug was not in any
  response: the selection was a held value, applied later.
- _The other party's channel carries the fact_ can hold too. The chip and the
  daemon showed the same fact, equally wrong.
- _A noun carries its class_ does not apply at all.

So this is a sibling with its own mechanism: a reference resolved against
ambient context at the point of use.

**Proposed wording:**

```markdown
#### A reference names what it refers into.

<!-- rule-id: carry-frame-just-value.reference-names-what-refers -->

A value that names a place in something (an offset, a range, a line, a cursor
into a log) carries **which** thing it names, and which version. Resolve it
against "whatever is open now" and one day it will be applied to something else.
It will apply cleanly, too: the offsets are valid, and the text is wrong.

- **Boundary check:** check it **where it is read**, not where the thing
  changes. The thing changes from many places, and a check at each one is the
  check the next path forgets. A request to act on a place is **one-shot**. If
  it is held for "the right moment", it replays at a moment nobody chose. A
  value that lives and dies inside one immutable thing needs no label.
- **Repeal when:** references stop being bare numbers and become handles bound
  to their referent, so there is nothing left to separate.

_Scar: Scriptorium's selection was offsets with no document, so a document
switch put alpha's words on the chip under beta's name, and in the daemon's copy
that `say` attaches. The kit's tail bookmark `--since N` was a cursor with no
log, so after a daemon restart it skipped the new log's start. Both are fixed
(E66, and `--since N@<epoch>` on `feat/tail-quiet-handoff`). The rule stands,
and the spells whose daemon stamps no epoch still carry the gap._
```

## 4. A wait that wakes by ending must end on every path

**The rule:** a process whose exit is its signal (a background task, a one-shot
wait) must exit on every way the wait can finish. One that doesn't is
indistinguishable from a quiet session.

**Incidents:** the tail handoff's `tail --once` hit this three times, each time
on a path other than the happy one. The one-shot printed its event and stayed
alive because the stream was still open (the feasibility spike). A killed daemon
made it retry forever on stderr. A re-arm at a session that had closed in the
gap waited forever (the verifier's D1). None of the three printed anything
wrong. They just never ended.
[Session](../projects/scriptorium/sessions/2026-09-23-the-tail-hands-off-before-the-cap.md),
[memory](../memories/2026-09-23-a-wait-that-wakes-by-ending-must-end.md).

**Section:** _Honor the exit-code contract_, as a **sharpening**, not a new
rule. That rule already lists how a cantrip ends: `124` for an idle timeout and
`130` for a cancel are the terminal paths of a wait. Its boundary check is empty
(`—`). The proposal fills that check and extends the contract from "which code"
to "that it exits at all", which covers background waits. It needs no new
rule-id. Bump the `honor-exit-code-contract` row's reinforcement date instead.

**Proposed wording** (replaces `- **Boundary check:** —` in that rule):

```markdown
- **Boundary check — a process whose exit IS the signal must exit on every
  path.** A background task or a one-shot wait wakes its caller only by ending,
  and its output means nothing until then. List every way the wait can finish
  (success, the peer closing, the peer dying, the peer never existing, a stop)
  and show that each one exits, with a last line that names the next act. A
  retry-forever loop is a hang to any caller waiting for an end, so give it the
  condition that says "this will not come back". **Test the exit, not the
  output:** a cell that reads the last line passes on a process that prints it
  and hangs.

_Scar: the kit's `tail --once` hung three ways before it shipped: an open stream
after its event, a dead daemon retried forever, and a session closed in the gap.
None printed anything wrong. All three are fixed on `feat/tail-quiet-handoff`,
and the rule stands for every other wait._
```

## Considered and not proposed

- **"Prefer an exact test over a time window"**
  ([memory](../memories/2026-09-22-a-time-window-is-a-guess.md)) and **"an
  observer is late for the event that beats it"**
  ([memory](../memories/2026-09-22-an-observer-is-late-for-the-event-that-beats-it.md)).
  Both incidents are in one seam, Scriptorium's scroll and layout code, and no
  second spell has the problem. The same cycle also shipped a time window that
  is correct: the tail's 60 s margin inside Monitor's cap, correct because the
  thing it guesses about is itself a timer. A flat rule would misfire on that
  case, and its boundary isn't known yet. The observer case is a fact about
  browser frame order, which is a gotcha, not a convention. Both stay memories
  until a second subsystem hits them.
- **"The rule was pinned; the wiring was not"**
  ([memory](../memories/2026-09-22-the-rule-was-pinned-the-wiring-was-not.md)).
  This one does generalise: it happened in branch 4 and in the tail handoff, and
  branch 3's anchor cache has the same shape. But it is a verification practice,
  not spell craft. Its home is `.anthill/principles.md`, which already holds the
  non-author mutation principle this would sharpen. That file is outside this
  item's remit.

## Acceptance Criteria

- [ ] Cole has ruled on each of the four: adopt, adopt with changes, or decline.
- [ ] Each adopted rule is in `grimoire/house-style.md`, with a `rule-id` and a
      `decay-ledger.md` row (or, for proposal 4, a bumped reinforcement date),
      and `bun run gate` passes.
- [ ] If proposal 2 goes to `AGENTS.md` instead, that is recorded here.

## References

- `grimoire/house-style.md`, `grimoire/decay-ledger.md`,
  `grimoire/rule-id.test.ts`, `scripts/instruments/canon-ledger-ward.ts`
- The cycle:
  [Scriptorium from real use](../cycles/2026-09-scriptorium-real-use.md)
