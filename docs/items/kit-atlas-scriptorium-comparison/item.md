---
type: item
title: What still differs from Atlas after the shell port
description:
  After Scriptorium is on the kit's shell, run it beside Atlas, list what still
  differs, and decide each difference.
status: stable
lifecycle: ready
id: 01a13706-9597-7581-b770-897b4bbb4706
kind: research
generated: { by: claude-opus-5-5, at: 2026-10-13 }
tags: [kit, scriptorium, atlas]
parent: feature/workspace-kit
cycle: 2026-10-shell
---

# What still differs from Atlas after the shell port

Part of [Workspace Kit](../../features/workspace-kit/feature.md). It was step 1
of the first cycle, as a side-by-side comparison before the port. Cole agreed
(2026-10-13) to port first and compare what is left instead: the foundation
cycle's primitives already converge on the kit's, and the shell port gives
Scriptorium Atlas's layout by default. So this runs after the shell port, on the
real result rather than a prediction.

Run Atlas (Story Studio) and the ported Scriptorium side by side: the header,
sidebars, status strip and chat, and how each tells a connected session apart
from an agent that is listening. Cole finds Atlas tighter and cleaner in places.
It is a look, not a redesign. **Spellbook keeps its own colour theme** (Cole,
2026-10-13), so the look is at layout, density and behaviour, not at colour.

Before the shell port, its item carries a short list of what Scriptorium does
better and must not lose (for example E53 and E65's waiting marks), so this
check is not the only guard.

**Already noticed (Cole, 2026-10-13, testing the kit-foundation build):**
Scriptorium's side columns collapse all the way, while Story Studio's collapse
to a rail. The shell port should bring the rail for both columns, along with the
chat rail's composer-closed state (`kit-floating-composer`). This check confirms
it arrived.

## Definition of done

- [x] A write-up with screenshots of both apps, area by area, listing each
      remaining difference with a call: keep Atlas's, keep Scriptorium's, or
      take both
- [x] Cole has ruled on each call, and the ones that need work are filed _(Cole
      took every recommendation, 2026-10-20. C6 and C7 joined the shell cycle as
      [kit-composer-closed-waiting-mark](../kit-composer-closed-waiting-mark.md)
      and [kit-stalled-note-ask-act](../kit-stalled-note-ask-act.md); D5 is
      [kit-split-divider](../kit-split-divider.md); the shared finding is
      [waiting-marks-after-session-end](../waiting-marks-after-session-end.md);
      the rest is
      [kit-atlas-comparison-follow-ups](../kit-atlas-comparison-follow-ups.md).)_

## Done and verified

The [write-up](./write-up.md) compares Atlas (Story Studio `develop` at
`c93e8426`, run from a `git archive` copy with scratch homes), the flagged
Scriptorium (`cycle/shell` at `04debecd`, with `kit-broken-links-visible`'s
`b075d47d` and `048b4079` picked in uncommitted) and the shipped Scriptorium, in
one browser at 1440 × 900 on the same seven documents. It makes 34 calls, area
by area; the screenshots are in the session scratchpad. The rails for both
columns and the composer-closed state arrived, but with the composer closed no
waiting mark shows (C6). E53's marks arrived; E65's "Ask the agent" act did not
(C7). The second box is Cole's.
