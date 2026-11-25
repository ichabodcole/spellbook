---
type: session
title: Grapevine's hints count right and name verbs that run — 2026-11-24
description:
  truncation_hint counts what was cut; every doctor, version and hold hint names
  a runnable verb that does what it says.
tags: [grapevine]
status: stable
generated: { by: claude-opus-5-5, at: 2026-11-24 }
---

# Grapevine's hints count right and name verbs that run — 2026-11-24

A fix alongside [Split the kit](../../../cycles/2026-12-kit-split.md).

## Context

`truncation_hint` reported the whole body's length as if it were the part cut,
and `doctor`'s no-daemon hint named `list`, which never starts a daemon. The
item's third bullet, `tail --last n` counting status frames, was moved at triage
to `grapevine-status-frame-leaks` and is not touched here.

## What Happened

- **The cut count.** Under `--max`, the hint reads
  `+<cut> chars cut (of <len>)`; without it, tail cuts nothing and the hint says
  `<len> chars, long enough to be clipped`. "chars" are UTF-16 code units, the
  same unit the cut uses.
- **Runnable verbs, everywhere.** A module-scope `runnable(v)` renders each verb
  with the CLI's own invocation prefix. `doctor` names `start` with no daemon,
  or `roll` when a hold stands; its version-mismatch and pre-V1.6.2 hints name
  `roll`; the every-verb version warning on stderr names `roll`; roll's refusal
  under a hold no longer says any verb starts the daemon; the reap hints run as
  printed. The first review found the stderr warning and the hold refusal still
  giving the old advice; they were fixed on the branch rather than filed.
- **Size.** Net shrinking, paid for with shorter comments: `cli.ts` 2,282 →
  2,278 by Biome, and the override lowered to match.

## Review

Census from the Agent tool's roster: `feature-dev:code-reviewer` rejected (no
`Bash`); `general-purpose` (`*`) chosen, briefed for this branch.

First review: checked the cut arithmetic (no off-by-one; `--max 0` right),
grepped the repo for every old wording, ran the branch's tests on develop (four
fail), the grapevine suite, the size count and the gate (exit 0). Verdict: with
fixes, the remaining stale hints, all fixed in a45ec05d. Re-review of that
commit: each named verb checked against its command, the tests run on the parent
(two fail, for the right reasons), dist and the override exact, the gate green
on its second run. Verdict: yes. Nits left: the stderr warning doesn't mention
`--force` (roll's own refusal does); `doctor` now deletes an expired hold file
through `holdActive()`, as every other caller does, so its "no destructive
action" comment is off by one file. Untested: roll's refusal under a hold, the
reap hints, and the no-version stderr branch, each needing setup a safe test
shouldn't do.

## Follow-up

Kit UI tests that failed once under load in this cycle's gates are recorded on
[parallel-suite-integration-timeouts](../../parallel-suite-integration-timeouts.md).
