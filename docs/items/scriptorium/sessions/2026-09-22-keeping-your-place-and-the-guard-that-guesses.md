---
type: session
title: "Keeping your place, and the guard that guessed — 2026-09-22"
description:
  Raw, rendered and split now keep the top-visible line, built on one primitive;
  a timer-based sync guard was replaced by an exact one, and two sub-frame holes
  were pinned rather than fixed
tags: [scriptorium, scrolling, split-view, verification]
status: stable
generated: { by: claude-opus-5, at: 2026-09-22 }
---

# Keeping your place, and the guard that guessed — 2026-09-22

Part of
[Scriptorium from real use](../../../cycles/2026-09-scriptorium-real-use.md) —
its second branch. The first is
[the chip and the lines it pointed at](./2026-09-22-the-chip-and-the-lines-it-pointed-at.md).

## What this was

Cole flips constantly: rendered to read, raw to select and edit. A mode switch
dumped him at the top of the document, and in split view the two panes did not
scroll together. Both are in
`docs/backlog/2026-09-22-scriptorium-view-switches-lose-scroll-position.md`,
from his Operator write-up of 2026-09-20.

## Rulings

- **The anchor is the top-visible line, not the selection** — one rule that
  works whether or not anything is selected. Selection-following was offered and
  declined.
- **Compare mode stays out of scope.**
- **"Close" is the bar for split sync**, not pixel-parity.
- Mid-branch, on an inherited defect: **fold it in** rather than land it
  separately.
- On the residual sync hole: **pin it and file it**, rather than spend a round
  on a case that needs injected events to appear.
- On numbers in documents (the one with the widest reach — see below): **ask
  what the number is for before asking whether it is right.**

## What was built

One primitive, `surface/state/place.ts` (DOM-free, with cells): anchors, the
source line at the top of a pane, and the inverse. `renderedRange.lineAnchors`
is the DOM half. `DocumentPane` mints one `Place` per document and hands the
same object to both panes; a mode switch and a split are then literally the same
mechanism, and compare is not a caller.

The backlog item's proposed shape — build the "which source line is at the top"
primitive once, and let both behaviours call it — was **confirmed rather than
falsified**, which is worth recording: the source line is the one currency both
views can name.

## The interesting part: a guard that guessed

The first implementation suppressed reports for a **time window** after driving
a pane, to stop the two panes chasing each other. The verifier broke it twice: a
human scroll inside the window was discarded outright (the panes sat **50 lines
apart, permanently**), and overlapping windows let one expire under another (up
to 12 lines, until the next scroll).

The second implementation's argument is the lesson: **a time window is a guess
about which scroll a report came from**, and both defects are that guess being
wrong. It was replaced by an exact test — a programmatic scroll produces exactly
one scroll event, that event is dispatched before the frame's animation
callbacks (the reviewer checked this against the HTML spec's "update the
rendering" steps rather than taking it on trust), so a report can be told from a
human's by comparing where the pane **is** against where the drive **left** it.
Nothing is suppressed for any duration, so nothing can be lost in a window.

**Two sub-frame holes survive, both pinned and filed**
(`docs/backlog/2026-09-22-scriptorium-a-coalesced-scroll-is-lost-in-one-ordering.md`):
a report arriving before the position is recorded has nothing to compare
against, and a human scroll landing between the drive and that recording is
absorbed into it. Cole ruled them filed rather than fixed: they need injected
events to provoke, real input could not produce worse than three lines, and they
self-heal on the next scroll. The pins assert today's behaviour, name the item,
and were each checked to be capable of failing — a pin that cannot fail is
theatre.

The implementer's first published cause for the second hole was **wrong**, and
it said so plainly when it found out, rather than editing the record quietly: "a
wrong cause sends the next person to the wrong place." It also tried the obvious
fix, found it breaks a different cell, and wrote that into the item's "where to
start".

## The inherited defect, folded in

The verifier found a defect already on `develop` from branch 1: clicking
**inside** the selected text left the chip in place. Chrome _empties_ the
selection rather than collapsing it in that case, and the handler ignored it —
branch 1's own rule breaking in a case nobody had tested. Both readings now
reach the same act. The case that made this delicate: clicking into the chat
composer to write _about_ a passage must **not** clear it, which is why the act
needs to know where the last press landed.

## Review

**Reviewer census** (roster read from the session's available agent types):
`feature-dev:code-reviewer` — `BashOutput` without `Bash`, so it can read shells
it cannot start; **rejected on capability grounds**. `project-docs:gopher-dev`
and `doc-reviewer` — execution-capable, shaped for other work.
**`general-purpose`** (tools `*`) — chosen, fresh, and neither the implementer
nor the verifier.

- **Verifier** (no stake, two rounds) — built its own instrument: a document
  where every line carries a unique marker, with an oracle reading both panes
  from the DOM and locating text in the file, sharing no code with what it
  checked. Found both sync defects, then confirmed the fixes (the 50-line case
  measured at 0–1 line and stable at four seconds, across seven delays from 0 to
  149 ms) and eight hostile constructions all settling within two lines.
- **Reviewer of record** — net diff. Executed `bun run gate` (2611 pass), five
  mutations of the source in scratchpad copies (all five convicted), a probe
  cell that **falsified** the branch's claim that only one ordering was
  affected, spec-checked the ordering premise, and verified the committed bundle
  reproduces byte-for-byte. Verdict: _with fixes_ — and **every blocking item
  was a prose claim, not behaviour.**

## The rule that came out of it, and it is not Scriptorium's

Three numbers in this cycle failed to survive re-measurement: "within one source
line" (from a probe that flattered it), a headline population of 42 against
detail figures out of 37, and an anchor count nobody could verify without
instrumenting our own code.

Cole's rule reorders the question, and it is worth more than the fixes:

> What is the purpose of adding this number? Who is it for? What are they
> actually going to do with it? Is it actionable, or is it just information?

A measurement someone will later compare against — evidence for a design bar, a
threshold a regression check reads — earns its place, and then it carries its
method, its population and its limit. A tally of the moment does not, and the
correct fix for one is to **delete it**, not to reconcile it. Applied here: the
accuracy figures stayed with their purpose stated; "the document has 28
headings" went.

⚠ This reads as a house-style rule rather than a Scriptorium one. It is logged
in E63 with its attribution, and proposing it for `grimoire/house-style.md` —
alongside branch 1's one-state rule — is deliberately left to the cycle's wrap,
not taken here.

## Verification

`bun run gate` on the final tree: **2612 pass, 0 fail**, 196 files, exit 0, tree
clean afterwards (the committed `dist/` reproduces). E63 minted in
`docs/projects/scriptorium/decision-log.md`.

## Known and not built

- Returning to a document does not restore your place; the place dies with the
  document. Pre-existing, and Cole is fine with it.
- A resize invalidates the anchors but does not re-place the pane, so dragging
  the split handle keeps your pixel offset rather than your line. **Cole
  deferred this pending his own use** — he asked for a list of what to exercise
  once the app is open, which is in the hand-off below.
- The guard assumes instant scrolling. `scroll-behavior: smooth` on a scroller
  would emit many events and ratchet the split; there is none today, and the
  assumption is now recorded at `Pane`.

## What to exercise, next time the app is open

1. **Split-handle drag** — split view, scroll to a heading, drag the divider
   wide. The raw pane rewraps, so the top can drift. This is the deferred item;
   the question is whether it is annoying, not whether it happens.
2. **Mode switches at the extremes** — the very top and the very bottom of a
   long document. The bottom cannot land exactly (the follower is already at
   maximum scroll); everything else should.
3. **A long fenced code block** — where rendered and source lengths disagree
   most.
4. **Fast wheel scrolling in split**, both panes, then stop. Settled should mean
   agreed.
