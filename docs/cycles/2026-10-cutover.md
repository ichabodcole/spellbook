---
type: cycle
title: The cutover
description:
  "Make the kit Scriptorium the default, move the SKILL and acc onto it, and
  delete the shipped Scriptorium after Cole has used the flipped build: the
  second half of the last workspace-stack cycle."
tags: [kit, scriptorium]
status: stable
lifecycle: closed
started: 2026-10-20
appetite:
  Stop when the kit path is Scriptorium's only path, every one of Cole's
  sessions has converted and opens, the SKILL and acc describe the kit's
  contract, and the gate is green; the deletion waits for Cole's go after he has
  used the flipped build.
after: []
generated: { by: claude-opus-5-5, at: 2026-10-20 }
closed: 2026-10-22
---

# The cutover

## Why now

[The shell](2026-10-shell.md) landed on 2026-10-20: the kit Scriptorium runs in
the kit's shell with every shipped behaviour the survey listed, and borrows
nothing from the shipped code. It is still behind `SCRIPTORIUM_KIT=1`. This
cycle makes it the only Scriptorium, which is the last step of the
[port shape](../items/workspace-stack-port-shape/write-up.md#2b-the-cycles).

**The survey of 2026-10-20**, on `develop` at `769b12ec`:

- **Every session converts.** A dry run on a copy of the real home converted and
  restored all 64 sessions, in process and through the launchers, keeping every
  original manifest byte for byte. 60 of the 64 announce a startup check on
  first open (missing files, ghosts, heading links), as the shipped app does. A
  65th session appeared in the real home during the survey, so the dry run is
  re-run on a fresh copy at the end of the cycle.
- **Prefs carry over as ruling 5 of the shell cycle says:** the theme, the view
  mode and the open columns keep their values; pane sizes reset once.
- **The flip is small** (about 120 lines, mostly removals), but it couples to
  acc and the CLI golden: the golden goes red the moment it lands, and acc stays
  green on a census that is now wrong. Both move in the flip's commit.
- **The SKILL** needs a re-vocabulary, and one passage is plainly wrong
  (`activatedBeforeWritten`).
- **The deletion** is about 20.3k lines of source and 10.6k of tests, with every
  ward row that names the shipped code recalibrated.
- **Story Studio's** seven kit commits since `7832083` are its diverging
  paradigm or its own stage work. Nothing is ported.

## Scope

Four things start at once: the flip and three small kit fixes. The SKILL and the
census check follow the flip. Then Cole uses the flipped build, and only after
his go does the deletion run.

**Wave 1, in parallel:**

- **[item/scriptorium-kit-default](../items/scriptorium-kit-default.md)**: the
  flip, with the escape hatch, the census and the golden, as one commit.
- **[item/kit-split-divider](../items/kit-split-divider.md)**: the split view's
  divider, dragged and kept.
- **[item/kit-closed-composer-wait-announced](../items/kit-closed-composer-wait-announced.md)**:
  a wait's change read out while the composer is closed.
- **[item/scriptorium-open-timeout-not-a-number](../items/scriptorium-open-timeout-not-a-number.md)**:
  `--timeout` and `--start-timeout` refuse a value that isn't a number.

**Wave 2, after the flip:**

- **[item/scriptorium-skill-cutover](../items/scriptorium-skill-cutover.md)**:
  the SKILL describes the kit's contract.
- **[item/acc-census-flag-staleness](../items/acc-census-flag-staleness.md)**: a
  census whose flags or output went stale fails the gate.

**Checkpoint: Cole uses the flipped build.** The flip and the SKILL land on
`develop` first, so the agent in that trial reads the right contract. Cole works
on real sessions, findings are filed, and Cole says go.

**Wave 3, after Cole's go:**

- **[item/kit-session-end-dialog-overflow](../items/kit-session-end-dialog-overflow.md)**:
  from the trial; joins beside the deletion (Cole, 2026-10-22).

- **[item/scriptorium-delete-shipped](../items/scriptorium-delete-shipped.md)**:
  the shipped backend and surface deleted, the hatch removed, the wards
  recalibrated.
- **Bookkeeping:** close `scriptorium-idle-search-flood`,
  `scriptorium-mixed-link-line-quadratic` and `scriptorium-cn-semantics` by the
  deletion, and `declare-micromark-gfm` now (it is already satisfied); mark
  selection edges 4 and 7 closed; tick the feature's "existing sessions open
  after migration".

Out of scope, deliberately:

- **The triage items the shell cycle filed** that are no loss against the
  shipped app: waiting marks after End session, the comparison's follow-ups, the
  rendered view's render cost (likely the first thing Cole notices on a large
  document), reveal and CRLF gaps, and a repeated refusal.
- **Session cleanup** and the prefs write race, both inherited.
- **Story Studio's** order, sort and project-folder work: watched, not ported.
- **The release.** `develop` is well past `main`; the release is Cole's.

## Rulings

1. **The trial runs on the real `~/.scriptorium` (Cole, 2026-10-20).** Each
   session converts as it opens. Cole uses Scriptorium for short review sessions
   and rarely returns to an old one once its scope is done, so losing an old
   session's data is not a concern. Not taken: a trial on a copy first.
2. **The escape hatch is refused once any session in the home is in the kit's
   shape,** converted or started on the flipped build (the lead's
   recommendation, taken under ruling 1: Cole is not concerned about old session
   data). Not taken: refusing only once a session has a
   `manifest.pre-migrate.json`.

3. **Go for the deletion (Cole, 2026-10-22,** after his trial of the flipped
   build in Scriptorium session `0ed79abd`): "I think we're ready to do the
   cutover." The trial found no regression. It filed three items for triage: the
   native folder picker in the location dialog, the kit's violet brand colour on
   Scriptorium's warm themes, and the right-click menu with no selection.

## Outcome

**What shipped:**

- **The kit Scriptorium is Scriptorium.** The flip landed first as one
  revertable commit. Shipped sessions convert the first time they are restored,
  and the original manifest is kept. Theme, view mode and open columns carry
  over; pane sizes reset once. Dry runs on copies of the real home converted all
  65 sessions. Cole used the flipped build on his real sessions on 2026-10-22
  and found no regression.
- **The shipped Scriptorium is deleted:** about 20.4k lines of source and 10.8k
  of tests, with the escape hatch. The command line's output is identical before
  and after, verb by verb. Every ward that named the shipped code was
  recalibrated with its reason.
- **The SKILL describes the kit's contract.** Three no-stake passes ran it
  against the build, two of them with cold-reading agents.
- **acc can't go stale quietly.** The house ward fails a census whose verbs,
  flags or output no longer match the CLI, for every spell.
- **From the triage pile and the trial:** the split view's divider, a wait
  announced while the composer is closed, `--timeout` refusing a non-number, and
  the End session dialog fitting long paths and short windows.

**What was cut, or changed scope:**

- **The SKILL's cold reads found a contract bug, not just wording.** A bare
  `tail` waited forever after the human ended the newest session. The first fix
  regressed: a tail armed beside a fresh `open` stopped on the old session. The
  final shape waits through `open`'s default start window before it stops.
- **Left for triage:** five findings from Cole's trial (the native folder
  picker, the kit's violet on the warm themes, the right-click menu with no
  selection, session identity, and the dialog overflow, which joined), and the
  ward blind spots the deletion's verifier found.

**What was learned:**

- **A cold reader finds what a schema check can't.** Every verb in the SKILL
  existed, and the SKILL was still wrong about which document a note's ask
  names, and about how a tail ends.
- **A newest-session rule races with a daemon that is still starting.** Any "the
  newest one has ended" decision needs a window, or a marker written before the
  spawn.
- **The trial was worth waiting for.** It found no regression, but it found what
  the port had lost without anyone noticing: the workspace path had told Cole
  which project a session belonged to.

## Sessions

- cycle/cutover (first landing 2026-10-20: the flip, the SKILL and the small
  items; the deletion follows Cole's trial)
