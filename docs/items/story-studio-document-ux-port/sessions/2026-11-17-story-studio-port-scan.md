---
type: session
title: Story Studio port scan — 2026-11-17
description:
  Four researchers scanned Story Studio since 2026-10-12; Cole made the calls,
  and 17 items and the scriptorium-inbox feature were filed.
tags: [story-studio, research, scriptorium]
status: stable
generated: { by: claude-opus-5-5, at: 2026-11-17 }
---

# Story Studio port scan — 2026-11-17

Part of
[Research first, and the bugs that bite](../../../cycles/2026-11-research-and-safety.md),
the cycle's first item.

## Context

The question was what Scriptorium should take from Story Studio's document UX
since the 2026-10-12 scan. Cole widened it mid-run: Story Studio had changed
more than its UX (sharded CI, an activity log), and a scan led by the cycles
would only find what he already remembered. So it became a sweep of everything
general-purpose too.

## What Happened

Four read-only researchers ran in parallel: the inbox, versions and notes; the
shell, right column and navigation; chat and the agent's side; and a general
sweep of the git history (CI, tests, the daemon, process). Their findings went
into the write-up as take, take-later and skip calls.

Cole decided the five open questions the same day: the kit split first; the
daemon's records leave chat; autosave with the Ask and Auto modes and
progressive consent as one kit-wide research item, with global settings; the
page key after the split. A subagent filed the takes: 17 items and the
`scriptorium-inbox` feature. Typecheck in the gate and a per-file TMPDIR already
had items, so those got a note instead, and the 1,200-line limit went into
`kit-split-oversized-modules`. Kit-parity message 67 told Story Studio we are
porting their split and which kit fixes we'll pull.

## Notable Discoveries

- Both UX researchers found, independently, that Story Studio's kit is now split
  into small modules while ours is still single files. Every port with a daemon,
  shell or pane half is a rewrite by hand until we split too. That is what moved
  the split ahead of the UX work.
- Story Studio shards CI for memory (one run hit about 9.7 GB on the 2-core
  runner), not for speed.
- A local `curl` with no Origin header can act as the human on any kit daemon.

## Review

Census from the Agent tool's roster of available types:
`feature-dev:code-reviewer` was rejected because it lists BashOutput and
KillShell but not Bash; `general-purpose` (`*`) and `doc-reviewer` ("All tools")
have shell access. `doc-reviewer` was chosen because the branch is documentation
only.

It ran `git diff develop..HEAD`, `pdocs check`, and `git show --stat` on about
25 Story Studio commits, with `wc`, `grep` and `sed` on both repos; it did not
run the test suite. Verdict: ready with fixes. It verified about 25 claims and
found four problems, all fixed before landing: a commit wrongly cited for the
root guards (it was the copy-symlink fix), a link to a testing playbook that
doesn't exist, the write-up's proposed lists contradicting its Decided section
(now marked as overridden), and the activity item not saying icon tabs also wait
on owed notes. The "11 failures" claim it couldn't source is in the
`check-linux` commit's message, now cited.

## Follow-up

- Cole reviews the definitions of done of the 17 items; all are `draft`.
- Not filed, by choice: the interim "hide Save and Revert when clean", failed
  tasks with Dismiss, copying with links following, and `version-new --many`.
  They stay in the write-up as take-later.

---

**Related Documents:**

- [Which of Story Studio's new document UX should Scriptorium take?](../item.md)
- [The write-up](../write-up.md)
