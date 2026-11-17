---
type: session
title: Restore a session 5.2.0 wrote to — 2026-11-17
description:
  6.0.0 now restores a converted session that 5.2.0 then wrote to, converting
  5.2.0's entries one by one, and refuses an unreadable one with how to recover.
tags: [scriptorium, migration, sessions]
status: stable
generated: { by: claude-opus-5-5, at: 2026-11-17 }
---

# Restore a session 5.2.0 wrote to — 2026-11-17

Part of
[Research first, and the bugs that bite](../../../cycles/2026-11-research-and-safety.md).

## Context

A session 6.0.0 converted, that 5.2.0 then wrote to, was refused by 6.0.0 as
"not written by scriptorium": the kit's guard refuses chat with `who`, and the
converter only knew whole 5.2.0 manifests.

## What Happened

An implementer subagent rebuilt the case with the real 5.2.0 release
(`git archive spellbook-v5.2.0`, scratch homes only) and reproduced the exit 6.
The fix converts rather than refuses: `src/scriptorium/backend/kit/convert.ts`
recognises a manifest that is Scriptorium's, has the kit's app slot and ISO
`createdAt`, and holds entries in 5.2.0's shape, and converts those entries one
by one with the readers the first conversion already uses: chat, tasks, versions
(with `nextVersion` recomputed past every version and file on disk), notes,
hidden lists and `ended`. Kit entries pass through unchanged. An entry it can't
read is refused (409) with how to recover, and nothing is written. A manifest
some other tool wrote is still refused by the kit's guard, which was not
touched. A workspace 5.2.0 stored is handled as the first conversion does: the
home folder is not kept.

## Review

Census from the Agent tool's roster: `feature-dev:code-reviewer` rejected (no
Bash); `general-purpose` (`*`) chosen.

It probed detection with a kit manifest carrying every kit field that could look
suspect (not picked up), foreign manifests (still refused) and a second pass
(converts nothing); checked the converter against 5.2.0's own source; re-ran the
real 5.2.0 repro (every entry came through); reverted `convert.ts` and the dist
(the new tests fail); and ran the gate (exit 0). Verdict: ready, with one
optional fix, applied: a task 5.2.0 created reads its status word as a step, as
the first conversion does.

## Follow-up

A second conversion overwrites `manifest.pre-migrate.json` with the mixed
manifest, so the bytes from before the first conversion are lost. The mixed
manifest holds everything they held, and 5.2.0 can still read it, so this was
left. Not filed.

---

**Related Documents:**

- [A converted session that 5.2.0 wrote to is refused by 6.0.0](../item.md)
