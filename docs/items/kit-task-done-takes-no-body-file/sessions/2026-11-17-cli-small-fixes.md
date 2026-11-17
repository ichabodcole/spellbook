---
type: session
title: Three small CLI fixes — 2026-11-17
description:
  task-done takes its outcome from a file, a closed stdout pipe exits quietly,
  and a flag before a group's sub-command is named; ported from Image Farm where
  it had them.
tags: [kit, cli]
status: stable
generated: { by: claude-opus-5-5, at: 2026-11-17 }
---

# Three small CLI fixes — 2026-11-17

Part of
[Research first, and the bugs that bite](../../../cycles/2026-11-research-and-safety.md).
One branch for three items, since all touch `verbs.ts` or the CLI registry: this
one, [kit-cli-epipe-stack](../../kit-cli-epipe-stack.md) and
[kit-cli-group-flag-wrong-problem](../../kit-cli-group-flag-wrong-problem.md).
It landed after #137, which changed `verbs.ts` first.

## What Happened

- **#145.** `task-done` takes `--stdin` and `--body-file` through the same
  `readBody` as `task` and `say`; words with either flag are refused, and
  `--failed` works with both. The CLI golden fixtures, the acc census record
  (re-captured from a real `acc probe-plan` run) and the terminator invariant's
  case count were re-recorded, and the SKILL's rule 4 lists `task-done`.
- **EPIPE.** Image Farm's `exitOnBrokenPipe` ported as `src/kit/lib/`, installed
  once per process from `dispatch`. `schema | true` and `version | true` under
  `pipefail` exit 0 with empty stderr.
- **The group flag.** Image Farm's message ported: a flag before a group's
  sub-command is named, with a hint to put the sub-command first. The no-flag
  message is byte-identical.

## Review

Census from the Agent tool's roster: `feature-dev:code-reviewer` rejected (no
Bash); `general-purpose` (`*`) chosen.

The review reverted each fix in turn (its tests failed), re-captured the acc
record to compare, probed empty stdin across verbs, ran a real `tail | head -1`
under `pipefail`, and traced what the new listener cuts short in `tail` (nothing
that matters: the handoff line would go to the closed pipe, and presence ends
with the connection). Bounty's `join` doesn't use the registry, so it is
unaffected. Verdict: with fixes. The one fix: the kit's first `process.exit` was
invisible to the exit-site inventory, which didn't walk `src/kit`. It now does,
with the new exit pinned and a check that an unpinned kit exit fails. A second,
focused review checked that fix. The gate's one failure during review was a
load-related race in `tail-handoff.closed` that passed three times alone.

## Follow-up

Magpie's own EPIPE guard now overlaps the registry's (both exit 0); it could go,
with its inventory row. Not filed. #145 closes on release; kit-parity has the
two Image Farm ports' origin already.

---

**Related Documents:**

- [task-done doesn't take --stdin or --body-file](../item.md)
