---
type: session
title: A reply clears only its note — 2026-11-17
description:
  A note's waiting mark now clears only on an agent reply about that note, as in
  Story Studio; an answered ask restarts the note's clock instead of showing it
  stuck.
tags: [kit, notes]
status: stable
generated: { by: claude-opus-5-5, at: 2026-11-17 }
---

# A reply clears only its note — 2026-11-17

Part of
[Research first, and the bugs that bite](../../../cycles/2026-11-research-and-safety.md).

## Context

Any agent message newer than a note counted as its answer, so `note-reply n3`
cleared n1's mark too, and a plain `say` cleared every note.

## What Happened

**The rule, a lead call pending Cole:** Story Studio's (`f557c49b`, kit-parity
message 62). A note stops waiting only when, after the human last wrote it, the
agent sent a message about that note (`about.noteId`: a `note-reply`), the note
was resolved, or the agent rewrote or reopened it. A plain `say` clears none.
The item asked for this rule to be decided; Story Studio had decided it, and
keeping parity was the deciding reason. `notesWaiting`
(`src/kit/workspace/waiting.ts`) is the only place it lives; every consumer
reads its output. The SKILL now says to answer a note with `note-reply`.

**The asked note, a second lead call pending Cole.** The review found that a
note the human asked about ("Ask the agent"), answered by a plain `say`, went
straight to "may be stuck" with Ask offered again. Story Studio has no Ask
button, so its rule never met this. Now an answered ask restarts the note's
clock from the answer: the note pulses as waiting, and reads stuck (Ask offered)
only after the usual threshold with still no `note-reply`. It still waits for a
reply or a resolve. Easy to reverse in `waiting.ts` if Cole would rather it read
stuck at once.

## Review

Census from the Agent tool's roster: `feature-dev:code-reviewer` rejected (no
Bash); `general-purpose` (`*`) chosen.

First pass: compared with Story Studio's code (same rule; the only difference is
one chat instead of many), checked the rewritten older tests weren't bent,
probed the asked-note case (found the regression above), reverted `waiting.ts`
(the new tests fail). With fixes. Second pass on the fix: walked the logic
against `askOutstanding`, reverted to the first tip (the new tests fail), and
ran the timing-sensitive UI test 19 times, under heavy synthetic load too, with
no flake (its checks land 3–6 ms after the answer, against a 300 ms threshold).
Ready.

Landing note: dist conflicted with develop's after other branches landed, so the
two source commits were replayed on develop (identical patches, by
`git range-diff`) and dist rebuilt once.

## Follow-up

The CLI's `say` has no flag to name a note, so "a say about the note" exists
only at the protocol level; agents answer notes with `note-reply`. Not filed.

---

**Related Documents:**

- [A reply to one note clears the waiting mark on every note](../item.md)
