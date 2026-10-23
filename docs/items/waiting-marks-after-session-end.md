---
type: item
title: Waiting marks still say may be stuck after End session
description:
  After the human ends a session, its waiting marks still read may be stuck, in
  both the shipped and the kit Scriptorium, though nothing can answer any more.
status: stable
lifecycle: ready
id: 01a157b8-bbe1-751b-a8f4-cf55657df90c
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-19 }
tags: [kit, scriptorium]
parent: feature/workspace-kit-follow-ups
from: cycle/2026-10-shell
cycle: 2026-10-polish
---

# Waiting marks still say may be stuck after End session

Seen by the Atlas comparison on 2026-10-20 in both the shipped Scriptorium and
the kit path: after End session, the waiting marks on messages and notes still
read "may be stuck". The `kit-composer-closed-waiting-mark` verifier
(2026-10-20) found the worse case on the kit path: with an agent `tail` running
at the end, the rail dot and the float's line keep pulsing "working on this…"
after the session ended. Once the session has ended nothing can answer, so the
mark should say the session ended instead.

## Definition of done

- [x] After End session, no waiting mark claims work or a stuck agent: not the
      message badge, the note badge, the float's line, or the closed composer's
      rail dot. Each says the session has ended, or goes.
- [x] Tested on the kit path.

## Done and verified

`2eb91593` (on `impl/kit-shell-robustness`). Once the session has ended, every
wait reads a fourth badge, `ended`: a still, faint dot, and words that say the
session ended before an answer came (`ENDED_LABEL`, one wording each for a
message, a note and a note asked about). The marks stay rather than go, so the
human still sees what was left unanswered. `badgeFor`, `owedSummary` and
`waitingOnAgent` take the ended session as one more input, read from
`daemon.connection === "ended"`, and every place that draws a wait passes it:
the message badge, the Chat tab's dot, the Notes tab's dot, a note's badge, the
panel's pointer to notes on other documents, the float's two lines, the rail's
dot and its live region, and the note menu on the passage. "Ask the agent" is
not offered on an ended note, since it is offered only on a stuck one.

Tested over a real daemon: the rail, the float's line, the message badge and the
Chat tab after End session with an agent tail still open
(`WorkspaceShell.railWaiting.test.tsx`), a stuck note's badge, the Notes tab and
the float's note row (`WorkspaceShell.noteWaiting.test.tsx`), and the rule in
`rail.test.ts`; the note menu on the passage in the rendered view
(`DocumentPane.test.tsx`; an ended session's raw view is read-only and offers no
menu), and the ended badge's faint colour and three wordings (`chat.test.tsx`).
In a real browser (Scriptorium on a scratch home), the rail kept pulsing
"working" after End session before the fix, and after it the rail, the float's
line and the column all say "the session ended before an answer came", with
nothing pulsing.

## Port-back notes

- `chat/WaitingBadge.tsx`: `BadgeKind` gains `"ended"`, with `ENDED_LABEL`;
  `badgeFor(waiting, agentListening, ended = false)` returns it over everything.
  `ended` draws like `unheard` (faint, no pulse).
- `chat/noteWaiting.ts`: `owedSummary(…, ended = false)`; `shell/rail.ts`:
  `waitingOnAgent(…, ended = false)`.
- `ChatSidebar`, `FloatingComposer` and `NotesPanel` take an optional
  `sessionEnded` prop (default false); the shell passes
  `daemon.connection === "ended"`, and `DocumentPane` reads it for the note
  menu. All additions are optional, so existing callers are unchanged.
- **The words are Scriptorium's.** `ENDED_LABEL` says "the session ended…",
  where Story Studio says "The project is closed" / "Project closed". Porting
  needs either an app override or neutral words. No label slot was added: the
  labels are module constants read by six components, so a slot would mean
  threading one more prop or a context through all of them, which is more than
  this item's size. Story Studio can replace `ENDED_LABEL`'s three strings, or
  the kit can grow a labels context when a second app needs it.
