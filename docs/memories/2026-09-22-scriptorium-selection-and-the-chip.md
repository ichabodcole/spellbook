---
type: memory
title:
  "Scriptorium's chip: a forward cursor that never came back, and a flag that
  outlived its passage"
description:
  Rendered-mode selections drifted because one whitespace run moved alignRuns'
  cursor past real text, and the chip kept a second piece of state the selection
  did not — fixed, with the ruling that clearing the chip clears the selection
tags: [scriptorium, selection, co-presence, verification]
status: stable
generated: { by: claude-opus-5, at: 2026-09-22 }
---

# Scriptorium's chip: a forward cursor that never came back, and a flag that outlived its passage

## What happened

Cole's real editing use found that in Scriptorium's **rendered** view, past some
point in a long document, the chat's context chip pointed at a different passage
than the one he highlighted — often the document's last sentence. Raw mode was
always right.

`alignRuns` places each rendered text run by searching `plain` **forward from a
cursor**. A whitespace-only run (`"\n"` between tags) was searched for like any
other, matched a soft line break _inside_ the next paragraph, and moved the
cursor past real text. **The cursor never comes back**, so one bad match
stranded 526 of 987 runs on `house-style.md`. Three further defects sat behind
it: a wrapped list/quote line emitted as one non-exact run; a run's leading
whitespace charged to the run before it (and clamped at offset 0); and a
`dropped` flag in the composer that hid every later selection while the daemon
was never told the passage had gone.

## What to carry forward

- **A forward cursor is only as good as its worst match.** Anything that can
  advance it must be something a wrong match cannot be built from — whitespace
  is now placed only where the cursor already stands, and a match that skips
  text must be confirmed by the next run. A run that cannot be placed returns
  null and moves nothing.
- **One shared fact, one piece of state, mirrored to the daemon.** The chip _is_
  the selection; clearing it clears the selection, in both panes. Cole ruled it
  that way for the UX model — less juggling for the human and the agent alike. A
  second local flag over shared state is the defect, not the feature.
- **An assertion that re-derives its expectation with the code's own arithmetic
  proves nothing.** Both review passes found one. Ask the **source** what is
  there instead.
- **Mutation-test the guard, not just the behaviour.** Deleting `alignRuns`'
  back-off loop — the whole reason a placement is a pair rather than an offset —
  left the suite green until a cell was written for it.
- **The no-stake reader earns its cost.** Each pass found what the previous
  could not see: the author's tests passed while two defects stood, the verifier
  found the offset-0 clamp, the reviewer found the unguarded loop and an inverse
  bug the fix had opened.

Session:
`docs/projects/scriptorium/sessions/2026-09-22-the-chip-and-the-lines-it-pointed-at.md`.
