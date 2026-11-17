---
type: session
title: Refuse an unpinned write — 2026-11-17
description:
  With several live sessions, a kit write verb without --session is now refused
  with the live choices, and every write reply names its session.
tags: [kit, sessions, cli]
status: stable
generated: { by: claude-opus-5-5, at: 2026-11-17 }
---

# Refuse an unpinned write — 2026-11-17

Part of
[Research first, and the bugs that bite](../../../cycles/2026-11-research-and-safety.md).

## Context

GitHub #137: an agent's `say` without `--session` went to the newest session,
which was another project's, and every reply said `ok`.

## What Happened

An implementer subagent built it in a worktree; the lead reviewed and landed.

- `src/kit/wire/discovery.ts` gained `livePointers`: trusted pointers whose pid
  is alive and whose session has a manifest in this home, newest first. The
  `latest` pointer never counts.
- `src/kit/workspace/verbs.ts` classifies each op. Reads (a `READ_OPS` set, plus
  the `readOps` an app declares) stay lenient. Every other op is a write,
  including any op nobody classified, so a new verb is safe by default. With two
  or more live sessions, a write without `--session` is refused before anything
  is sent: `usage`, exit 2, `token: "ambiguous_session"`, the live ids as
  `choices`, and a hint listing each with its folders. Write replies carry
  `session`.
- Scriptorium declares `meta`, `find` and `move-plan` as reads. Its SKILL says
  to pass `--session` on every write when another session may be running.

`kind` stays `usage`: the error contract's kinds are a closed set, so the
issue's suggested kind went into `token`, which the contract documents for
exactly this. It is the first real `token` in the codebase.

## Review

Census from the Agent tool's roster: `feature-dev:code-reviewer` rejected (no
Bash); `general-purpose` (`*`) chosen, with shell access.

It ran the gate (exit 0, 6,454 pass), the acc and golden CLI tests (139 pass),
and two revert-and-fail checks (refusal disabled; `livePointers` cut to the
newest), each failing 3 of the 5 new tests. It walked every op through `postCmd`
and the server's handlers to confirm the classification. Verdict: ready to
merge. No blocking findings.

## Follow-up

Filed in triage:

- [kit-live-session-pid-reuse](../../kit-live-session-pid-reuse.md): a crashed
  session's pointer whose pid the OS reuses counts as live, so a single-session
  user can be refused. Probe the port before counting.
- [spells-unpinned-writes](../../spells-unpinned-writes.md): magpie, glamour,
  imago, bounty and astrolabe have their own CLIs, which this fix doesn't cover.

Story Studio's kit has its own copy of `verbs.ts`; kit-parity is told.

---

**Related Documents:**

- [Verbs without --session silently write to another live session](../item.md)
